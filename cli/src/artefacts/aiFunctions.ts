import type createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import type {
  AiFunctionFile,
  AiFunctionReference,
  AiVariableReference,
} from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import {
  getSrcPath,
  isInArtefactDirectory,
  isInNamedDirectory,
  readJsonFile,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import {
  chalk,
  createHeader,
  createLogger,
  warningColor,
} from '../utils/logger';
import {
  getRequiredNamespaces,
  matchesAnyRequiredNamespace,
  validateNamespace,
} from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { canonicalizeComparisonValue } from '../utils/payloadComparison';
import { AiFunctionArtifactSchema } from '../utils/schemas';
import { validateAiFunctionArtifact } from '../utils/validation';
import { getReferenceableFunctions } from './references';
import { getExistingVariables } from './variables';

type PolyApiClient = ReturnType<typeof createClient<paths>>;
type ApiResult = {
  data?: unknown;
  error?: unknown;
  response?: Response;
};
type AiApiClient = {
  GET(path: string, options?: Record<string, unknown>): Promise<ApiResult>;
  POST(path: string, options: Record<string, unknown>): Promise<ApiResult>;
  PATCH(path: string, options: Record<string, unknown>): Promise<ApiResult>;
  DELETE(path: string, options: Record<string, unknown>): Promise<ApiResult>;
};
type AiFunctionRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  context?: string;
};
type ResolvableFunction = AiFunctionReference & { id: string };
type ResolvableVariable = AiVariableReference & { id: string };
type SyncResult = 'created' | 'updated' | 'noop' | 'failed';

const log = createLogger('ai-functions');
const CREATE_ONLY_FIELDS = new Set(['context', 'provider']);

function getAiClient(client: PolyApiClient): AiApiClient {
  return client as unknown as AiApiClient;
}

export function findAiFunctionFiles(
  options: WalkDirOptions = {}
): AiFunctionFile[] {
  const files: AiFunctionFile[] = [];

  walkDir(
    getSrcPath(),
    (fullPath, fileName) => {
      if (
        fileName.endsWith('.json') &&
        !fileName.endsWith('.test.json') &&
        isInNamedDirectory(fullPath, 'ai-functions') &&
        isInArtefactDirectory(fullPath)
      ) {
        const content = readJsonFile(fullPath, {
          schema: AiFunctionArtifactSchema,
        });
        if (content) {
          files.push({ filePath: fullPath, fileName, content });
        }
      }
    },
    options
  );

  return files;
}

function normalizeListResponse(data: unknown): AiFunctionRecord[] {
  if (Array.isArray(data)) {
    return data as AiFunctionRecord[];
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as Record<string, unknown>;
  for (const key of ['results', 'items', 'functions', 'data']) {
    if (Array.isArray(record[key])) {
      return record[key] as AiFunctionRecord[];
    }
  }

  if (record.data && typeof record.data === 'object') {
    return normalizeListResponse(record.data);
  }

  return [];
}

export async function getExistingAiFunctions(
  client: PolyApiClient
): Promise<AiFunctionRecord[]> {
  try {
    const { data, error, response } = await getAiClient(client).GET(
      '/functions/ai',
      {}
    );
    if (error || !data) {
      log.warn(
        { error, status: response?.status },
        'Failed to fetch AI functions from API'
      );
      return [];
    }

    return normalizeListResponse(data);
  } catch (error) {
    log.warn({ error }, 'Failed to fetch AI functions from API');
    return [];
  }
}

async function getAiFunctionDetails(
  client: PolyApiClient,
  id: string
): Promise<AiFunctionRecord | null> {
  try {
    const { data, error, response } = await getAiClient(client).GET(
      '/functions/ai/{id}',
      { params: { path: { id } } }
    );
    if (error || !data || typeof data !== 'object') {
      log.warn(
        { id, error, status: response?.status },
        'Failed to fetch AI function details'
      );
      return null;
    }

    const record = data as AiFunctionRecord;
    for (const key of ['data', 'result', 'function']) {
      const nested = record[key];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        return nested as AiFunctionRecord;
      }
    }
    return record;
  } catch (error) {
    log.warn({ error, id }, 'Failed to fetch AI function details');
    return null;
  }
}

function findFunction(
  reference: AiFunctionReference,
  functions: ResolvableFunction[],
  aiFunction: AiFunctionFile
): ResolvableFunction | null {
  const matches = functions.filter(
    item =>
      item.functionName === reference.functionName &&
      item.functionContext === reference.functionContext
  );

  if (matches.length === 1) {
    return matches[0];
  }

  log.error(
    {
      aiFunction: aiFunction.content.name,
      functionName: reference.functionName,
      functionContext: reference.functionContext,
      matches: matches.length,
    },
    matches.length === 0
      ? 'Tool function not found for AI function'
      : 'Tool function reference is ambiguous across accessible functions'
  );
  return null;
}

function findVariable(
  reference: AiVariableReference,
  variables: ResolvableVariable[],
  aiFunction: AiFunctionFile
): ResolvableVariable | null {
  const variable = variables.find(
    item =>
      item.variableName === reference.variableName &&
      item.variableContext === reference.variableContext
  );

  if (!variable) {
    log.error(
      {
        aiFunction: aiFunction.content.name,
        variableName: reference.variableName,
        variableContext: reference.variableContext,
      },
      'Variable not found for AI function'
    );
    return null;
  }

  return variable;
}

export function resolveAiFunctionPayload(
  aiFunction: AiFunctionFile,
  functions: ResolvableFunction[],
  variables: ResolvableVariable[]
): Record<string, unknown> | null {
  const { systemPromptVariable, toolFunctions, ...content } =
    aiFunction.content;
  const payload: Record<string, unknown> = { ...content };

  if (systemPromptVariable) {
    const variable = findVariable(systemPromptVariable, variables, aiFunction);
    if (!variable) {
      return null;
    }
    payload.systemPromptVariableId = variable.id;
  }

  if (toolFunctions !== undefined) {
    const resolvedToolFunctions: Record<string, unknown>[] = [];

    for (const toolFunction of toolFunctions) {
      const func = findFunction(toolFunction, functions, aiFunction);
      if (!func) {
        return null;
      }

      const resolvedTool: Record<string, unknown> = { id: func.id };
      if (toolFunction.argumentConfig !== undefined) {
        const resolvedArguments: Record<string, unknown>[] = [];
        for (const config of toolFunction.argumentConfig) {
          if (config.source !== 'variable') {
            resolvedArguments.push({ ...config });
            continue;
          }

          const { variableName, variableContext, ...argument } = config;
          if (!variableName || !variableContext) {
            log.error(
              { aiFunction: aiFunction.content.name, argumentKey: config.key },
              'Variable tool argument requires variableName and variableContext'
            );
            return null;
          }

          const variable = findVariable(
            { variableName, variableContext },
            variables,
            aiFunction
          );
          if (!variable) {
            return null;
          }
          resolvedArguments.push({ ...argument, variableId: variable.id });
        }
        resolvedTool.argumentConfig = resolvedArguments;
      }

      resolvedToolFunctions.push(resolvedTool);
    }

    payload.toolFunctions = resolvedToolFunctions;
  }

  return payload;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalizeComparisonValue(left)) ===
    JSON.stringify(canonicalizeComparisonValue(right))
  );
}

function projectRemoteValue(local: unknown, remote: unknown): unknown {
  if (Array.isArray(local)) {
    if (!Array.isArray(remote)) {
      return remote;
    }
    return local.map((item, index) => projectRemoteValue(item, remote[index]));
  }

  if (local && typeof local === 'object') {
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
      return remote;
    }
    return Object.fromEntries(
      Object.entries(local as Record<string, unknown>).map(([key, value]) => [
        key,
        projectRemoteValue(value, (remote as Record<string, unknown>)[key]),
      ])
    );
  }

  return remote;
}

export function buildAiFunctionUpdatePayload(
  localPayload: Record<string, unknown>,
  remote: AiFunctionRecord
): { payload: Record<string, unknown>; immutableChanges: string[] } {
  const payload: Record<string, unknown> = {};
  const immutableChanges: string[] = [];

  for (const [key, localValue] of Object.entries(localPayload)) {
    if (valuesEqual(localValue, projectRemoteValue(localValue, remote[key]))) {
      continue;
    }

    if (CREATE_ONLY_FIELDS.has(key)) {
      immutableChanges.push(key);
      continue;
    }

    payload[key] = localValue;
  }

  return { payload, immutableChanges };
}

async function deleteAiFunction(
  client: PolyApiClient,
  aiFunction: AiFunctionRecord
): Promise<boolean> {
  if (!aiFunction.id) {
    log.error({ aiFunction }, 'Cannot delete AI function without an ID');
    return false;
  }

  try {
    const { error, response } = await getAiClient(client).DELETE(
      '/functions/ai/{id}',
      {
        params: { path: { id: aiFunction.id } },
        headers: await getDeleteHeaders(),
      }
    );
    if (error) {
      log.error(
        {
          name: aiFunction.name,
          context: aiFunction.context,
          status: response?.status,
          error,
        },
        'Failed to delete AI function'
      );
      return false;
    }

    return true;
  } catch (error) {
    log.error({ error, name: aiFunction.name }, 'Error deleting AI function');
    return false;
  }
}

async function syncAiFunction(
  client: PolyApiClient,
  aiFunction: AiFunctionFile,
  existing: AiFunctionRecord[],
  functions: ResolvableFunction[],
  variables: ResolvableVariable[],
  dryRun: boolean
): Promise<SyncResult> {
  const payload = resolveAiFunctionPayload(aiFunction, functions, variables);
  if (!payload) {
    return 'failed';
  }

  const remoteListItem = existing.find(
    item =>
      item.name === aiFunction.content.name &&
      item.context === aiFunction.content.context
  );

  if (!remoteListItem) {
    if (dryRun) {
      return 'created';
    }

    if (
      !validateEndpointPayload('CreateAiFunctionV2Dto', payload, {
        artifactType: 'AI Function',
        artifactName: aiFunction.content.name,
        filePath: aiFunction.filePath,
      })
    ) {
      return 'failed';
    }

    try {
      const { error, response } = await getAiClient(client).POST(
        '/functions/ai',
        { body: payload }
      );
      if (error) {
        log.error(
          {
            name: aiFunction.content.name,
            context: aiFunction.content.context,
            status: response?.status,
            error,
          },
          'Failed to create AI function'
        );
        return 'failed';
      }
      return 'created';
    } catch (error) {
      log.error({ error }, 'Error creating AI function');
      return 'failed';
    }
  }

  if (!remoteListItem.id) {
    log.error(
      { name: remoteListItem.name, context: remoteListItem.context },
      'Existing AI function has no ID'
    );
    return 'failed';
  }

  const remote = await getAiFunctionDetails(client, remoteListItem.id);
  if (!remote) {
    return 'failed';
  }
  const update = buildAiFunctionUpdatePayload(payload, remote);
  if (update.immutableChanges.length > 0) {
    log.error(
      {
        name: aiFunction.content.name,
        fields: update.immutableChanges,
      },
      'AI function has changed create-only fields; delete and recreate it explicitly'
    );
    return 'failed';
  }

  if (Object.keys(update.payload).length === 0) {
    return 'noop';
  }

  const patchPayload = update.payload;

  if (dryRun) {
    return 'updated';
  }

  if (
    !validateEndpointPayload('UpdateAiFunctionV2Dto', patchPayload, {
      artifactType: 'AI Function',
      artifactName: aiFunction.content.name,
      filePath: aiFunction.filePath,
    })
  ) {
    return 'failed';
  }

  try {
    const { error, response } = await getAiClient(client).PATCH(
      '/functions/ai/{id}',
      {
        params: { path: { id: remoteListItem.id } },
        body: patchPayload,
      }
    );
    if (error) {
      log.error(
        {
          name: aiFunction.content.name,
          context: aiFunction.content.context,
          status: response?.status,
          error,
        },
        'Failed to update AI function'
      );
      return 'failed';
    }
    return 'updated';
  } catch (error) {
    log.error({ error }, 'Error updating AI function');
    return 'failed';
  }
}

function toResolvableFunctions(items: any[]): ResolvableFunction[] {
  return items.flatMap(item =>
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.context === 'string'
      ? [
          {
            id: item.id,
            functionName: item.name,
            functionContext: item.context,
          },
        ]
      : []
  );
}

function toResolvableVariables(items: any[]): ResolvableVariable[] {
  return items.flatMap(item =>
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.context === 'string'
      ? [
          {
            id: item.id,
            variableName: item.name,
            variableContext: item.context,
          },
        ]
      : []
  );
}

export async function syncAiFunctions(
  client: PolyApiClient,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: WalkDirOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const files = findAiFunctionFiles(options.discoveryOptions);
  const allFiles = findAiFunctionFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });

  log.info(chalk.cyan(createHeader('AI FUNCTIONS')));
  if (files.length === 0) {
    log.info(
      chalk.gray(
        'No AI function files found in src/**/artefacts/ai-functions/ (legacy src/**/artifacts/ai-functions/ is also supported)'
      )
    );
    return;
  }

  log.info(chalk.gray(`Found ${files.length} local AI function file(s)`));
  const namespaces = getRequiredNamespaces();
  const existing = (await getExistingAiFunctions(client)).filter(item =>
    matchesAnyRequiredNamespace(item.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${existing.length} AI function(s) from API in namespace(s) "${namespaces.join(', ')}"`
    )
  );

  if (options.detectOrphans === false) {
    log.info(
      chalk.gray('Skipping orphan detection for scoped AI function sync')
    );
  } else {
    const localKeys = new Set(
      allFiles.map(file => `${file.content.name}:${file.content.context}`)
    );
    const candidates = existing.filter(
      item => !localKeys.has(`${item.name}:${item.context}`)
    );
    const { included, excluded } = filterOrphansByContext(candidates);

    if (excluded.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excluded.length} AI function orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (included.length > 0 && deleteOrphans) {
      log.info(
        warningColor(
          `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${included.length} AI function(s) not in local files...`
        )
      );
      for (const item of included) {
        if (options.dryRun) {
          log.info(
            chalk.blue(`    [PLAN] Delete ${item.name} (${item.context})`)
          );
          summary.planned++;
        } else if (await deleteAiFunction(client, item)) {
          summary.deleted++;
        } else {
          summary.failed++;
        }
        await sleep(300);
      }
    } else if (included.length > 0) {
      log.info(
        chalk.gray(
          `Found ${included.length} orphaned AI function(s) (skipping deletion)`
        )
      );
      for (const item of included) {
        if (item.id && item.name) {
          orphans.push({
            type: 'ai-function',
            name: item.name,
            context: item.context ?? '',
            id: item.id,
          });
        }
      }
    }
  }

  const [referenceableFunctions, apiVariables] = await Promise.all([
    getReferenceableFunctions(client),
    getExistingVariables(client),
  ]);
  const functions = toResolvableFunctions(referenceableFunctions);
  const variables = toResolvableVariables(
    apiVariables.filter(variable =>
      matchesAnyRequiredNamespace(variable.context)
    )
  );
  log.info(
    chalk.gray(
      `Resolved ${functions.length} accessible tool function(s) and ${variables.length} variable(s) in namespace(s) "${namespaces.join(', ')}"`
    )
  );

  log.info(chalk.blue('Comparing local AI function payloads with API...'));
  for (const file of files) {
    const { name, context } = file.content;
    log.info(chalk.dim(`  → ${name} (${context})`));

    if (!validateAiFunctionArtifact(file.content, file.filePath, skipInvalid)) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    try {
      validateNamespace(context, 'AI Function', name);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'Namespace validation failed'
      );
      log.info(chalk.red('    [FAIL] Failed (namespace)'));
      summary.failed++;
      continue;
    }

    const result = await syncAiFunction(
      client,
      file,
      existing,
      functions,
      variables,
      options.dryRun ?? false
    );
    if (result === 'created') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Create'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Created'));
        summary.created++;
      }
    } else if (result === 'updated') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Update'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Updated'));
        summary.updated++;
      }
    } else if (result === 'noop') {
      log.info(chalk.gray('    [SKIP] Unchanged'));
      summary.skipped++;
    } else {
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
    }

    await sleep(500);
  }
}
