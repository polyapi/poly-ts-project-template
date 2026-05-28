import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type createClient from 'openapi-fetch';
import { getDependencies, getTSBaseUrl } from 'polyapi/build/transpiler';
import ts from 'typescript';
import type { paths } from '../sdk/schema';
import type { FunctionFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { getProductionExecutionApiKeyOverride } from '../utils/deploymentConfig';
import { substituteEnvTokens } from '../utils/envSubstitution';
import {
  getProjectRoot,
  getSrcPath,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import { chalk, createHeader, createLogger } from '../utils/logger';
import { getRequiredNamespace, validateNamespace } from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { validateFunctionArtifact } from '../utils/validation';

const log = createLogger('functions');

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/');
}

type FindFunctionFileOptions = WalkDirOptions;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractCliFailure(output: string): string | null {
  const escapeCharacter = String.fromCharCode(27);
  const ansiEscapePattern = new RegExp(`${escapeCharacter}\\[[0-9;]*m`, 'g');
  const plainOutput = output.replace(ansiEscapePattern, '');

  const statusCodeMatch = plainOutput.match(
    /request failed with status code\s+(\d{3})/i
  );
  if (statusCodeMatch) {
    return `Request failed with status code ${statusCodeMatch[1]}`;
  }

  for (const line of plainOutput.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    if (/^ERROR\b/i.test(trimmedLine) || /^Error:\s*/.test(trimmedLine)) {
      return trimmedLine;
    }
  }

  return null;
}

type PolyConfigMetadata = {
  name: string;
  context: string;
  description: string;
  visibility?: 'ENVIRONMENT' | 'TENANT' | 'PUBLIC';
  logsEnabled?: boolean;
  generateContexts?: string[];
  executionApiKey?: string;
  cachePolyLibrary?: boolean;
};

type FunctionComparisonPayload = {
  name: string;
  context: string;
  description: string;
  code: string;
  visibility: 'ENVIRONMENT' | 'TENANT' | 'PUBLIC';
  externalDependencies?: unknown;
  logsEnabled?: boolean;
  generateContexts?: string[];
  cachePolyLibrary?: boolean;
};

type ExistingFunctionRecord = {
  id: string;
  name: string;
  context: string;
  _functionType: 'client' | 'server';
};

type FunctionSyncDecision =
  | { action: 'create' | 'update' }
  | { action: 'skip' };

function getFunctionKey(
  type: 'client' | 'server',
  name: string,
  context: string
): string {
  return `${type}:${name}:${context}`;
}

function normalizeMultilineText(value: string): string {
  return value.replace(/\r\n/g, '\n').trimEnd();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalize(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, canonicalize(nestedValue)])
    );
  }

  return value;
}

function normalizeDependencyRecord(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const normalized = canonicalize(value) as Record<string, unknown>;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const normalizedValues = value
    .filter(
      (item): item is string => typeof item === 'string' && item.length > 0
    )
    .sort((left, right) => left.localeCompare(right));

  return normalizedValues.length > 0 ? normalizedValues : undefined;
}

function getEffectiveVisibility(
  metadata: FunctionFile['metadata']
): 'ENVIRONMENT' | 'TENANT' | 'PUBLIC' {
  return metadata.visibility ?? 'ENVIRONMENT';
}

async function getFunctionDependenciesForComparison(
  func: FunctionFile,
  code: string
): Promise<{
  externalDependencies?: unknown;
}> {
  const [externalDependencies] = await getDependencies(
    code,
    func.tsFilePath,
    getTSBaseUrl(),
    true
  );

  return { externalDependencies };
}

async function buildLocalComparisonPayload(
  func: FunctionFile
): Promise<FunctionComparisonPayload> {
  const code = readFileSync(func.tsFilePath, 'utf8');
  const { externalDependencies } = await getFunctionDependenciesForComparison(
    func,
    code
  );

  const payload: FunctionComparisonPayload = {
    name: func.metadata.name,
    context: func.metadata.context,
    description: func.metadata.description,
    code,
    visibility: getEffectiveVisibility(func.metadata),
  };

  if (func.type === 'server') {
    payload.externalDependencies = externalDependencies;
  }

  if (func.type === 'server') {
    if (func.metadata.logsEnabled !== undefined) {
      payload.logsEnabled = func.metadata.logsEnabled;
    }
    if (
      Array.isArray(func.metadata.generateContexts) &&
      func.metadata.generateContexts.length > 0
    ) {
      payload.generateContexts = func.metadata.generateContexts;
    }
    if (func.metadata.cachePolyLibrary !== undefined) {
      payload.cachePolyLibrary = func.metadata.cachePolyLibrary;
    }
  }

  return payload;
}

function buildRemoteComparisonPayload(
  func: FunctionFile,
  remote: any
): FunctionComparisonPayload {
  const payload: FunctionComparisonPayload = {
    name: typeof remote?.name === 'string' ? remote.name : func.metadata.name,
    context:
      typeof remote?.context === 'string'
        ? remote.context
        : func.metadata.context,
    description:
      typeof remote?.description === 'string' ? remote.description : '',
    code: typeof remote?.code === 'string' ? remote.code : '',
    visibility:
      remote?.visibility === 'PUBLIC' ||
      remote?.visibility === 'TENANT' ||
      remote?.visibility === 'ENVIRONMENT'
        ? remote.visibility
        : 'ENVIRONMENT',
  };

  if (func.type === 'server') {
    payload.externalDependencies = remote?.externalDependencies;
    if (func.metadata.logsEnabled !== undefined) {
      payload.logsEnabled =
        typeof remote?.logsEnabled === 'boolean'
          ? remote.logsEnabled
          : undefined;
    }
    if (
      Array.isArray(func.metadata.generateContexts) &&
      func.metadata.generateContexts.length > 0
    ) {
      payload.generateContexts = normalizeStringArray(remote?.generateContexts);
    }
    if (func.metadata.cachePolyLibrary !== undefined) {
      payload.cachePolyLibrary =
        typeof remote?.cachePolyLibrary === 'boolean'
          ? remote.cachePolyLibrary
          : undefined;
    }
  }

  return payload;
}

function normalizeComparisonPayload(
  payload: FunctionComparisonPayload
): Record<string, unknown> {
  const normalizedPayload: Record<string, unknown> = {
    name: payload.name,
    context: payload.context,
    description: normalizeMultilineText(payload.description),
    code: normalizeMultilineText(payload.code),
    visibility: payload.visibility,
    externalDependencies: normalizeDependencyRecord(
      payload.externalDependencies
    ),
  };

  if (payload.logsEnabled !== undefined) {
    normalizedPayload.logsEnabled = payload.logsEnabled;
  }
  if (payload.generateContexts !== undefined) {
    normalizedPayload.generateContexts = normalizeStringArray(
      payload.generateContexts
    );
  }
  if (payload.cachePolyLibrary !== undefined) {
    normalizedPayload.cachePolyLibrary = payload.cachePolyLibrary;
  }

  return canonicalize(normalizedPayload) as Record<string, unknown>;
}

function areFunctionPayloadsEqual(
  localPayload: FunctionComparisonPayload,
  remotePayload: FunctionComparisonPayload
): boolean {
  return (
    JSON.stringify(normalizeComparisonPayload(localPayload)) ===
    JSON.stringify(normalizeComparisonPayload(remotePayload))
  );
}

async function getExistingFunctionDetails(
  client: ReturnType<typeof createClient<paths>>,
  func: ExistingFunctionRecord
): Promise<any | null> {
  try {
    if (func._functionType === 'server') {
      const { data, error, response } = await client.GET(
        '/functions/server/{id}',
        {
          params: { path: { id: func.id } },
        }
      );

      if (error || !data) {
        log.warn(
          {
            functionId: func.id,
            functionType: func._functionType,
            status: (response as any)?.status,
          },
          'Failed to fetch remote function details'
        );
        return null;
      }

      return data;
    }

    const { data, error, response } = await client.GET(
      '/functions/client/{id}',
      {
        params: { path: { id: func.id } },
      }
    );

    if (error || !data) {
      log.warn(
        {
          functionId: func.id,
          functionType: func._functionType,
          status: (response as any)?.status,
        },
        'Failed to fetch remote function details'
      );
      return null;
    }

    return data;
  } catch (error) {
    log.warn(
      { error, functionId: func.id, functionType: func._functionType },
      'Error fetching remote function details'
    );
    return null;
  }
}

async function decideFunctionSyncAction(
  client: ReturnType<typeof createClient<paths>>,
  func: FunctionFile,
  existingFunction: ExistingFunctionRecord | undefined,
  force: boolean = false
): Promise<FunctionSyncDecision> {
  if (!existingFunction) {
    return { action: 'create' };
  }

  if (force) {
    return { action: 'update' };
  }

  const localPayload = await buildLocalComparisonPayload(func);
  const remoteDetails = await getExistingFunctionDetails(
    client,
    existingFunction
  );

  if (!remoteDetails) {
    return { action: 'update' };
  }

  const remotePayload = buildRemoteComparisonPayload(func, remoteDetails);

  return areFunctionPayloadsEqual(localPayload, remotePayload)
    ? { action: 'skip' }
    : { action: 'update' };
}

function getPropertyName(propertyName: ts.PropertyName): string | null {
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
    return propertyName.text;
  }

  return null;
}

function getStringLiteralValue(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function getBooleanLiteralValue(node: ts.Expression): boolean | undefined {
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }

  return undefined;
}

function getStringArrayLiteralValue(node: ts.Expression): string[] | undefined {
  if (!ts.isArrayLiteralExpression(node)) {
    return undefined;
  }

  const values: string[] = [];
  for (const element of node.elements) {
    const value = getStringLiteralValue(element);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }

  return values;
}

function extractPolyConfigFromTs(
  source: string,
  filePath: string
): PolyConfigMetadata | null {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS
  );
  let configObject: ts.ObjectLiteralExpression | null = null;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'polyConfig' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      configObject = node.initializer;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (!configObject) {
    return null;
  }
  const resolvedConfigObject = configObject as ts.ObjectLiteralExpression;

  const metadata: PolyConfigMetadata = {
    name: '',
    context: '',
    description: '',
  };

  for (const property of resolvedConfigObject.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const propertyName = getPropertyName(property.name);
    if (!propertyName) {
      continue;
    }

    switch (propertyName) {
      case 'name': {
        metadata.name = getStringLiteralValue(property.initializer) ?? '';
        break;
      }
      case 'context': {
        metadata.context = getStringLiteralValue(property.initializer) ?? '';
        break;
      }
      case 'description': {
        metadata.description =
          getStringLiteralValue(property.initializer) ?? '';
        break;
      }
      case 'visibility': {
        const visibility = getStringLiteralValue(property.initializer);
        if (
          visibility === 'ENVIRONMENT' ||
          visibility === 'TENANT' ||
          visibility === 'PUBLIC'
        ) {
          metadata.visibility = visibility;
        }
        break;
      }
      case 'logsEnabled': {
        metadata.logsEnabled = getBooleanLiteralValue(property.initializer);
        break;
      }
      case 'generateContexts': {
        metadata.generateContexts = getStringArrayLiteralValue(
          property.initializer
        );
        break;
      }
      case 'executionApiKey': {
        metadata.executionApiKey = getStringLiteralValue(property.initializer);
        break;
      }
      case 'cachePolyLibrary': {
        metadata.cachePolyLibrary = getBooleanLiteralValue(
          property.initializer
        );
        break;
      }
      default:
        break;
    }
  }

  if (!metadata.name || !metadata.context) {
    return null;
  }

  return metadata;
}

/**
 * Find all function files in the project using embedded polyConfig metadata
 */
export function findFunctionFiles(
  options: FindFunctionFileOptions = {}
): FunctionFile[] {
  const functionFiles: FunctionFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      const normalizedPath = normalizePath(fullPath);
      if (
        file.endsWith('.ts') &&
        !file.endsWith('.test.ts') &&
        !file.endsWith('.spec.ts') &&
        (normalizedPath.includes('/server/') ||
          normalizedPath.includes('/client/')) &&
        !normalizedPath.includes('/artefacts/')
      ) {
        let source: string;
        try {
          source = readFileSync(fullPath, 'utf8');
        } catch {
          log.warn(
            { tsFile: file },
            'Unable to read TypeScript file for polyConfig extraction'
          );
          return;
        }

        const extractedMetadata = extractPolyConfigFromTs(source, fullPath);
        const metadata = extractedMetadata
          ? substituteEnvTokens(extractedMetadata)
          : null;
        if (!metadata) {
          log.warn(
            { tsFile: file },
            'No polyConfig found in TypeScript file — skipping'
          );
          return;
        }

        const type = normalizedPath.includes('/server/') ? 'server' : 'client';
        functionFiles.push({
          tsFilePath: fullPath,
          type,
          metadata,
        });
      }
    },
    options
  );

  return functionFiles;
}

/**
 * Get all existing server functions from the API
 */
export async function getExistingServerFunctions(
  client: ReturnType<typeof createClient<paths>>
): Promise<any[]> {
  try {
    const { data, error } = await client.GET('/functions/server', {});

    if (error || !data) {
      return [];
    }

    return (data as any[]).map(f => ({ ...f, _functionType: 'server' }));
  } catch (error) {
    log.warn({ error }, 'Failed to fetch server functions from API');
    return [];
  }
}

/**
 * Get all existing client functions from the API
 */
async function getExistingClientFunctions(
  client: ReturnType<typeof createClient<paths>>
): Promise<any[]> {
  try {
    const { data, error } = await client.GET('/functions/client', {});

    if (error || !data) {
      return [];
    }

    return (data as any[]).map(f => ({ ...f, _functionType: 'client' }));
  } catch (error) {
    log.warn({ error }, 'Failed to fetch client functions from API');
    return [];
  }
}

/**
 * Delete a server function by ID
 */
async function deleteServerFunction(
  client: ReturnType<typeof createClient<paths>>,
  functionId: string,
  name: string,
  context: string
): Promise<void> {
  try {
    const { error, response } = await client.DELETE('/functions/server/{id}', {
      params: { path: { id: functionId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      log.error(
        { name, context, status: (response as any).status },
        'Failed to delete server function'
      );
    } else {
      log.info({ name, context }, 'Server function deleted');
    }
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting server function');
  }
}

/**
 * Delete a client function by ID
 */
async function deleteClientFunction(
  client: ReturnType<typeof createClient<paths>>,
  functionId: string,
  name: string,
  context: string
): Promise<void> {
  try {
    const { error, response } = await client.DELETE('/functions/client/{id}', {
      params: { path: { id: functionId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      log.error(
        { name, context, status: (response as any).status },
        'Failed to delete client function'
      );
    } else {
      log.info({ name, context }, 'Client function deleted');
    }
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting client function');
  }
}

/**
 * Add or update a function using poly CLI
 * Returns: 'deployed' | 'failed'
 */
async function addFunction(func: FunctionFile): Promise<'deployed' | 'failed'> {
  return new Promise((resolve, _reject) => {
    const {
      name,
      context,
      description,
      visibility,
      logsEnabled,
      generateContexts,
      executionApiKey,
      cachePolyLibrary,
    } = func.metadata;
    const executionApiKeyOverride = getProductionExecutionApiKeyOverride(
      getProjectRoot()
    );
    const effectiveExecutionApiKey = executionApiKeyOverride ?? executionApiKey;

    const isServerFunction = func.type === 'server';
    const isClientFunction = func.type === 'client';

    const args = [
      'exec',
      'poly',
      'function',
      'add',
      name,
      func.tsFilePath,
      '--context',
      context,
      '--description',
      description,
    ];

    if (visibility) {
      args.push('--visibility', visibility);
    }

    // poly CLI requires either --server or --client flag
    if (isServerFunction) {
      args.push('--server');
      if (logsEnabled !== undefined) {
        args.push('--logs', logsEnabled ? 'enabled' : 'disabled');
      }
      if (generateContexts && generateContexts.length > 0) {
        args.push('--generateContexts', generateContexts.join(','));
      }
      if (effectiveExecutionApiKey) {
        args.push('--execution-api-key', effectiveExecutionApiKey);
      }
      if (cachePolyLibrary !== undefined) {
        args.push(`--cache-poly-library=${String(cachePolyLibrary)}`);
      }
    } else if (isClientFunction) {
      args.push('--client');
    }

    const { command, commandArgs } = resolvePnpmCommand(args);
    const child = spawn(command, commandArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: getProjectRoot(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', data => {
      stdout += data.toString();
    });

    child.stderr?.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      const cliFailure = extractCliFailure(`${stdout}\n${stderr}`);

      if (code === 0 && !cliFailure) {
        resolve('deployed');
      } else {
        log.error(
          {
            name,
            code,
            cliFailure,
            stderr: stderr.trim(),
            stdout: stdout.trim(),
          },
          'Function add failed'
        );
        resolve('failed');
      }
    });

    child.on('error', error => {
      log.error({ error, name }, 'Error running poly CLI for function');
      resolve('failed');
    });
  });
}

function resolvePnpmCommand(args: string[]): {
  command: string;
  commandArgs: string[];
} {
  const execPath = process.env.npm_execpath;
  if (execPath) {
    return { command: process.execPath, commandArgs: [execPath, ...args] };
  }

  return { command: 'pnpm', commandArgs: args };
}

/**
 * Synchronize functions with the API
 */
export async function syncFunctions(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindFunctionFileOptions;
    functionTypes?: FunctionFile['type'][];
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const functionFiles = findFunctionFiles(options.discoveryOptions).filter(
    func => !options.functionTypes || options.functionTypes.includes(func.type)
  );
  const allFunctionFiles = findFunctionFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  }).filter(
    func => !options.functionTypes || options.functionTypes.includes(func.type)
  );

  log.info(chalk.cyan(createHeader('FUNCTIONS')));

  if (functionFiles.length === 0) {
    log.warn(
      'No function TypeScript files with polyConfig found in src/**/server/ or src/**/client/'
    );
    return;
  }

  log.info(chalk.gray(`Found ${functionFiles.length} local function file(s)`));

  // Step 1: Get existing functions from API (filtered by namespace)
  const namespace = getRequiredNamespace();
  const [allServerFunctions, allClientFunctions] = await Promise.all([
    getExistingServerFunctions(client),
    getExistingClientFunctions(client),
  ]);
  const allFunctions = [...allServerFunctions, ...allClientFunctions];
  const existingFunctions = allFunctions.filter((func: any) =>
    func.context?.startsWith(namespace)
  );
  log.info(
    chalk.gray(
      `Fetched ${existingFunctions.length} function(s) from API in namespace "${namespace}" (${allServerFunctions.filter((f: any) => f.context?.startsWith(namespace)).length} server, ${allClientFunctions.filter((f: any) => f.context?.startsWith(namespace)).length} client)`
    )
  );

  // Step 2: Identify functions that don't exist locally (orphans)
  const localFunctionKeys = new Set(
    allFunctionFiles.map(
      ff => `${ff.type}:${ff.metadata.name}:${ff.metadata.context}`
    )
  );

  if (options.detectOrphans === false) {
    log.info(chalk.gray('Skipping orphan detection for scoped function sync'));
  } else {
    const orphanCandidates = existingFunctions.filter(
      (func: any) =>
        !localFunctionKeys.has(
          `${func._functionType}:${func.name}:${func.context}`
        )
    );
    const { included: functionsToDelete, excluded: excludedFunctions } =
      filterOrphansByContext(orphanCandidates);
    if (excludedFunctions.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excludedFunctions.length} function orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (functionsToDelete.length > 0) {
      if (deleteOrphans) {
        log.info(
          chalk.yellow(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${functionsToDelete.length} function(s) not in local files...`
          )
        );
        for (const func of functionsToDelete) {
          if (options.dryRun) {
            log.info(
              chalk.blue(
                `    [PLAN] Delete ${func._functionType} function ${func.name} (${func.context})`
              )
            );
            summary.planned++;
            continue;
          }

          if (func._functionType === 'client') {
            await deleteClientFunction(
              client,
              func.id,
              func.name,
              func.context
            );
          } else {
            await deleteServerFunction(
              client,
              func.id,
              func.name,
              func.context
            );
          }
          await sleep(300);
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${functionsToDelete.length} orphaned function(s) (skipping deletion)`
          )
        );
        for (const func of functionsToDelete) {
          orphans.push({
            type: 'function',
            name: func.name,
            context: func.context,
            id: func.id,
          });
        }
      }
    } else {
      log.debug('No functions to delete');
    }
  }

  // Step 3: Add or update local functions
  // Sort: client functions first, then server functions (server functions may depend on client functions)
  const existingFunctionsByKey = new Map(
    existingFunctions.map((func: any) => [
      getFunctionKey(func._functionType, func.name, func.context),
      func as ExistingFunctionRecord,
    ])
  );

  const sortedFunctions = [...functionFiles].sort((a, b) => {
    if (a.type === 'client' && b.type === 'server') return -1;
    if (a.type === 'server' && b.type === 'client') return 1;
    return 0;
  });

  log.info(chalk.blue('Comparing local function payloads with API...'));
  for (const func of sortedFunctions) {
    const { name, context } = func.metadata;
    const typeLabel = func.type === 'server' ? 'server' : 'client';
    log.info(chalk.dim(`  → ${name} [${typeLabel}] (${context})`));

    // Validate artifact structure before syncing
    if (
      !validateFunctionArtifact(func.metadata, func.tsFilePath, skipInvalid)
    ) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    // Validate namespace
    try {
      validateNamespace(context, 'Function', name);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'Namespace validation failed'
      );
      log.info(chalk.red('    [FAIL] Failed (namespace)'));
      summary.failed++;
      continue;
    }

    let decision: FunctionSyncDecision;
    try {
      decision = await decideFunctionSyncAction(
        client,
        func,
        existingFunctionsByKey.get(getFunctionKey(func.type, name, context)),
        options.force
      );
    } catch (error) {
      log.warn(
        {
          name,
          context,
          error: getErrorMessage(error),
        },
        'Failed to compare function payload; falling back to deploy'
      );
      log.info(chalk.yellow('    [WARN] Compare failed, deploying'));
      decision = { action: 'update' };
    }

    if (decision.action === 'skip') {
      log.info(chalk.gray('    [SKIP] Unchanged'));
      summary.skipped++;
      continue;
    }

    if (options.dryRun) {
      log.info(
        chalk.blue(
          `    [PLAN] ${decision.action === 'create' ? 'Create' : 'Update'}`
        )
      );
      summary.planned++;
      continue;
    }

    const result = await addFunction(func);
    if (result === 'deployed') {
      if (decision.action === 'create') {
        log.info(chalk.green('    [OK] Created'));
        summary.created++;
      } else {
        log.info(chalk.green('    [OK] Updated'));
        summary.updated++;
      }
    } else {
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
    }
    await sleep(500);
  }
}
