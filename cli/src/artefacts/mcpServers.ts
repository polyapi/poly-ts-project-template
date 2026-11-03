import type createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import type {
  AiFunctionReference,
  AiVariableReference,
  McpServerFile,
} from '../types';
import type { ArtifactSummary } from '../types/summary';
import { sleep } from '../utils/apiClient';
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
} from '../utils/namespace';
import { buildChangedFieldsPayload } from '../utils/payloadComparison';
import { validateMcpServerArtifact } from '../utils/validation';
import { getReferenceableFunctions } from './references';
import { getExistingVariables } from './variables';

type PolyApiClient = ReturnType<typeof createClient<paths>>;
type ApiResult = {
  data?: unknown;
  error?: unknown;
  response?: Response;
};
type McpApiClient = {
  GET(path: string, options?: Record<string, unknown>): Promise<ApiResult>;
  POST(path: string, options: Record<string, unknown>): Promise<ApiResult>;
  PATCH(path: string, options: Record<string, unknown>): Promise<ApiResult>;
};
export type McpServerRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  environmentId?: string;
  mcpUrl?: string;
};
type ResolvableFunction = AiFunctionReference & { id: string };
type ResolvableVariable = AiVariableReference & { id: string };
export type McpServerPlan =
  | { action: 'create'; payload: Record<string, unknown> }
  | {
      action: 'update';
      id: string;
      payload: Record<string, unknown>;
      remote: McpServerRecord;
    }
  | { action: 'noop'; remote: McpServerRecord }
  | { action: 'failed'; reason: string };

const log = createLogger('mcp-servers');

function getMcpClient(client: PolyApiClient): McpApiClient {
  return client as unknown as McpApiClient;
}

export function findMcpServerFiles(
  options: WalkDirOptions = {}
): McpServerFile[] {
  const files: McpServerFile[] = [];

  walkDir(
    getSrcPath(),
    (fullPath, fileName) => {
      if (
        fileName.endsWith('.json') &&
        !fileName.endsWith('.test.json') &&
        isInNamedDirectory(fullPath, 'mcp-servers') &&
        isInArtefactDirectory(fullPath)
      ) {
        const content = readJsonFile(fullPath);
        if (content) {
          files.push({ filePath: fullPath, fileName, content });
        }
      }
    },
    options
  );

  return files;
}

function normalizeListResponse(data: unknown): McpServerRecord[] {
  if (Array.isArray(data)) {
    return data as McpServerRecord[];
  }
  if (!data || typeof data !== 'object') {
    return [];
  }
  const record = data as Record<string, unknown>;
  for (const key of ['results', 'items', 'data']) {
    if (Array.isArray(record[key])) {
      return record[key] as McpServerRecord[];
    }
  }
  return [];
}

/** Fetch MCP servers, keeping only those in the verified target environment. */
export async function getExistingMcpServers(
  client: PolyApiClient,
  environmentId?: string
): Promise<McpServerRecord[] | null> {
  try {
    const { data, error, response } = await getMcpClient(client).GET(
      '/mcp-servers',
      {}
    );
    if (error || !data) {
      log.error(
        { error, status: response?.status },
        'Failed to fetch MCP servers from API'
      );
      return null;
    }
    return normalizeListResponse(data).filter(
      item =>
        !environmentId ||
        typeof item.environmentId !== 'string' ||
        item.environmentId === environmentId
    );
  } catch (error) {
    log.error({ error }, 'Failed to fetch MCP servers from API');
    return null;
  }
}

function findFunction(
  reference: AiFunctionReference,
  functions: ResolvableFunction[]
): ResolvableFunction | string {
  const matches = functions.filter(
    item =>
      item.functionName === reference.functionName &&
      item.functionContext === reference.functionContext
  );
  if (matches.length === 1) {
    return matches[0];
  }
  return matches.length === 0
    ? `Tool function ${reference.functionContext}.${reference.functionName} was not found`
    : `Tool function ${reference.functionContext}.${reference.functionName} is ambiguous across accessible functions`;
}

function findVariable(
  reference: AiVariableReference,
  variables: ResolvableVariable[]
): ResolvableVariable | string {
  const variable = variables.find(
    item =>
      item.variableName === reference.variableName &&
      item.variableContext === reference.variableContext
  );
  return (
    variable ??
    `Variable ${reference.variableContext}.${reference.variableName} was not found in the project namespace`
  );
}

/**
 * Replace portable tool and OAuth-secret references with the IDs the API
 * expects. Returns a reason string when any reference cannot be resolved.
 */
export function resolveMcpServerPayload(
  server: McpServerFile,
  functions: ResolvableFunction[],
  variables: ResolvableVariable[]
): Record<string, unknown> | string {
  const { toolFunctions, oauthClientSecretVariable, ...content } =
    server.content;
  const payload: Record<string, unknown> = { ...content };

  if (oauthClientSecretVariable === null) {
    payload.oauthClientSecretVariableId = null;
  } else if (oauthClientSecretVariable) {
    const variable = findVariable(oauthClientSecretVariable, variables);
    if (typeof variable === 'string') {
      return variable;
    }
    payload.oauthClientSecretVariableId = variable.id;
  }

  if (toolFunctions !== undefined) {
    const resolvedTools: Record<string, unknown>[] = [];
    for (const tool of toolFunctions) {
      const func = findFunction(tool, functions);
      if (typeof func === 'string') {
        return func;
      }
      const resolvedTool: Record<string, unknown> = { id: func.id };
      if (tool.argumentConfig !== undefined) {
        const resolvedArguments: Record<string, unknown>[] = [];
        for (const config of tool.argumentConfig) {
          if (config.source !== 'variable') {
            resolvedArguments.push({ ...config });
            continue;
          }
          const { variableName, variableContext, ...argument } = config;
          if (!variableName || !variableContext) {
            return `Variable argument ${config.key} requires variableName and variableContext`;
          }
          const variable = findVariable(
            { variableName, variableContext },
            variables
          );
          if (typeof variable === 'string') {
            return variable;
          }
          resolvedArguments.push({ ...argument, variableId: variable.id });
        }
        resolvedTool.argumentConfig = resolvedArguments;
      }
      resolvedTools.push(resolvedTool);
    }
    payload.toolFunctions = resolvedTools;
  }

  return payload;
}

/** Decide how one local MCP server artefact maps onto the target environment. */
export function planMcpServer(
  server: McpServerFile,
  existing: McpServerRecord[],
  functions: ResolvableFunction[],
  variables: ResolvableVariable[]
): McpServerPlan {
  const payload = resolveMcpServerPayload(server, functions, variables);
  if (typeof payload === 'string') {
    return { action: 'failed', reason: payload };
  }

  const matches = existing.filter(item => item.name === server.content.name);
  if (matches.length === 0) {
    return { action: 'create', payload };
  }
  if (matches.length > 1) {
    return {
      action: 'failed',
      reason: `${matches.length} MCP servers named "${server.content.name}" exist in the target environment; rename or remove the duplicates before syncing`,
    };
  }

  const remote = matches[0];
  if (typeof remote.id !== 'string' || !remote.id) {
    return { action: 'failed', reason: 'Existing MCP server has no ID' };
  }
  const update = buildChangedFieldsPayload(payload, remote);
  if (Object.keys(update.payload).length === 0) {
    return { action: 'noop', remote };
  }
  return { action: 'update', id: remote.id, payload: update.payload, remote };
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

function logMcpUrl(record: unknown): void {
  const url = (record as McpServerRecord | undefined)?.mcpUrl;
  if (typeof url === 'string' && url) {
    log.info(chalk.gray(`    MCP URL: ${url}`));
  }
}

async function writeMcpServer(
  client: PolyApiClient,
  server: McpServerFile,
  plan: Extract<McpServerPlan, { action: 'create' | 'update' }>
): Promise<boolean> {
  const isCreate = plan.action === 'create';
  if (
    !validateEndpointPayload(
      isCreate ? 'CreateMCPServerDto' : 'UpdateMCPServerDto',
      plan.payload,
      {
        artifactType: 'MCP Server',
        artifactName: server.content.name,
        filePath: server.filePath,
      }
    )
  ) {
    return false;
  }

  try {
    const { data, error, response } = isCreate
      ? await getMcpClient(client).POST('/mcp-servers', { body: plan.payload })
      : await getMcpClient(client).PATCH('/mcp-servers/{id}', {
          params: { path: { id: plan.id } },
          body: plan.payload,
        });
    if (error) {
      log.error(
        { name: server.content.name, status: response?.status, error },
        `Failed to ${isCreate ? 'create' : 'update'} MCP server`
      );
      return false;
    }
    logMcpUrl(data);
    return true;
  } catch (error) {
    log.error(
      { error, name: server.content.name },
      `Error ${isCreate ? 'creating' : 'updating'} MCP server`
    );
    return false;
  }
}

/**
 * Create or update local MCP server artefacts. MCP servers carry no namespace
 * context, so Flow never reports or deletes remote servers as orphans: it
 * cannot tell which servers in the environment belong to this project.
 */
export async function syncMcpServers(
  client: PolyApiClient,
  summary: ArtifactSummary,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    discoveryOptions?: WalkDirOptions;
    environmentId?: string;
  } = {}
): Promise<void> {
  const files = findMcpServerFiles(options.discoveryOptions);

  log.info(chalk.cyan(createHeader('MCP SERVERS')));
  if (files.length === 0) {
    log.info(
      chalk.gray(
        'No MCP server files found in src/**/artefacts/mcp-servers/ (legacy src/**/artifacts/mcp-servers/ is also supported)'
      )
    );
    return;
  }
  log.info(chalk.gray(`Found ${files.length} local MCP server file(s)`));

  const existing = await getExistingMcpServers(client, options.environmentId);
  if (!existing) {
    summary.failed += files.length;
    return;
  }
  log.info(
    chalk.gray(
      `Fetched ${existing.length} MCP server(s) from the target environment`
    )
  );
  log.info(
    chalk.gray(
      'MCP servers have no namespace context: Flow matches them by exact name and never reports or deletes remote MCP servers as orphans'
    )
  );

  const namespaces = getRequiredNamespaces();
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

  const nameCounts = new Map<string, number>();
  for (const file of files) {
    const name = file.content?.name;
    if (typeof name === 'string') {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
  }

  log.info(chalk.blue('Comparing local MCP server payloads with API...'));
  for (const file of files) {
    const name = file.content?.name ?? file.fileName;
    log.info(chalk.dim(`  → ${name}`));

    if (!validateMcpServerArtifact(file.content, file.filePath, skipInvalid)) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }
    if ((nameCounts.get(file.content.name) ?? 0) > 1) {
      log.error(
        { name: file.content.name },
        'Several local MCP server artefacts use this name; each needs a unique name in the target environment'
      );
      log.info(chalk.red('    [FAIL] Duplicate local name'));
      summary.failed++;
      continue;
    }
    if (file.content.isPublic === true) {
      log.info(
        warningColor(
          '    [WARN] isPublic is true; confirm this MCP server is meant to be publicly reachable'
        )
      );
    }

    const plan = planMcpServer(file, existing, functions, variables);
    if (plan.action === 'failed') {
      log.error({ name: file.content.name }, plan.reason);
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
      continue;
    }
    if (plan.action === 'noop') {
      log.info(chalk.gray('    [SKIP] Unchanged'));
      logMcpUrl(plan.remote);
      summary.skipped++;
      continue;
    }
    if (options.dryRun) {
      log.info(
        chalk.blue(
          `    [PLAN] ${plan.action === 'create' ? 'Create' : 'Update'}`
        )
      );
      if (plan.action === 'update') logMcpUrl(plan.remote);
      summary.planned++;
      continue;
    }
    if (await writeMcpServer(client, file, plan)) {
      log.info(
        chalk.green(
          `    [OK] ${plan.action === 'create' ? 'Created' : 'Updated'}`
        )
      );
      if (plan.action === 'create') summary.created++;
      else summary.updated++;
    } else {
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
    }
    await sleep(500);
  }
}
