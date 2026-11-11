import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type createClient from 'openapi-fetch';
import { getDependencies, getTSBaseUrl } from 'polyapi/build/transpiler';
import ts from 'typescript';
import type { paths } from '../sdk/schema';
import type { FunctionFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import {
  getBaseUrl,
  getDeleteHeaders,
  resolveSelectedEnvPath,
  sleep,
} from '../utils/apiClient';
import { getProductionExecutionApiKeyOverride } from '../utils/deploymentConfig';
import { substituteEnvTokens } from '../utils/envSubstitution';
import {
  findWorkspaceRoot,
  getProjectRoot,
  getSrcPath,
  isInArtefactDirectory,
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
import {
  getServerFunctionDeployment,
  getServerFunctionDeploymentPlan,
  parseDeployedFunctionId,
  readServerFunctionDeploymentConfig,
  runServerFunctionPostDeployScript,
} from '../utils/serverFunctionDeployment';
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
  image?: string;
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

export function normalizeMultilineText(value: string): string {
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

/**
 * Directory of the package that declares `polyapi` — the home of the `poly`
 * binary, of the npm pins polyapi resolves external dependencies from, and of
 * the tsconfig it reads. Walks up from the CLI's cwd; in this template that is
 * workflows/ itself, in a layout that declares polyapi at the workspace root
 * it is the root. Falls back to the cwd.
 */
export function getPolyPackageDir(): string {
  const declaresPolyapi = (dir: string): boolean => {
    const packageJsonPath = path.join(dir, 'package.json');
    if (!existsSync(packageJsonPath)) {
      return false;
    }
    try {
      const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Boolean(
        manifest.dependencies?.polyapi || manifest.devDependencies?.polyapi
      );
    } catch {
      return false;
    }
  };

  // The workspace root wins when it declares polyapi: that is where a
  // project's function dependencies are pinned (both manifests may list
  // polyapi). Otherwise the nearest package above the cwd that declares it.
  const workspaceRoot = findWorkspaceRoot(getProjectRoot());
  if (declaresPolyapi(workspaceRoot)) {
    return workspaceRoot;
  }
  let current = getProjectRoot();
  while (true) {
    if (declaresPolyapi(current)) {
      return current;
    }
    if (current === workspaceRoot || path.dirname(current) === current) {
      return getProjectRoot();
    }
    current = path.dirname(current);
  }
}

async function getFunctionDependenciesForComparison(
  func: FunctionFile,
  code: string
): Promise<{
  externalDependencies?: unknown;
}> {
  // polyapi's getDependencies resolves npm versions from process.cwd()/package.json
  // (and tsconfig from cwd), so compare from the package that declares polyapi —
  // the same directory addFunction deploys from; otherwise pins never match.
  const previousCwd = process.cwd();
  process.chdir(getPolyPackageDir());
  try {
    const [externalDependencies] = await getDependencies(
      code,
      func.tsFilePath,
      getTSBaseUrl(),
      true
    );
    return { externalDependencies };
  } finally {
    process.chdir(previousCwd);
  }
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
    payload.image = getServerFunctionDeployment(func).image;
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
    if (getServerFunctionDeployment(func).image !== undefined) {
      payload.image = remote?.image ?? '';
    }
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
  if (payload.image !== undefined) {
    normalizedPayload.image = payload.image;
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

export async function getExistingFunctionDetails(
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
        !isInArtefactDirectory(normalizedPath)
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
export async function getExistingClientFunctions(
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
 * Delete a server function by ID. Returns true when the API confirmed the deletion.
 */
export async function deleteServerFunction(
  client: ReturnType<typeof createClient<paths>>,
  functionId: string,
  name: string,
  context: string
): Promise<boolean> {
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
      return false;
    }
    log.info({ name, context }, 'Server function deleted');
    return true;
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting server function');
    return false;
  }
}

/**
 * Delete a client function by ID. Returns true when the API confirmed the deletion.
 */
export async function deleteClientFunction(
  client: ReturnType<typeof createClient<paths>>,
  functionId: string,
  name: string,
  context: string
): Promise<boolean> {
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
      return false;
    }
    log.info({ name, context }, 'Client function deleted');
    return true;
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting client function');
    return false;
  }
}

/**
 * Environment for a spawned `poly` CLI process.
 *
 * The poly CLI reads POLY_API_KEY / POLY_API_BASE_URL (falling back to the
 * `poly setup` config file), while loadEnv() only populates API_KEY / BASE_URL
 * from the ENVPATH file. Without this mapping a push compares against the
 * ENVPATH environment but deploys to whatever `poly setup` last wrote. The base
 * URL is pinned to the one this CLI talks to (getBaseUrl(), which has a
 * default), so the child never deploys to another instance than the one that
 * was compared.
 */
export function getPolyCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // polyapi's loadConfig() lets its config file override the environment when
  // CONFIG_ENV_PATH_PRIORITY === "true"; that would silently undo the pinning.
  delete env.CONFIG_ENV_PATH_PRIORITY;
  if (process.env.API_KEY) {
    env.POLY_API_KEY = process.env.API_KEY;
  }
  env.POLY_API_BASE_URL = getBaseUrl();
  return env;
}

/**
 * Directory the poly CLI generates into, resolved the same way polyapi does
 * (`<polyapi package>/build/../../../node_modules/.poly`) from the package that
 * declares polyapi, then from the workspace root.
 */
export function locatePolyDir(workspaceRoot: string): string | null {
  try {
    const packageJsonPath = require.resolve('polyapi/package.json', {
      paths: [getPolyPackageDir(), workspaceRoot],
    });
    return path.resolve(
      path.dirname(packageJsonPath),
      '..',
      '..',
      'node_modules',
      '.poly'
    );
  } catch (error) {
    log.debug(
      { error, workspaceRoot },
      'Could not resolve the polyapi package; .poly directory unknown'
    );
    return null;
  }
}

export const POLY_GENERATE_PROVENANCE_FILE = '.flow-generate.json';

export interface PolyGenerateProvenance {
  baseUrl?: string;
  keyFingerprint?: string;
  generatedAt: string;
}

export function fingerprintApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

/**
 * Record which environment the generated SDK (specs cache) was produced for.
 * Written inside `lib/` on purpose: `poly generate` replaces that directory,
 * so a generate not run through this CLI leaves no stale provenance behind.
 */
export function writePolyGenerateProvenance(workspaceRoot: string): void {
  const polyDir = locatePolyDir(workspaceRoot);
  if (!polyDir) {
    return;
  }
  const libDir = path.join(polyDir, 'lib');
  if (!existsSync(libDir)) {
    return;
  }
  const provenance: PolyGenerateProvenance = {
    baseUrl: process.env.BASE_URL,
    keyFingerprint: process.env.API_KEY
      ? fingerprintApiKey(process.env.API_KEY)
      : undefined,
    generatedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(
      path.join(libDir, POLY_GENERATE_PROVENANCE_FILE),
      `${JSON.stringify(provenance, null, 2)}\n`
    );
  } catch (error) {
    log.debug({ error }, 'Could not write poly generate provenance');
  }
}

export function readPolyGenerateProvenance(
  polyDir: string
): PolyGenerateProvenance | null {
  const provenancePath = path.join(
    polyDir,
    'lib',
    POLY_GENERATE_PROVENANCE_FILE
  );
  if (!existsSync(provenancePath)) {
    return null;
  }
  try {
    return JSON.parse(
      readFileSync(provenancePath, 'utf8')
    ) as PolyGenerateProvenance;
  } catch {
    return null;
  }
}

/**
 * Add or update a function using poly CLI
 * Returns: 'deployed' | 'failed'
 * `flagExecutionApiKey` is the `--execution-api-key` value of `push-dynamic`;
 * precedence: production safeguard override > flag > polyConfig field.
 */
export async function addFunction(
  func: FunctionFile,
  flagExecutionApiKey?: string
): Promise<'deployed' | 'failed'> {
  const deployment = getServerFunctionDeployment(func);
  const hookEnv = deployment.script
    ? {
        ...getPolyCliEnv(),
        ENVPATH: resolveSelectedEnvPath(
          process.env.ENVPATH?.trim() || 'workflows/dev.env'
        ),
      }
    : undefined;
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
    const effectiveExecutionApiKey =
      executionApiKeyOverride ?? flagExecutionApiKey ?? executionApiKey;

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
      if (deployment.image) {
        args.push('--image', deployment.image);
      }
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
    // Run from the package that declares polyapi: that is where `pnpm exec poly`
    // finds the binary and where polyapi resolves npm pins and tsconfig from.
    // Pin the child to the ENVPATH environment (see getPolyCliEnv).
    const child = spawn(command, commandArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: getPolyPackageDir(),
      env: getPolyCliEnv(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', data => {
      stdout += data.toString();
    });

    child.stderr?.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', async code => {
      const cliFailure = extractCliFailure(`${stdout}\n${stderr}`);

      if (code === 0 && !cliFailure) {
        if (deployment.script && hookEnv) {
          try {
            const functionId = parseDeployedFunctionId(stdout);
            const functionKey = `${context}.${name}`;
            log.info(`Running post-deploy script for ${functionKey}`);
            await runServerFunctionPostDeployScript({
              functionKey,
              command: deployment.script,
              functionId,
              cwd: findWorkspaceRoot(getProjectRoot()),
              env: hookEnv,
            });
          } catch (error) {
            log.error(getErrorMessage(error));
            resolve('failed');
            return;
          }
        }
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
    const normalizedExecPath = execPath.toLowerCase();
    const isJavaScriptEntryPoint =
      normalizedExecPath.endsWith('.js') ||
      normalizedExecPath.endsWith('.cjs') ||
      normalizedExecPath.endsWith('.mjs');

    // npm_execpath can be either a JS file or a native executable.
    if (isJavaScriptEntryPoint) {
      return { command: process.execPath, commandArgs: [execPath, ...args] };
    }

    return { command: execPath, commandArgs: args };
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
  // Reject malformed deployment settings before any function writes/deletions.
  readServerFunctionDeploymentConfig();
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
      warningColor(
        'No function TypeScript files with polyConfig found in src/**/server/ or src/**/client/'
      )
    );
    return;
  }

  log.info(chalk.gray(`Found ${functionFiles.length} local function file(s)`));

  // Step 1: Get existing functions from API (filtered by namespace)
  const namespaces = getRequiredNamespaces();
  const [allServerFunctions, allClientFunctions] = await Promise.all([
    getExistingServerFunctions(client),
    getExistingClientFunctions(client),
  ]);
  const allFunctions = [...allServerFunctions, ...allClientFunctions];
  const existingFunctions = allFunctions.filter((func: any) =>
    matchesAnyRequiredNamespace(func.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${existingFunctions.length} function(s) from API in namespace(s) "${namespaces.join(', ')}" (${
        allServerFunctions.filter((f: any) =>
          matchesAnyRequiredNamespace(f.context)
        ).length
      } server, ${allClientFunctions.filter((f: any) => matchesAnyRequiredNamespace(f.context)).length} client)`
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
          warningColor(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${
              functionsToDelete.length
            } function(s) not in local files...`
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
      log.info(warningColor('    [WARN] Compare failed, deploying'));
      decision = { action: 'update' };
    }

    if (decision.action === 'skip') {
      log.info(chalk.gray('    [SKIP] Unchanged'));
      summary.skipped++;
      continue;
    }

    if (options.dryRun) {
      const deployment = getServerFunctionDeploymentPlan(func);
      if (deployment.image) log.info(`    [PLAN] Image: ${deployment.image}`);
      if (deployment.postDeployScript)
        log.info(
          '    [PLAN] Run configured post-deploy script after successful deployment'
        );
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
