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

const endpoints = {
  api: '/functions/api',
  schema: '/schemas',
  variable: '/variables',
  webhook: '/webhooks',
  trigger: '/triggers',
  table: '/tables',
  job: '/jobs',
} as const;

export type ResourceType = keyof typeof endpoints;
export interface Resource {
  id: string;
  context: string;
  name?: string;
}
export interface MaintenanceArgs {
  command: 'train:openapi' | 'delete:content' | 'logs';
  help: boolean;
  dryRun: boolean;
  target?: string;
  context?: string;
  type?: string;
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
  const [command, ...rest] = argv.filter(argument => argument !== '--');
  if (!['train:openapi', 'delete:content', 'logs'].includes(command))
    return null;
  const options: Record<
    string,
    { type: 'string' | 'boolean'; short?: string }
  > = {
    help: { type: 'boolean', short: 'h' },
    ...(command === 'logs'
      ? {
          'logs-page': { type: 'string' },
          'logs-page-size': { type: 'string' },
          limit: { type: 'string' },
          keyword: { type: 'string' },
          raw: { type: 'boolean' },
        }
      : {
          context: { type: 'string' },
          'dry-run': { type: 'boolean' },
          ...(command === 'delete:content' ? { type: { type: 'string' } } : {}),
        }),
  };
  const { values, positionals } = parseArgs({
    args: rest,
    options,
    allowPositionals: true,
  });
  if (positionals.length > (command === 'delete:content' ? 0 : 1)) {
    throw new Error(
      `Unexpected argument(s) for flow ${command}. Use --help for usage.`
    );
  }
  const pageSize = positiveInteger(
    '--logs-page-size',
    String(values['logs-page-size'] ?? '100')
  );
  return {
    command: command as MaintenanceArgs['command'],
    help: values.help === true,
    dryRun: values['dry-run'] === true,
    target: positionals[0],
    context: values.context as string | undefined,
    type: values.type as string | undefined,
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
    case 'train:openapi':
      return `Usage: flow train:openapi [spec-file-or-folder] [--context namespace.apis.{file}] [--dry-run]
Prompts for missing inputs. Accepts OpenAPI 3 or Swagger 2 JSON/YAML.
Creates model JSON beside each source spec, trains it, then regenerates the SDK.
--dry-run previews specs and contexts without writing files or calling PolyAPI.`;
    case 'delete:content':
      return `Usage: flow delete:content [--type api|schema|variable|webhook|trigger|table|job] [--context namespace.prefix] [--dry-run]
Prompts for missing inputs. Matches the exact context and its dot-separated children.
Previews matching resources and requires typing DELETE before deleting.
--dry-run lists matches without deleting. Context must belong to a configured namespace.`;
    case 'logs':
      return `Usage: flow logs [function-id] [--logs-page 1] [--logs-page-size 100] [--keyword error] [--limit 100] [--raw]
Prompts for a missing function ID. --limit defaults to --logs-page-size.
Uses the selected Flow environment; --raw prints the original response.`;
  }
}

export function createMaintenanceRuntime(
  workspaceRoot: string,
  invocationDirectory: string
): MaintenanceRuntime {
  const client = createPolyApiClient();
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
      const { data, error, response } = await client.GET(endpoints[type]);
      if (error !== undefined || !response.ok)
        throw new Error(`Listing ${type} failed (HTTP ${response.status}).`);
      return data;
    },
    async remove(type, id) {
      const endpoint =
        `${endpoints[type]}/{id}` as `${(typeof endpoints)[ResourceType]}/{id}`;
      const { error, response } = await client.DELETE(endpoint, {
        params: { path: { id } },
      });
      if (error !== undefined || !response.ok)
        throw new Error(
          `Deleting ${type} ${id} failed (HTTP ${response.status}).`
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

export async function deleteContent(
  args: MaintenanceArgs,
  runtime: MaintenanceRuntime
): Promise<void> {
  const requestedType = (
    args.type ??
    (await runtime.prompt(
      'Resource type (api/schema/variable/webhook/trigger/table/job):'
    ))
  ).toLowerCase();
  const type = requestedType.replace(/s$/, '') as ResourceType;
  if (!Object.keys(endpoints).includes(type))
    throw new Error(`Unsupported resource type: ${requestedType}`);
  const context = (
    args.context ?? (await runtime.prompt('Context prefix:'))
  ).trim();
  validateNamespace(context, 'deletion scope', context);
  const resources = selectResources(await runtime.list(type), context);
  if (resources.length === 0) {
    runtime.print(`No ${type} resources found under context: ${context}`);
    return;
  }
  runtime.print(`Found ${resources.length} matching ${type} resource(s):`);
  for (const item of resources)
    runtime.print(`  ${item.id}  ${item.context}.${item.name ?? '(unnamed)'}`);
  if (args.dryRun) {
    runtime.print('Dry run: no resources deleted.');
    return;
  }
  if ((await runtime.prompt('Type DELETE to confirm deletion:')) !== 'DELETE') {
    runtime.print('Aborted.');
    return;
  }
  for (const item of resources) {
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
  const document = /\.ya?ml$/i.test(file) ? parseYaml(text) : JSON.parse(text);
  if (
    document &&
    typeof document === 'object' &&
    (document.swagger === '2.0' || /^3\./.test(document.openapi))
  ) {
    return document;
  }
  return null;
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
  const isDirectory = fs.statSync(target).isDirectory();
  const candidates = isDirectory
    ? fs
        .readdirSync(target, { withFileTypes: true })
        .filter(
          entry =>
            entry.isFile() &&
            !entry.name.startsWith('.') &&
            !entry.name.endsWith('.poly-model.json') &&
            /\.(json|ya?ml)$/i.test(entry.name)
        )
        .map(entry => path.join(target, entry.name))
        .sort()
    : [target];
  const specs = candidates
    .map(file => ({ file, document: readSpec(file) }))
    .filter(item => item.document !== null);
  if (!specs.length)
    throw new Error('No OpenAPI 3 or Swagger 2 specifications found.');
  const planned = specs.map(({ file, document }) => {
    const name = path.basename(file).replace(/\.(json|ya?ml)$/i, '');
    const context = pattern.replace(/\{file\}/g, name);
    validateNamespace(context, 'OpenAPI model', name);
    return {
      file,
      document: document as Record<string, unknown>,
      context,
      name,
    };
  });
  for (const { file, context } of planned)
    runtime.print(`${file} -> ${context}`);
  if (args.dryRun) {
    runtime.print('Dry run: no models written or trained.');
    return;
  }
  for (const { file, document, context, name } of planned) {
    const directory = path.dirname(file);
    const temporarySpec = path.join(directory, `.flow-${randomUUID()}.json`);
    const convertedSpec = path.join(
      directory,
      `.flow-${randomUUID()}.oas3.json`
    );
    const temporaryModel = path.join(
      directory,
      `.flow-${randomUUID()}.model.json`
    );
    const model = path.join(directory, `${name}.poly-model.json`);
    try {
      fs.writeFileSync(
        temporarySpec,
        `${JSON.stringify(document, null, 2)}\n`,
        { flag: 'wx' }
      );
      let spec = temporarySpec;
      if (document.swagger === '2.0') {
        runtime.convertSwagger(temporarySpec, convertedSpec);
        spec = convertedSpec;
      }
      runtime.runPoly([
        'model',
        'generate',
        spec,
        temporaryModel,
        '--context',
        context,
        '--hostUrlAsArgument',
      ]);
      if (!fs.existsSync(temporaryModel))
        throw new Error(`Poly did not generate a model for ${file}.`);
      const generated = JSON.parse(fs.readFileSync(temporaryModel, 'utf8'));
      let resources = 0;
      for (const kind of ['functions', 'schemas', 'webhooks']) {
        for (const resource of generated[kind] ?? []) {
          validateNamespace(resource.context, kind, resource.name ?? name);
          resources += 1;
        }
      }
      if (!resources)
        throw new Error(
          `Generated model contains no trainable resources: ${file}`
        );
      fs.renameSync(temporaryModel, model);
      runtime.print(`Training ${model}`);
      runtime.runPoly(['model', 'train', model]);
    } finally {
      for (const temporary of [temporarySpec, convertedSpec, temporaryModel])
        fs.rmSync(temporary, { force: true });
    }
  }
  runtime.runPoly(['generate']);
}

export async function runMaintenance(
  args: MaintenanceArgs,
  runtime: MaintenanceRuntime
): Promise<void> {
  switch (args.command) {
    case 'train:openapi':
      return trainOpenApi(args, runtime);
    case 'delete:content':
      return deleteContent(args, runtime);
    case 'logs':
      return functionLogs(args, runtime);
  }
}
