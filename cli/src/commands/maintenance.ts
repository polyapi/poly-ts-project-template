import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { createPolyApiClient, getBaseUrl } from '../utils/apiClient';
import { validateNamespace } from '../utils/namespace';
import { getPolyGenerateEnvironment } from '../utils/polyGenerateEnvironment';
import { cleanDescriptions, selectOperations } from './openApiPreparation';
import { normalizeOpenApiSchemaNames } from './openApiSchemaNames';
import {
  type ModelResource,
  prepareModel,
  schemaLayers,
  type TrainingModel,
  validateModel,
} from './trainingModel';

const endpoints = {
  api: '/functions/api',
  schema: '/schemas',
  variable: '/variables',
  webhook: '/webhooks',
  trigger: '/triggers',
  table: '/tables',
  job: '/jobs',
  client: '/functions/client',
  server: '/functions/server',
  ai: '/functions/ai',
  subscription: '/subscriptions/graphql',
} as const;

export type ResourceType = keyof typeof endpoints;
export interface Resource {
  id: string;
  context: string;
  name?: string;
}
export interface MaintenanceArgs {
  command: 'train-openapi' | 'train-model' | 'delete-content' | 'logs';
  help: boolean;
  dryRun: boolean;
  target?: string;
  context?: string;
  type?: string;
  apply: boolean;
  includeChildren: boolean;
  generateOnly: boolean;
  overwriteModel: boolean;
  skipGenerate: boolean;
  disableAi: boolean;
  operationIds: string[];
  renames: string[][];
  logsPage: number;
  logsPageSize: number;
  limit: number;
  keyword?: string;
  raw: boolean;
}
export interface MaintenanceRuntime {
  workspaceRoot: string;
  invocationDirectory: string;
  prompt(message: string): Promise<string>;
  print(message: string): void;
  list(type: ResourceType): Promise<unknown>;
  remove(type: ResourceType, id: string): Promise<void>;
  detail(type: ResourceType, id: string): Promise<Record<string, any> | null>;
  upsert(
    type: 'api' | 'schema' | 'webhook',
    resource: ModelResource
  ): Promise<void>;
  logs(id: string, options: MaintenanceArgs): Promise<string>;
  runPoly(args: string[]): void;
  convertSwagger(input: string, output: string): void;
}

function positiveInteger(name: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

export function parseMaintenanceArgs(argv: string[]): MaintenanceArgs | null {
  const [provided, ...rest] = argv.filter(argument => argument !== '--');
  const aliases: Record<string, MaintenanceArgs['command']> = {
    'train:openapi': 'train-openapi',
    'delete:content': 'delete-content',
  };
  const command = aliases[provided] ?? provided;
  if (
    !['train-openapi', 'train-model', 'delete-content', 'logs'].includes(
      command
    )
  )
    return null;
  const input: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--rename') {
      const pair = rest.slice(i + 1, i + 3);
      if (pair.length !== 2 || pair.some(value => value.startsWith('--')))
        throw new Error('--rename requires FROM TO.');
      if (!pair[0] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(pair[1]))
        throw new Error(
          '--rename requires a nonempty FROM and an identifier TO.'
        );
      input.push('--rename', JSON.stringify(pair));
      i += 2;
    } else input.push(rest[i]);
  }
  const options: Record<
    string,
    { type: 'string' | 'boolean'; short?: string; multiple?: boolean }
  > = {
    help: { type: 'boolean', short: 'h' },
    ...(command === 'logs'
      ? {
          'logs-page': { type: 'string' as const },
          'logs-page-size': { type: 'string' as const },
          limit: { type: 'string' as const },
          keyword: { type: 'string' as const },
          raw: { type: 'boolean' as const },
        }
      : {
          'dry-run': { type: 'boolean' as const },
          ...(command === 'delete-content'
            ? {
                context: { type: 'string' as const },
                types: { type: 'string' as const },
                type: { type: 'string' as const },
                apply: { type: 'boolean' as const },
                'include-children': { type: 'boolean' as const },
              }
            : {
                'skip-generate': { type: 'boolean' as const },
                ...(command === 'train-openapi'
                  ? {
                      context: { type: 'string' as const },
                      'generate-only': { type: 'boolean' as const },
                      'overwrite-model': { type: 'boolean' as const },
                      'disable-ai': { type: 'boolean' as const },
                      'operation-id': {
                        type: 'string' as const,
                        multiple: true,
                      },
                      rename: { type: 'string' as const, multiple: true },
                    }
                  : {}),
              }),
        }),
  };
  const { values, positionals } = parseArgs({
    args: input,
    options,
    allowPositionals: true,
  });
  if (positionals.length > (command === 'delete-content' ? 0 : 1))
    throw new Error(
      `Unexpected argument(s) for flow ${command}. Use --help for usage.`
    );
  if (values.type && values.types)
    throw new Error('Use either --type or --types.');
  if (values.apply && values['dry-run'])
    throw new Error('--apply and --dry-run cannot be combined.');
  const pageSize = positiveInteger(
    '--logs-page-size',
    String(values['logs-page-size'] ?? '100')
  );
  return {
    command: command as MaintenanceArgs['command'],
    help: values.help === true,
    dryRun:
      values['dry-run'] === true ||
      (command === 'delete-content' && values.apply !== true),
    target: positionals[0],
    context: values.context as string | undefined,
    type: (values.types ?? values.type) as string | undefined,
    apply: values.apply === true,
    includeChildren: values['include-children'] === true,
    generateOnly: values['generate-only'] === true,
    overwriteModel: values['overwrite-model'] === true,
    skipGenerate: values['skip-generate'] === true,
    disableAi: values['disable-ai'] === true,
    operationIds: (values['operation-id'] ?? []) as string[],
    renames: ((values.rename ?? []) as string[]).map(value =>
      JSON.parse(value)
    ),
    logsPage: positiveInteger(
      '--logs-page',
      String(values['logs-page'] ?? '1')
    ),
    logsPageSize: pageSize,
    limit: positiveInteger('--limit', String(values.limit ?? pageSize)),
    keyword: values.keyword as string | undefined,
    raw: values.raw === true,
  };
}

export function maintenanceHelp(command: MaintenanceArgs['command']): string {
  switch (command) {
    case 'train-openapi':
      return `Usage: flow train-openapi [spec-file-or-folder] --context namespace.apis.{file}
Options: --operation-id ID (repeatable), --disable-ai, --rename FROM TO (repeatable),
  --generate-only, --overwrite-model, --skip-generate, --dry-run
Accepts OpenAPI 3/Swagger 2 JSON/YAML; directories are searched recursively.
Operation selection retains referenced schemas. Descriptions become plain text.
Writes *.poly.json models; existing models require --overwrite-model.
Alias: train:openapi. Dry runs do not call PolyAPI or write models.`;
    case 'train-model':
      return `Usage: flow train-model [model-file] [--skip-generate] [--dry-run]
Validate and train a saved *.poly.json or legacy *.poly-model.json, then regenerate SDK.`;
    case 'delete-content':
      return `Usage: flow delete-content --types api-functions,schemas --context namespace.prefix
Options: --include-children, --apply, --dry-run
Preview only by default, exact context only. --apply requires typing DELETE.
Every deletion is verified with a 404 readback. --type remains an alias for --types.
Types: api-functions,client-functions,server-functions,ai-functions,schemas,variables,webhooks,triggers,tables,jobs,subscriptions.
Alias: delete:content. Singular type names remain supported.`;
    case 'logs':
      return `Usage: flow logs [function-id] [--logs-page 1] [--logs-page-size 100] [--keyword error] [--limit 100] [--raw]
Prompts for a missing function ID; the log limit defaults to the page size.`;
  }
}

export function createMaintenanceRuntime(
  workspaceRoot: string,
  invocationDirectory: string
): MaintenanceRuntime {
  const client = createPolyApiClient();
  // The checked-in REST types omit the AI-function routes already used by Flow.
  // Broaden only the metadata methods; retain this client's authentication/OTP middleware.
  const metadata = client as {
    GET(
      path: string,
      options?: Record<string, any>
    ): Promise<{ data?: any; error?: unknown; response: Response }>;
    DELETE(
      path: string,
      options: Record<string, any>
    ): Promise<{ error?: unknown; response: Response }>;
  };
  const workflows = path.join(workspaceRoot, 'workflows');
  const run = (args: string[]) => {
    // Keep spec paths and contexts as arguments, including on Windows.
    const entry = process.env.npm_execpath;
    const useNode = Boolean(entry && /pnpm.*\.(?:c?js|mjs)$/i.test(entry));
    if (process.platform === 'win32' && !useNode) {
      throw new Error(
        'Run through pnpm flow so its Node entry point is available.'
      );
    }
    const commandArgs = ['workflows', 'exec', ...args];
    const result = spawnSync(
      useNode ? process.execPath : 'pnpm',
      useNode ? [entry as string, ...commandArgs] : commandArgs,
      {
        cwd: workspaceRoot,
        env: getPolyGenerateEnvironment({
          ...process.env,
          POLY_API_BASE_URL: getBaseUrl(),
          POLY_API_KEY: process.env.API_KEY,
          CONFIG_ENV_PATH_PRIORITY: 'false',
        }),
        stdio: 'inherit',
      }
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `${args[0]} ${args[1] ?? ''} failed${result.signal ? ` (${result.signal})` : ''}.`
      );
    }
  };
  return {
    workspaceRoot,
    invocationDirectory,
    async prompt(message) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          `${message} Supply the corresponding argument or run interactively.`
        );
      }
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return (await reader.question(`${message} `)).trim();
      } finally {
        reader.close();
      }
    },
    print: message => process.stdout.write(`${message}\n`),
    async list(type) {
      const { data, error, response } = await metadata.GET(endpoints[type], {});
      if (error !== undefined || !response.ok)
        throw new Error(`Listing ${type} failed (HTTP ${response.status}).`);
      return data;
    },
    async detail(type, id) {
      const endpoint =
        `${endpoints[type]}/{id}` as `${(typeof endpoints)[ResourceType]}/{id}`;
      const { data, error, response } = await metadata.GET(endpoint, {
        params: { path: { id } },
      });
      if (response.status === 404) return null;
      if (error !== undefined || !response.ok)
        throw new Error(
          `Reading ${type} ${id} failed (HTTP ${response.status}).`
        );
      return data as Record<string, any>;
    },
    async upsert(type, resource) {
      const endpoint = endpoints[type];
      const { error, response } = await client.PUT(endpoint, {
        body: resource as any,
      });
      if (error !== undefined || !response.ok)
        throw new Error(
          `Training ${type} ${resource.context}.${resource.name} failed (HTTP ${response.status}).`
        );
    },
    async remove(type, id) {
      const endpoint =
        `${endpoints[type]}/{id}` as `${(typeof endpoints)[ResourceType]}/{id}`;
      const { error, response } = await metadata.DELETE(endpoint, {
        params: { path: { id } },
      });
      if (error !== undefined || !response.ok)
        throw new Error(
          `Deleting ${type} ${id} failed (HTTP ${response.status}).`
        );
      const readback = await metadata.GET(endpoint, {
        params: { path: { id } },
      });
      if (readback.response.status !== 404)
        throw new Error(
          `Deletion could not be verified for ${type} ${id} (HTTP ${readback.response.status}); inspect before retrying.`
        );
    },
    async logs(id, options) {
      // The checked-in API schema omits the supported log pagination query fields.
      const params = {
        path: { id },
        query: {
          logsPage: options.logsPage,
          logsPageSize: options.logsPageSize,
          limit: options.limit,
          ...(options.keyword ? { keyword: options.keyword } : {}),
        },
      };
      const { data, error, response } = await client.GET(
        '/functions/server/{id}/logs',
        {
          params,
          parseAs: 'text',
        }
      );
      if (error !== undefined || !response.ok)
        throw new Error(`Reading logs failed (HTTP ${response.status}).`);
      return data ?? '';
    },
    runPoly: args => run(['poly', ...args]),
    convertSwagger(input, output) {
      if (
        !fs.existsSync(
          path.join(workflows, 'node_modules/.bin/swagger2openapi')
        )
      ) {
        throw new Error(
          'swagger2openapi is missing. Run pnpm install before training Swagger 2 specs.'
        );
      }
      run([
        'swagger2openapi',
        '--patch',
        '--warnOnly',
        '--resolve',
        input,
        '-o',
        output,
      ]);
    },
  };
}

export function selectResources(data: unknown, context: string): Resource[] {
  const selected = new Map<string, Resource>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.id === 'string') {
        if (
          typeof record.context === 'string' &&
          (record.context === context ||
            record.context.startsWith(`${context}.`))
        ) {
          selected.set(record.id, {
            id: record.id,
            context: record.context,
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
          });
        }
        // Resource payloads may contain nested values/references with their own IDs.
        return;
      }
      for (const child of Object.values(record)) visit(child);
    }
  }
  visit(data);
  return [...selected.values()].sort(
    (a, b) => a.context.localeCompare(b.context) || a.id.localeCompare(b.id)
  );
}

const typeAliases: Record<string, ResourceType> = {
  'api-functions': 'api',
  'client-functions': 'client',
  'server-functions': 'server',
  'ai-functions': 'ai',
  schemas: 'schema',
  variables: 'variable',
  webhooks: 'webhook',
  triggers: 'trigger',
  tables: 'table',
  jobs: 'job',
  subscriptions: 'subscription',
};
function resourceRecords(data: any): Record<string, any>[] {
  if (Array.isArray(data)) return data.flatMap(resourceRecords);
  if (!data || typeof data !== 'object') return [];
  if (typeof data.id === 'string') return [data];
  return Object.values(data).flatMap(resourceRecords);
}

export async function deleteContent(
  args: MaintenanceArgs,
  runtime: MaintenanceRuntime
): Promise<void> {
  const requested =
    args.type ??
    (await runtime.prompt(
      'Resource types (api-functions,schemas,variables,webhooks,triggers,tables,jobs):'
    ));
  const types = [
    ...new Set(
      requested.split(',').map(value => {
        const key = value.trim().toLowerCase();
        const type =
          typeAliases[key] ?? (key.replace(/s$/, '') as ResourceType);
        if (!Object.keys(endpoints).includes(type))
          throw new Error(`Unsupported resource type: ${key}`);
        return type;
      })
    ),
  ];
  const context = (
    args.context ?? (await runtime.prompt('Context to delete:'))
  ).trim();
  validateNamespace(context, 'deletion scope', context);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(context))
    throw new Error('Deletion context must contain dotted identifiers.');
  const matches = (value: string) =>
    value === context ||
    (args.includeChildren && value.startsWith(`${context}.`));
  const servers = types.some(type => type === 'job' || type === 'trigger')
    ? resourceRecords(await runtime.list('server'))
    : [];
  const serverContexts = new Map(servers.map(item => [item.id, item.context]));
  const plan: { type: ResourceType; item: Resource }[] = [];
  for (const type of types) {
    const data = await runtime.list(type);
    if (type === 'job' || type === 'trigger') {
      for (const record of resourceRecords(data)) {
        const detail = await runtime.detail(type, record.id);
        if (!detail)
          throw new Error(`Selected ${type} disappeared before preview.`);
        const ids =
          type === 'job'
            ? (detail.functions ?? []).map((item: any) => item.id)
            : [detail.serverFunctionId];
        if (
          ids.length &&
          ids.every(
            (id: string) =>
              typeof serverContexts.get(id) === 'string' &&
              matches(serverContexts.get(id))
          )
        )
          plan.push({
            type,
            item: { id: record.id, context, name: record.name },
          });
      }
    } else {
      for (const item of selectResources(data, context).filter(item =>
        matches(item.context)
      ))
        plan.push({ type, item });
    }
  }
  const priority: ResourceType[] = [
    'trigger',
    'job',
    'subscription',
    'webhook',
    'ai',
    'server',
    'client',
    'api',
    'schema',
    'variable',
    'table',
  ];
  plan.sort(
    (a, b) =>
      priority.indexOf(a.type) - priority.indexOf(b.type) ||
      a.item.id.localeCompare(b.item.id)
  );
  runtime.print(
    `${plan.length} resource(s) selected${args.includeChildren ? ' including child contexts' : ' in exact context'}:`
  );
  for (const { type, item } of plan)
    runtime.print(
      `  ${type} ${item.id} ${item.context}.${item.name ?? '(unnamed)'}`
    );
  if (!args.apply || args.dryRun) {
    runtime.print('Preview only: no resources deleted. Use --apply to delete.');
    return;
  }
  if (!plan.length) return;
  if ((await runtime.prompt('Type DELETE to confirm deletion:')) !== 'DELETE') {
    runtime.print('Aborted.');
    return;
  }
  for (const { type, item } of plan) {
    await runtime.remove(type, item.id);
    runtime.print(`Deleted ${type}: ${item.id}`);
  }
}

function findLogs(
  value: unknown
): { logs: unknown[]; metadata: Record<string, unknown> } | null {
  if (Array.isArray(value)) return { logs: value, metadata: {} };
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['logs', 'items', 'data', 'results']) {
    if (Array.isArray(record[key])) {
      return {
        logs: record[key],
        metadata: Object.fromEntries(
          Object.entries(record).filter(([name]) => name !== key)
        ),
      };
    }
  }
  for (const child of Object.values(record)) {
    const found = findLogs(child);
    if (found) return found;
  }
  return null;
}

export function formatLogs(text: string): string {
  if (!text.trim()) return '';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  const found = findLogs(value);
  if (!found) return JSON.stringify(value, null, 2);
  if (!found.logs.length) return 'No logs found.';
  const timestampKeys = [
    'timestamp',
    'time',
    'createdAt',
    'created_at',
    'date',
  ];
  const levelKeys = ['level', 'severity', 'status'];
  const messageKeys = ['message', 'msg', 'text', 'body', 'error'];
  const knownKeys = new Set([...timestampKeys, ...levelKeys, ...messageKeys]);
  const lines = [`Logs (${found.logs.length})`];
  if (Object.keys(found.metadata).length)
    lines.push('', 'Metadata', JSON.stringify(found.metadata, null, 2));
  lines.push('');
  lines.push(
    found.logs
      .map((entry, index) => {
        if (typeof entry === 'string') return entry;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          return JSON.stringify(entry, null, 2);
        const record = entry as Record<string, unknown>;
        const pick = (keys: string[]) =>
          keys
            .map(key => record[key])
            .find(item => item !== undefined && item !== null && item !== '');
        const title =
          [
            pick(timestampKeys),
            String(pick(levelKeys) ?? '').toUpperCase(),
            pick(messageKeys),
          ]
            .filter(item => item !== undefined && item !== null && item !== '')
            .map(String)
            .join(' | ') || `Log ${index + 1}`;
        const details = Object.fromEntries(
          Object.entries(record).filter(([key]) => !knownKeys.has(key))
        );
        return Object.keys(details).length
          ? `${title}\n${JSON.stringify(details, null, 2)
              .split('\n')
              .map(line => `  ${line}`)
              .join('\n')}`
          : title;
      })
      .join('\n\n')
  );
  return lines.join('\n');
}

export async function functionLogs(
  args: MaintenanceArgs,
  runtime: MaintenanceRuntime
): Promise<void> {
  const id = (args.target ?? (await runtime.prompt('Function ID:'))).trim();
  if (!id || /[\\/]/.test(id))
    throw new Error('A function ID without path separators is required.');
  const text = await runtime.logs(id, args);
  runtime.print(args.raw ? text : formatLogs(text));
}

function resolveSpecPath(input: string, runtime: MaintenanceRuntime): string {
  const candidates = path.isAbsolute(input)
    ? [input]
    : [
        path.resolve(runtime.invocationDirectory, input),
        path.resolve(runtime.workspaceRoot, input),
        path.resolve(runtime.workspaceRoot, 'workflows', input),
      ];
  const resolved = candidates.find(candidate => fs.existsSync(candidate));
  if (!resolved) throw new Error(`Spec path does not exist: ${input}`);
  return resolved;
}

function readSpec(file: string): Record<string, unknown> | null {
  if (!/\.(json|ya?ml)$/i.test(file)) {
    throw new Error('OpenAPI specs must be JSON or YAML files.');
  }
  const text = fs.readFileSync(file, 'utf8');
  let document: any;
  try {
    document = /\.ya?ml$/i.test(file) ? parseYaml(text) : JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON/YAML specification: ${file}`);
  }
  if (
    document &&
    typeof document === 'object' &&
    (document.swagger === '2.0' || /^3\./.test(document.openapi))
  ) {
    return document;
  }
  return null;
}

function readModel(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Unable to read a valid Poly model: ${file}`);
  }
}

async function verifyTraining(
  model: TrainingModel,
  runtime: MaintenanceRuntime
): Promise<void> {
  for (const [kind, type] of [
    ['functions', 'api'],
    ['schemas', 'schema'],
    ['webhooks', 'webhook'],
  ] as const) {
    if (!model[kind].length) continue;
    const actual = await runtime.list(type);
    const missing = model[kind].filter(
      resource =>
        !selectResources(actual, resource.context).some(
          item =>
            item.context === resource.context && item.name === resource.name
        )
    );
    if (missing.length)
      throw new Error(
        `Training incomplete; missing ${type} resources: ${missing.map(item => `${item.context}.${item.name}`).join(', ')}`
      );
  }
}

async function trainResources(
  model: TrainingModel,
  runtime: MaintenanceRuntime,
  dryRun: boolean
): Promise<void> {
  const batches = [
    ...schemaLayers(model.schemas).map(items => ({
      type: 'schema' as const,
      items,
    })),
    { type: 'api' as const, items: model.functions },
    { type: 'webhook' as const, items: model.webhooks },
  ];
  for (const { type, items } of batches) {
    for (let start = 0; start < items.length; start += 5) {
      const batch = items.slice(start, start + 5);
      for (const item of batch)
        runtime.print(
          `${dryRun ? 'Would train' : 'Training'} ${type}: ${item.context}.${item.name}`
        );
      if (dryRun) continue;
      // Finish this bounded batch before surfacing an error; never launch later batches on failure.
      const results = await Promise.allSettled(
        batch.map(item => runtime.upsert(type, item))
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected'
      );
      if (failure) throw failure.reason;
    }
  }
  if (!dryRun) await verifyTraining(model, runtime);
}

export async function trainSavedModel(
  args: MaintenanceArgs,
  runtime: MaintenanceRuntime
): Promise<void> {
  const file = resolveSpecPath(
    args.target ?? (await runtime.prompt('Poly model file:')),
    runtime
  );
  const model = prepareModel(readModel(file), []);
  await trainResources(model, runtime, args.dryRun);
  if (!args.dryRun && !args.skipGenerate) runtime.runPoly(['generate']);
}

export async function trainOpenApi(
  args: MaintenanceArgs,
  runtime: MaintenanceRuntime
): Promise<void> {
  const input =
    args.target ?? (await runtime.prompt('OpenAPI spec file or folder:'));
  const pattern =
    args.context ??
    (await runtime.prompt('PolyAPI context (use {file} for each spec name):'));
  const target = resolveSpecPath(input, runtime);
  const discover = (directory: string): string[] =>
    fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .flatMap(entry =>
        entry.isDirectory()
          ? discover(path.join(directory, entry.name))
          : entry.isFile() &&
              /\.(json|ya?ml)$/i.test(entry.name) &&
              !/\.poly(?:-model)?\.json$/i.test(entry.name)
            ? [path.join(directory, entry.name)]
            : []
      );
  const candidates = fs.statSync(target).isDirectory()
    ? discover(target).sort()
    : [target];
  const specs = candidates
    .map(file => ({ file, document: readSpec(file) }))
    .filter(item => item.document !== null);
  if (!specs.length)
    throw new Error('No OpenAPI 3 or Swagger 2 specifications found.');
  const outputs = new Set<string>();
  const planned = specs.map(({ file, document }) => {
    const name = path.basename(file).replace(/\.(json|ya?ml)$/i, '');
    const context = pattern.replace(
      /\{file\}/g,
      name.replace(/[^A-Za-z0-9_]/g, '_')
    );
    validateNamespace(context, 'OpenAPI model', name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(context))
      throw new Error('Training context must contain dotted identifiers.');
    const model = path.join(path.dirname(file), `${name}.poly.json`);
    if (outputs.has(model))
      throw new Error(
        'Multiple specifications would overwrite the same model file.'
      );
    outputs.add(model);
    if (
      !args.dryRun &&
      !args.overwriteModel &&
      (fs.existsSync(model) ||
        fs.existsSync(path.join(path.dirname(file), `${name}.poly-model.json`)))
    )
      throw new Error(
        `Model already exists for ${file}; use train-model or --overwrite-model.`
      );
    if (!document) throw new Error(`Invalid OpenAPI document: ${file}`);
    const selected = selectOperations(document, args.operationIds);
    const normalized = normalizeOpenApiSchemaNames(selected);
    for (const rename of normalized.renames)
      runtime.print(`PolyAPI schema name: ${rename}`);
    runtime.print(
      `${file} -> ${context}${args.operationIds.length ? ` (operations: ${args.operationIds.join(', ')})` : ''}`
    );
    return {
      file,
      document: cleanDescriptions(normalized.document),
      context,
      model,
    };
  });
  if (args.dryRun) {
    runtime.print('Dry run: no models written or trained.');
    return;
  }
  const generatedModels: { file: string; model: TrainingModel }[] = [];
  for (const plan of planned) {
    const directory = path.dirname(plan.file);
    const temporarySpec = path.join(directory, `.flow-${randomUUID()}.json`);
    const convertedSpec = path.join(
      directory,
      `.flow-${randomUUID()}.oas3.json`
    );
    const temporaryModel = path.join(
      directory,
      `.flow-${randomUUID()}.model.json`
    );
    try {
      fs.writeFileSync(temporarySpec, JSON.stringify(plan.document), {
        flag: 'wx',
      });
      let spec = temporarySpec;
      if (plan.document.swagger === '2.0') {
        runtime.convertSwagger(temporarySpec, convertedSpec);
        spec = convertedSpec;
      }
      runtime.runPoly([
        'model',
        'generate',
        spec,
        temporaryModel,
        '--context',
        plan.context,
        '--hostUrlAsArgument',
        ...(args.disableAi ? ['--disable-ai'] : []),
      ]);
      if (!fs.existsSync(temporaryModel))
        throw new Error(`Poly did not generate a model for ${plan.file}.`);
      generatedModels.push({
        file: plan.model,
        model: prepareModel(readModel(temporaryModel), args.renames),
      });
    } finally {
      for (const file of [temporarySpec, convertedSpec, temporaryModel])
        fs.rmSync(file, { force: true });
    }
  }
  const combined = validateModel(
    Object.fromEntries(
      ['functions', 'schemas', 'webhooks'].map(kind => [
        kind,
        generatedModels.flatMap(
          item => item.model[kind as keyof TrainingModel]
        ),
      ])
    )
  );
  for (const { file, model } of generatedModels) {
    if (!args.overwriteModel && fs.existsSync(file))
      throw new Error(
        `Model appeared during generation: ${file}; inspect it before retrying with --overwrite-model.`
      );
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(model, null, 2)}\n`, {
        flag: 'wx',
      });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    runtime.print(`Saved model: ${file}`);
  }
  if (!args.generateOnly) {
    await trainResources(combined, runtime, false);
    if (!args.skipGenerate) runtime.runPoly(['generate']);
  }
}

export async function runMaintenance(
  args: MaintenanceArgs,
  runtime: MaintenanceRuntime
): Promise<void> {
  switch (args.command) {
    case 'train-openapi':
      return trainOpenApi(args, runtime);
    case 'train-model':
      return trainSavedModel(args, runtime);
    case 'delete-content':
      return deleteContent(args, runtime);
    case 'logs':
      return functionLogs(args, runtime);
  }
}
