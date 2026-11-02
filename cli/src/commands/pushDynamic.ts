/**
 * `flow push-dynamic` — `flow push` whose function step follows the call graph.
 *
 * Deviation from upstream Flow (which has no notion of function dependencies).
 * The command runs the same pipeline as `push` (discovery, validation, every
 * artefact type in the same order, summary, post-push generate); only the
 * functions step is replaced by the plan/confirm/execute trio below, which
 *
 *  1. builds the local call graph over every function file (utils/functionGraph),
 *  2. determines the seeds — functions named on the command line (forced:
 *     deployed even when unchanged; automatic detection is then off unless
 *     `--seed-from` or `--paths` says otherwise), or, when nothing is named,
 *     every function (under `--paths`, if given) whose code differs from the
 *     target environment (`--seed-from remote`; `specs` compares against the
 *     generated SDK cache offline); intermediate CFXs inside the trees that
 *     were not compared yet are compared too and promoted when they differ,
 *  3. expands each seed to its transitive client-function callers up to the
 *     first server function on every path (server functions are leaves; code
 *     never propagates through an HTTP call), merging overlapping trees,
 *  4. validates every function the plan deploys, prints the tree and an
 *     ordered plan (callees before callers) and, unless `--dry-run`, deploys it
 *     through the same `poly function add` path `flow push` uses; the pipeline
 *     then runs `poly generate` once.
 *
 * The whole tree is deployed by default: seeds, the intermediate client
 * functions between them and their leaves, and the server-function leaves.
 * `--skip-unchanged-cfx` leaves out intermediates whose deployed code is
 * byte-identical (their code is resolved inside each leaf's bundle from their
 * own spec, so re-adding them is a no-op on the platform); when nothing could
 * be compared they are re-added regardless. Server-function leaves that are
 * `alwaysOn` or deployed with `cachePolyLibrary` are flagged MUST — their pod
 * never recycles, so a redeploy is the only way new client code reaches them.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type createClient from 'openapi-fetch';
import {
  addFunction,
  deleteClientFunction,
  deleteServerFunction,
  findFunctionFiles,
  fingerprintApiKey,
  getExistingFunctionDetails,
  locatePolyDir,
  normalizeMultilineText,
  readPolyGenerateProvenance,
} from '../artefacts/functions';
import type { paths } from '../sdk/schema';
import type { FunctionFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getBaseUrl, sleep } from '../utils/apiClient';
import { getPolyprodExecKey, pathIsExcluded } from '../utils/deploymentConfig';
import { getProjectRoot } from '../utils/fileSystem';
import {
  buildFunctionGraph,
  type Closure,
  computeClosure,
  computeHubs,
  explainPaths,
  type FunctionGraph,
  functionKey,
  orderForDeploy,
  renderTree,
  selectDeploySet,
} from '../utils/functionGraph';
import { chalk, logger, warningColor } from '../utils/logger';
import {
  matchesAnyRequiredNamespace,
  validateNamespace,
} from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { validateFunctionArtifact } from '../utils/validation';
import {
  expandWildcardReferences,
  type WildcardExpansion,
} from '../utils/wildcardEdges';

type PolyClient = ReturnType<typeof createClient<paths>>;

export type SeedSource = 'remote' | 'specs' | 'none';

export interface PushDynamicArgs {
  dryRun: boolean;
  /** Forced seeds: function files, directories or `context.name` identities. */
  seeds: string[];
  /** `--paths`: restrict automatic change detection to these files/directories/workflow names. */
  scopePaths: string[];
  seedFrom: SeedSource;
  /** Leave out intermediate CFXs whose deployed code is identical (default: deploy the whole tree). */
  skipUnchangedCfx: boolean;
  /** Report only: expand the printed tree past server functions. Never changes the deploy set. */
  throughSfx: boolean;
  json: boolean;
  yes: boolean;
  maxLeaves: number;
  executionApiKey?: string;
  skipGenerate: boolean;
  why?: string;
  hubs: boolean;
  /** EXPERIMENTAL (utils/wildcardEdges.ts): expand computed access to every matching function. */
  experimentalWildcards: boolean;
  /** `--skip-validation "I know what am doing"`: non-interactive acknowledgement of the branch/env and production prompts. */
  skipValidationAcknowledged: boolean;
  verbose: boolean;
}

export interface PushDynamicContext {
  client: PolyClient;
  projectRoot: string;
  workspaceRoot: string;
  /** Directory the operator ran the command from (pnpm's INIT_CWD), for relative paths. */
  invocationCwd: string;
  productionSensitive: boolean;
  envDisplayPath: string;
  currentBranch: string;
  confirm: (prompt: string) => Promise<string>;
  /** Whether the run syncs artefact types other than functions (for the prompt wording). */
  syncsOtherArtefacts: boolean;
  /** --delete-orphans: planned function orphans are deleted, so they need confirming. */
  deletesOrphans: boolean;
}

interface RemoteFunctionInfo {
  id: string;
  type: FunctionFile['type'];
  name: string;
  context: string;
  alwaysOn: boolean;
  cachePolyLibrary: boolean;
  revision?: number;
  logsEnabled?: boolean;
}

type SeedKind = 'forced' | 'update' | 'create';

/** A deployed function with no local file; carries its own type so deletion hits the right endpoint. */
interface FunctionOrphan extends OrphanedResource {
  functionType: FunctionFile['type'];
}

interface Seed {
  key: string;
  kind: SeedKind;
  detail: string;
}

const EXECUTION_API_KEY_ENV = 'FLOW_EXECUTION_API_KEY';
const WHY_LIMIT = 25;

function remoteKey(type: FunctionFile['type'], key: string): string {
  return `${type}:${key}`;
}

function keyOf(file: FunctionFile): string {
  return functionKey(file.metadata.context, file.metadata.name);
}

function typeLabel(type: FunctionFile['type']): string {
  return type === 'server' ? 'SFX' : 'CFX';
}

function isInside(target: string, parent: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Resolve a path the operator typed: relative to where they ran the command
 * (pnpm's INIT_CWD), else to the CLI's cwd (workflows/), else to the workspace
 * root — the first that exists wins, so `.` means the current directory — and
 * only then as a bare workflow name. `./workflows/src/…`, `workflows/src/…`,
 * `src/…`, `sampleWorkflow` and absolute paths all work.
 */
function resolveUserPaths(item: string, context: PushDynamicContext): string[] {
  for (const base of [
    context.invocationCwd,
    context.projectRoot,
    context.workspaceRoot,
  ]) {
    const candidate = path.resolve(base, item);
    if (existsSync(candidate)) {
      return [candidate];
    }
  }
  // A bare workflow name (`sampleWorkflow`), as `flow push --paths` accepts it.
  const candidates = [
    path.resolve(context.projectRoot, 'src', item),
    path.resolve(context.workspaceRoot, 'workflows', 'src', item),
  ];
  return [...new Set(candidates)].filter(candidate => existsSync(candidate));
}

/** Function files that are one of the resolved paths or live under one of them. */
function matchFiles(
  files: FunctionFile[],
  resolvedPaths: string[]
): FunctionFile[] {
  return files.filter(file => {
    const filePath = path.resolve(file.tsFilePath);
    return resolvedPaths.some(resolved =>
      statSync(resolved).isDirectory()
        ? isInside(filePath, resolved)
        : filePath === resolved
    );
  });
}

function relativeToWorkspace(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Strict listing: unlike the shared helpers used by `push` (which swallow
 * errors into an empty list), a failed list call must not be mistaken for
 * "nothing deployed" — that would turn every function into a `create` seed.
 */
async function listFunctions(
  client: PolyClient,
  type: FunctionFile['type']
): Promise<any[] | null> {
  try {
    const result = (
      type === 'server'
        ? await client.GET('/functions/server', {})
        : await client.GET('/functions/client', {})
    ) as { data?: unknown; error?: unknown; response?: { status?: number } };
    if (result.error || !result.data) {
      logger.warn(
        warningColor(
          `  [WARN] GET /functions/${type} failed (status ${result.response?.status ?? 'n/a'})`
        )
      );
      return null;
    }
    return result.data as any[];
  } catch (error) {
    logger.warn(
      warningColor(
        `  [WARN] GET /functions/${type} failed: ${(error as Error)?.message ?? String(error)}`
      )
    );
    return null;
  }
}

async function fetchRemoteInventory(
  client: PolyClient
): Promise<Map<string, RemoteFunctionInfo> | null> {
  const [servers, clients] = await Promise.all([
    listFunctions(client, 'server'),
    listFunctions(client, 'client'),
  ]);
  if (!servers || !clients) {
    return null;
  }

  const inventory = new Map<string, RemoteFunctionInfo>();
  const register = (type: FunctionFile['type'], remote: any): void => {
    if (!matchesAnyRequiredNamespace(remote?.context)) {
      return;
    }
    inventory.set(remoteKey(type, functionKey(remote.context, remote.name)), {
      id: remote.id,
      type,
      name: remote.name,
      context: remote.context,
      alwaysOn: remote.alwaysOn === true,
      cachePolyLibrary: remote.cachePolyLibrary === true,
      revision:
        typeof remote.revision === 'number' ? remote.revision : undefined,
      logsEnabled:
        typeof remote.logsEnabled === 'boolean'
          ? remote.logsEnabled
          : undefined,
    });
  };
  for (const remote of servers) {
    register('server', remote);
  }
  for (const remote of clients) {
    register('client', remote);
  }
  return inventory;
}

function resolveExplicitSeeds(
  items: string[],
  files: FunctionFile[],
  graph: FunctionGraph,
  context: PushDynamicContext
): { seeds: Seed[]; errors: string[] } {
  const seeds: Seed[] = [];
  const errors: string[] = [];

  for (const rawItem of items) {
    const item = rawItem.trim();
    if (!item) {
      continue;
    }

    const found = resolveUserPaths(item, context);

    if (found.length > 0) {
      const matches = matchFiles(files, found);
      if (matches.length === 0) {
        errors.push(
          `${item}: no function file with a polyConfig under client/ or server/ found there`
        );
        continue;
      }
      for (const match of matches) {
        seeds.push({
          key: keyOf(match),
          kind: 'forced',
          detail: `--seeds ${item}`,
        });
      }
      continue;
    }

    const key = [...graph.nodes.keys()].find(
      candidate => candidate.toLowerCase() === item.toLowerCase()
    );
    if (key) {
      seeds.push({ key, kind: 'forced', detail: `--seeds ${item}` });
      continue;
    }

    errors.push(
      `${item}: neither an existing path nor a known function identity (context.name)`
    );
  }

  return { seeds, errors };
}

/** Function files under the given --paths scopes (already resolved to existing paths by the CLI). */
function resolveScope(
  items: string[],
  files: FunctionFile[],
  context: PushDynamicContext
): { files: FunctionFile[]; errors: string[] } {
  const selected = new Map<string, FunctionFile>();
  const errors: string[] = [];
  for (const rawItem of items) {
    const item = rawItem.trim();
    if (!item) {
      continue;
    }
    const found = resolveUserPaths(item, context);
    if (found.length > 0) {
      // A scope directory without function files is fine (artefacts only):
      // nothing to compare there.
      for (const match of matchFiles(files, found)) {
        selected.set(keyOf(match), match);
      }
      continue;
    }
    errors.push(`${item}: no such file or directory`);
  }
  return { files: [...selected.values()], errors };
}

async function detectRemoteSeeds(
  client: PolyClient,
  files: FunctionFile[],
  inventory: Map<string, RemoteFunctionInfo>,
  concurrency: number = 6
): Promise<Seed[]> {
  const seeds: Seed[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      const key = keyOf(file);
      const info = inventory.get(remoteKey(file.type, key));

      if (!info) {
        seeds.push({
          key,
          kind: 'create',
          detail: 'not deployed in the target environment',
        });
        continue;
      }

      const details = await getExistingFunctionDetails(client, {
        id: info.id,
        name: file.metadata.name,
        context: file.metadata.context,
        _functionType: file.type,
      });
      if (!details) {
        seeds.push({
          key,
          kind: 'update',
          detail: 'deployed code could not be fetched (fail-open)',
        });
        continue;
      }

      const localCode = normalizeMultilineText(
        readFileSync(file.tsFilePath, 'utf8')
      );
      const deployedCode = normalizeMultilineText(
        typeof details.code === 'string' ? details.code : ''
      );
      if (localCode !== deployedCode) {
        seeds.push({
          key,
          kind: 'update',
          detail: `code differs (local ${localCode.length} chars, deployed ${deployedCode.length} chars)`,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, () => worker())
  );
  return seeds.sort((left, right) => left.key.localeCompare(right.key));
}

function readConfigValue(configPath: string, name: string): string | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  for (const line of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0 && line.slice(0, separator).trim() === name) {
      return line.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function detectSpecsSeeds(
  files: FunctionFile[],
  workspaceRoot: string
): { seeds: Seed[]; notes: string[] } {
  const polyDir = locatePolyDir(workspaceRoot);
  if (!polyDir) {
    throw new Error(
      'The polyapi package could not be resolved (install the workflows dependencies), so no specs cache can be read — use --seed-from remote.'
    );
  }
  const specsPath = path.join(polyDir, 'lib', 'specs.json');
  if (!existsSync(specsPath)) {
    throw new Error(
      `No generated SDK specs cache at ${specsPath} — run \`npx poly generate\` first or use --seed-from remote.`
    );
  }

  const notes: string[] = [];
  const generatedAt = statSync(specsPath).mtime;
  notes.push(
    `specs cache: ${relativeToWorkspace(workspaceRoot, specsPath)} (generated ${generatedAt.toISOString()})`
  );

  // Which environment the cache belongs to: the provenance this CLI writes
  // after its own `poly generate` is authoritative; otherwise fall back to the
  // key in the poly CLI's config file (only right when `npx poly generate`
  // was run with that key).
  const apiKey = process.env.API_KEY;
  const provenance = readPolyGenerateProvenance(polyDir);
  if (provenance?.keyFingerprint && apiKey) {
    if (provenance.keyFingerprint === fingerprintApiKey(apiKey)) {
      notes.push(
        `specs cache was generated for this env file's key (${provenance.generatedAt})`
      );
    } else {
      notes.push(
        'WARNING: the specs cache was generated for a DIFFERENT API key than the selected env file — its deployed code belongs to another environment'
      );
    }
  } else {
    const configKey = readConfigValue(
      path.join(polyDir, '.config.env'),
      'POLY_API_KEY'
    );
    if (configKey && apiKey && configKey !== apiKey) {
      notes.push(
        'WARNING: the poly CLI config key differs from the selected env file — the specs cache may belong to another environment'
      );
    } else {
      notes.push(
        'specs cache environment unknown (no Flow provenance); it matches whatever `poly generate` last ran against'
      );
    }
  }

  const specs = JSON.parse(readFileSync(specsPath, 'utf8')) as Array<
    Record<string, unknown>
  >;
  const deployedCode = new Map<string, string>();
  for (const spec of specs) {
    const type: FunctionFile['type'] | null =
      spec.type === 'customFunction'
        ? 'client'
        : spec.type === 'serverFunction'
          ? 'server'
          : null;
    if (!type || typeof spec.contextName !== 'string') {
      continue;
    }
    deployedCode.set(
      remoteKey(type, spec.contextName),
      typeof spec.sourceCode === 'string' ? spec.sourceCode : ''
    );
  }

  const seeds: Seed[] = [];
  for (const file of files) {
    const key = keyOf(file);
    const deployed = deployedCode.get(remoteKey(file.type, key));
    if (deployed === undefined) {
      seeds.push({
        key,
        kind: 'create',
        detail: 'not present in the specs cache',
      });
      continue;
    }
    const localCode = normalizeMultilineText(
      readFileSync(file.tsFilePath, 'utf8')
    );
    const cachedCode = normalizeMultilineText(deployed);
    if (localCode !== cachedCode) {
      seeds.push({
        key,
        kind: 'update',
        detail: `code differs from the specs cache (local ${localCode.length} chars, cached ${cachedCode.length} chars)`,
      });
    }
  }

  return {
    seeds: seeds.sort((left, right) => left.key.localeCompare(right.key)),
    notes,
  };
}

function mergeSeeds(explicit: Seed[], detected: Seed[]): Seed[] {
  const merged = new Map<string, Seed>();
  for (const seed of detected) {
    merged.set(seed.key, seed);
  }
  for (const seed of explicit) {
    const existing = merged.get(seed.key);
    merged.set(
      seed.key,
      existing
        ? { ...seed, detail: `${seed.detail}; ${existing.detail}` }
        : seed
    );
  }
  return [...merged.values()].sort((left, right) =>
    left.key.localeCompare(right.key)
  );
}

function printHubs(graph: FunctionGraph, json: boolean): void {
  const hubs = computeHubs(graph);
  if (json) {
    writeJson({ hubs });
    return;
  }
  logger.info(
    chalk.cyan.bold(
      '[HUBS] client functions by blast radius (transitive CFX callers / SFX leaves)'
    )
  );
  for (const entry of hubs) {
    const sfx = String(entry.sfxLeaves).padStart(3);
    const cfx = String(entry.cfxCallers).padStart(3);
    logger.info(`  ${sfx} SFX  ${cfx} CFX  ${entry.key}`);
  }
}

export interface PushDynamicPlan {
  graph: FunctionGraph;
  closure: Closure;
  /** Deploy order (callees first), restricted to the deploy set. */
  order: string[];
  seeds: Seed[];
  leaves: string[];
  mustLeaves: string[];
  filesByKey: Map<string, FunctionFile>;
  inventory: Map<string, RemoteFunctionInfo> | null;
  flagExecutionApiKey?: string;
  /** Functions compared with the target, found unchanged and left out of the deploy (summary "skipped"). */
  unchanged: number;
  /** Deployed functions with no local file (only when orphan detection is on). */
  orphans: FunctionOrphan[];
}

export type PushDynamicPlanResult =
  | { kind: 'exit'; exitCode: number }
  | { kind: 'plan'; plan: PushDynamicPlan };

export interface PlanOptions {
  /** Report deployed functions that have no local file (push does this for unscoped runs). */
  detectOrphans: boolean;
}

/**
 * Build and print the function plan: graph, seeds, tree, ordered deploys.
 * Report-only modes (--hubs, --why) and errors come back as an exit code;
 * otherwise the plan is returned for confirmation and execution.
 */
export async function planPushDynamic(
  args: PushDynamicArgs,
  context: PushDynamicContext,
  options: PlanOptions
): Promise<PushDynamicPlanResult> {
  const files = findFunctionFiles({ respectSkipPaths: false });
  if (files.length === 0) {
    logger.error(
      'No function TypeScript files with polyConfig found in src/**/server/ or src/**/client/'
    );
    return { kind: 'exit', exitCode: 1 };
  }

  const filesByKey = new Map(files.map(file => [keyOf(file), file]));
  // POLY_DEPLOY_SKIP_PATHS (honoured by `push`): such functions stay in the
  // graph so the tree is complete, but are never seeded or deployed.
  const skippedKeys = new Set(
    files
      .filter(file => pathIsExcluded(file.tsFilePath, getProjectRoot()))
      .map(keyOf)
  );
  const deployableFiles = files.filter(file => !skippedKeys.has(keyOf(file)));
  const graph = buildFunctionGraph(files, filePath =>
    readFileSync(filePath, 'utf8')
  );
  const clientCount = [...graph.nodes.values()].filter(
    node => node.type === 'client'
  ).length;

  logger.info(chalk.cyan.bold('[GRAPH]'));
  logger.info(
    chalk.gray(
      `  ${graph.nodes.size} functions (${clientCount} CFX / ${graph.nodes.size - clientCount} SFX) · ${graph.edgeCount} edges · ${graph.externalRefs.size} external poly.* references ignored`
    )
  );
  for (const warning of graph.warnings) {
    logger.warn(warningColor(`  [WARN] ${warning}`));
  }

  // EXPERIMENTAL — see utils/wildcardEdges.ts; delete this block to remove the feature.
  let wildcardExpansion: WildcardExpansion | null = null;
  if (args.experimentalWildcards) {
    wildcardExpansion = expandWildcardReferences(graph, filePath =>
      readFileSync(filePath, 'utf8')
    );
    logger.info(
      warningColor(
        `  [EXPERIMENTAL] wildcard expansion: ${wildcardExpansion.added.length} edge(s) added for computed poly.* access (${graph.edgeCount} edges now)`
      )
    );
    for (const edge of wildcardExpansion.added) {
      logger.info(
        chalk.gray(
          `    poly.${edge.ref} in ${edge.from} → ${edge.to} (${edge.reason} match)`
        )
      );
    }
    for (const miss of wildcardExpansion.unmatched) {
      logger.info(
        chalk.gray(
          `    poly.${miss.ref} in ${relativeToWorkspace(context.workspaceRoot, miss.file)} → no local function matches`
        )
      );
    }
  }

  if (args.hubs) {
    printHubs(graph, args.json);
    return { kind: 'exit', exitCode: 0 };
  }

  logger.info(chalk.cyan.bold('[REMOTE]'));
  logger.info(
    chalk.gray(`  listing deployed functions at ${getBaseUrl()} ...`)
  );
  const inventory = await fetchRemoteInventory(context.client);
  if (!inventory) {
    if (args.seedFrom === 'remote') {
      logger.error(
        'Could not list deployed functions from the API; cannot detect changed functions (--seed-from remote).'
      );
      return { kind: 'exit', exitCode: 1 };
    }
    logger.warn(
      warningColor(
        '  [WARN] Could not list deployed functions; revision/alwaysOn annotations are unavailable'
      )
    );
  }

  const explicit = resolveExplicitSeeds(args.seeds, files, graph, context);
  for (const seed of explicit.seeds) {
    if (skippedKeys.has(seed.key)) {
      explicit.errors.push(
        `${seed.key} is excluded by POLY_DEPLOY_SKIP_PATHS and cannot be a seed`
      );
    }
  }
  for (const error of explicit.errors) {
    logger.error(`  --seeds: ${error}`);
  }
  if (explicit.errors.length > 0) {
    return { kind: 'exit', exitCode: 1 };
  }

  // --paths scopes WHERE automatic seeds are looked for; the closure is never scoped.
  const scopeLabels = args.scopePaths.map(scope =>
    path.isAbsolute(scope)
      ? relativeToWorkspace(context.workspaceRoot, scope)
      : scope
  );
  let detectionFiles = deployableFiles;
  if (args.scopePaths.length > 0) {
    const scope = resolveScope(args.scopePaths, files, context);
    for (const error of scope.errors) {
      logger.error(`  --paths: ${error}`);
    }
    if (scope.errors.length > 0) {
      return { kind: 'exit', exitCode: 1 };
    }
    const scoped = new Set(scope.files.map(keyOf));
    detectionFiles = deployableFiles.filter(file => scoped.has(keyOf(file)));
    if (args.seedFrom === 'none') {
      logger.warn(
        warningColor(
          '  [WARN] --seed-from none: --paths does not select function seeds here (nothing is compared); it still scopes the other artefact types'
        )
      );
    }
  }

  let detected: Seed[] = [];
  const seedNotes: string[] = [];
  if (args.seedFrom === 'remote' && inventory) {
    logger.info(
      chalk.blue(
        `Comparing ${detectionFiles.length} function file(s)${
          scopeLabels.length > 0 ? ` under ${scopeLabels.join(', ')}` : ''
        } with ${getBaseUrl()} (code only)...`
      )
    );
    detected = await detectRemoteSeeds(
      context.client,
      detectionFiles,
      inventory
    );
  } else if (args.seedFrom === 'specs') {
    const result = detectSpecsSeeds(detectionFiles, context.workspaceRoot);
    detected = result.seeds;
    seedNotes.push(...result.notes);
  }

  let seeds = mergeSeeds(explicit.seeds, detected);
  // Functions whose code was compared with the target in this run.
  const comparedKeys = new Set<string>(
    args.seedFrom === 'specs' || (args.seedFrom === 'remote' && inventory)
      ? detectionFiles.map(keyOf)
      : []
  );

  // The intermediate client functions inside the trees that were not compared
  // yet (forced seeds with detection off, or intermediates outside the --paths
  // scope) are few and cheap to check: compare just those and promote any that
  // differ to seeds, so the tree labels are true and --skip-unchanged-cfx never
  // leaves out a changed one.
  let promoted: Seed[] = [];
  if (seeds.length > 0) {
    const preliminary = computeClosure(
      graph,
      seeds.map(seed => seed.key)
    );
    const uncompared = [...preliminary.nodes.values()]
      .filter(
        node =>
          node.reason === 'intermediate' &&
          !skippedKeys.has(node.key) &&
          !comparedKeys.has(node.key)
      )
      .map(node => filesByKey.get(node.key))
      .filter((file): file is FunctionFile => Boolean(file));
    let differing: Seed[] | null = null;
    if (uncompared.length > 0 && args.seedFrom === 'specs') {
      differing = detectSpecsSeeds(uncompared, context.workspaceRoot).seeds;
    } else if (uncompared.length > 0 && inventory) {
      differing = await detectRemoteSeeds(
        context.client,
        uncompared,
        inventory
      );
    }
    if (differing) {
      for (const file of uncompared) {
        comparedKeys.add(keyOf(file));
      }
      promoted = differing.map(seed => ({
        ...seed,
        detail: `intermediate of a seed; ${seed.detail}`,
      }));
      seeds = mergeSeeds(seeds, promoted);
    }
  }

  const seedByKey = new Map(seeds.map(seed => [seed.key, seed]));
  const seedKeys = seeds.map(seed => seed.key);
  // The deploy closure never expands past server functions; --through-sfx only
  // widens the printed tree.
  const closure = computeClosure(graph, seedKeys);
  const intermediatesCompared = [...closure.nodes.values()]
    .filter(
      node => node.reason === 'intermediate' && !skippedKeys.has(node.key)
    )
    .every(node => comparedKeys.has(node.key));

  logger.info(chalk.cyan.bold('[SEEDS]'));
  for (const note of seedNotes) {
    logger.info(chalk.gray(`  ${note}`));
  }
  const scopeLabel =
    scopeLabels.length > 0 ? ` (scoped to ${scopeLabels.join(', ')})` : '';
  const sourceLabel =
    args.seedFrom === 'none'
      ? `automatic detection off — forced seeds only${
          intermediatesCompared && comparedKeys.size > 0
            ? '; intermediates in their trees compared with deployed code'
            : ''
        }`
      : args.seedFrom === 'specs'
        ? `offline compare against the generated SDK specs cache${scopeLabel}`
        : `compared with deployed code${scopeLabel}`;
  logger.info(
    chalk.gray(
      `  ${explicit.seeds.length} forced, ${detected.length + promoted.length} detected (${sourceLabel})`
    )
  );
  if (seeds.length > 0) {
    logger.info(
      chalk.gray(
        '  legend: + create (not deployed) · ~ update (code differs) · ! forced (--seeds)'
      )
    );
  }
  for (const seed of seeds) {
    const node = graph.nodes.get(seed.key);
    const marker =
      seed.kind === 'create' ? '+' : seed.kind === 'update' ? '~' : '!';
    logger.info(
      `  ${marker} ${seed.key}  [${typeLabel(node?.type ?? 'client')}]  ${chalk.gray(seed.detail)}`
    );
  }

  if (args.why) {
    const target = [...graph.nodes.keys()].find(
      key => key.toLowerCase() === args.why?.toLowerCase()
    );
    if (!target) {
      logger.error(`--why: unknown function "${args.why}"`);
      return { kind: 'exit', exitCode: 1 };
    }
    const explained = explainPaths(graph, seedKeys, target, WHY_LIMIT);
    if (args.json) {
      writeJson({
        target,
        seeds: seedKeys,
        chains: explained.paths,
        truncated: explained.truncated,
      });
      return { kind: 'exit', exitCode: 0 };
    }
    logger.info(chalk.cyan.bold(`[WHY] ${target}`));
    if (explained.paths.length === 0) {
      logger.info(
        chalk.gray(
          seeds.length === 0
            ? '  no seeds (nothing to reach it from)'
            : '  not reached from any seed'
        )
      );
    }
    for (const chain of explained.paths) {
      logger.info(`  ${chain.join('  →  ')}`);
    }
    if (explained.truncated) {
      logger.info(
        chalk.gray(`  … more chains exist (first ${WHY_LIMIT} listed)`)
      );
    }
    return { kind: 'exit', exitCode: 0 };
  }

  if (seeds.length === 0) {
    logger.info(
      chalk.green(
        args.seedFrom === 'none'
          ? '  no seeds (automatic detection off, none forced) — no function deploys'
          : '  nothing differs from the target environment — no function deploys'
      )
    );
  }

  const treeClosure = args.throughSfx
    ? computeClosure(graph, seedKeys, { throughSfx: true })
    : closure;

  // Intermediates are re-added unless the operator asked to skip unchanged
  // ones AND they were actually compared with the target.
  const includeIntermediates = !(
    args.skipUnchangedCfx && intermediatesCompared
  );
  const deploySet = new Set(
    selectDeploySet(closure, includeIntermediates).filter(
      key => !skippedKeys.has(key)
    )
  );
  const skippedByPath = [...closure.nodes.keys()].filter(key =>
    skippedKeys.has(key)
  );
  // Order over the whole closure (intermediates included) so that two seeds
  // linked only through a skipped intermediate still deploy callee-first.
  const ordered = orderForDeploy(graph, closure.nodes.keys());
  const order = ordered.order.filter(key => deploySet.has(key));
  const cyclic = ordered.cyclic.filter(key => deploySet.has(key));

  // Validate every function the plan deploys, as `flow push` does before each
  // deploy: the validation phase only saw the files under --paths/--types, but
  // the closure reaches beyond them. --skip-invalid does not apply here —
  // leaving one function out would deploy its callers on top of stale code.
  const invalid: string[] = [];
  for (const key of order) {
    const file = filesByKey.get(key);
    if (!file) {
      continue;
    }
    try {
      validateFunctionArtifact(file.metadata, file.tsFilePath, false);
      validateNamespace(file.metadata.context, 'Function', file.metadata.name);
    } catch (error) {
      logger.error(`  ${key}: ${(error as Error).message}`);
      invalid.push(key);
    }
  }
  if (invalid.length > 0) {
    logger.error(
      `  ${invalid.length} function(s) in the plan failed validation (${invalid.join(', ')}); fix them before deploying this tree (--skip-invalid does not apply to functions in the plan).`
    );
    return { kind: 'exit', exitCode: 1 };
  }

  const isMust = (key: string): boolean => {
    const node = graph.nodes.get(key);
    const info = node ? inventory?.get(remoteKey(node.type, key)) : undefined;
    return Boolean(info && (info.alwaysOn || info.cachePolyLibrary));
  };

  const intermediateLabel = includeIntermediates
    ? intermediatesCompared
      ? 'intermediate, unchanged → re-added (whole tree)'
      : 'intermediate, not compared → re-added'
    : 'intermediate, unchanged → skipped';

  const annotate = (key: string): string => {
    const closureNode = treeClosure.nodes.get(key);
    const node = graph.nodes.get(key);
    if (!closureNode || !node) {
      return '';
    }
    const info = inventory?.get(remoteKey(node.type, key));
    const bits: string[] = [];
    if (closureNode.reason === 'seed') {
      bits.push(`seed (${seedByKey.get(key)?.kind ?? 'forced'})`);
    } else if (closureNode.reason === 'leaf') {
      if (!closure.nodes.has(key)) {
        bits.push('reached through an SFX → not deployed (HTTP boundary)');
      } else {
        bits.push(
          isMust(key)
            ? `leaf, MUST (${info?.alwaysOn ? 'alwaysOn' : 'cachePolyLibrary'})`
            : 'leaf'
        );
      }
    } else if (!closure.nodes.has(key)) {
      bits.push('reached through an SFX → not deployed (HTTP boundary)');
    } else {
      bits.push(intermediateLabel);
    }
    if (skippedKeys.has(key)) {
      bits.push('excluded by POLY_DEPLOY_SKIP_PATHS → not deployed');
    }
    if (inventory && !info) {
      bits.push('not deployed');
    } else if (info?.revision !== undefined) {
      bits.push(`rev ${info.revision}`);
    }
    return bits.join(' · ');
  };

  logger.info(
    chalk.cyan.bold(
      args.throughSfx
        ? '[TREE] callers of each seed (expanded past server functions — report only)'
        : '[TREE] callers of each seed (expansion stops at server functions)'
    )
  );
  for (const line of renderTree(graph, treeClosure, {
    throughSfx: args.throughSfx,
    annotate,
  })) {
    logger.info(`  ${line}`);
  }

  const leaves = order.filter(key => closure.nodes.get(key)?.reason === 'leaf');
  const mustLeaves = leaves.filter(isMust);
  const intermediates = [...closure.nodes.values()].filter(
    node => node.reason === 'intermediate'
  );
  const skippedIntermediates = includeIntermediates ? 0 : intermediates.length;
  const outsideClosure = graph.nodes.size - closure.nodes.size;

  logger.info(
    chalk.cyan.bold(
      `[PLAN] ${order.length} deploy(s) in dependency order  (${seeds.length} seed · ${leaves.length} leaf · ${mustLeaves.length} MUST · ${skippedIntermediates} intermediate skipped · ${outsideClosure} outside the closure)`
    )
  );
  order.forEach((key, index) => {
    const node = graph.nodes.get(key);
    const file = filesByKey.get(key);
    const closureNode = closure.nodes.get(key);
    if (!node || !file || !closureNode) {
      return;
    }
    const reason =
      closureNode.reason === 'seed'
        ? `seed (${seedByKey.get(key)?.kind ?? 'forced'})`
        : `${closureNode.reason} via ${closureNode.via.join(', ')}${isMust(key) ? ' (MUST)' : ''}`;
    logger.info(
      `  ${String(index + 1).padStart(3)}  ${typeLabel(node.type)}  ${key}  ${chalk.gray(reason)}  ${chalk.dim(relativeToWorkspace(context.workspaceRoot, file.tsFilePath))}`
    );
  });
  if (skippedByPath.length > 0) {
    logger.info(
      chalk.gray(
        `  note: excluded by POLY_DEPLOY_SKIP_PATHS and left out of the plan: ${skippedByPath.join(', ')}`
      )
    );
  }
  if (cyclic.length > 0) {
    logger.warn(
      warningColor(
        `  [WARN] dependency cycle among: ${cyclic.join(', ')} — these call each other, so they are deployed in name order; everything that depends on them comes after`
      )
    );
  }
  if (
    args.skipUnchangedCfx &&
    !intermediatesCompared &&
    intermediates.length > 0
  ) {
    logger.info(
      chalk.gray(
        `  note: --skip-unchanged-cfx ignored — deployed functions could not be listed, so the ${intermediates.length} intermediate CFX are re-added`
      )
    );
  }
  for (const node of intermediates.filter(
    entry => graph.nodes.get(entry.key)?.dependents.size === 0
  )) {
    logger.info(
      chalk.gray(
        `  note: ${node.key} has no caller in this repo (local harness or out-of-repo caller?)`
      )
    );
  }

  const serverKeys = order.filter(
    key => graph.nodes.get(key)?.type === 'server'
  );
  const flagExecutionApiKey =
    args.executionApiKey ?? process.env[EXECUTION_API_KEY_ENV];
  const productionOverride = context.productionSensitive
    ? getPolyprodExecKey()
    : undefined;
  const serverKeysWithoutKey = serverKeys.filter(
    key =>
      !(
        productionOverride ||
        flagExecutionApiKey ||
        filesByKey.get(key)?.metadata.executionApiKey
      )
  );
  if (serverKeysWithoutKey.length > 0) {
    // Same rule as `flow push`: an execution API key is optional. Production-sensitive
    // branches are covered by the safeguards (POLYPROD_EXEC_KEY is mandatory there).
    const count = serverKeysWithoutKey.length;
    logger.info(
      chalk.gray(
        `  note: ${count} server function(s) will be deployed without an execution API key (as flow push does); pass --execution-api-key or set ${EXECUTION_API_KEY_ENV} to attach one`
      )
    );
  }

  if (args.json) {
    writeJson({
      generatedAt: new Date().toISOString(),
      baseUrl: getBaseUrl(),
      envFile: context.envDisplayPath,
      branch: context.currentBranch,
      dryRun: args.dryRun,
      seedFrom: args.seedFrom,
      graph: {
        functions: graph.nodes.size,
        edges: graph.edgeCount,
        warnings: graph.warnings,
      },
      ...(wildcardExpansion
        ? { experimentalWildcards: wildcardExpansion }
        : {}),
      seeds: seeds.map(seed => ({
        key: seed.key,
        kind: seed.kind,
        detail: seed.detail,
      })),
      nodes: [...closure.nodes.values()].map(node => {
        const info = inventory?.get(remoteKey(node.type, node.key));
        return {
          key: node.key,
          type: node.type,
          reason: node.reason,
          via: node.via,
          deploy: deploySet.has(node.key),
          must: isMust(node.key),
          file: relativeToWorkspace(
            context.workspaceRoot,
            filesByKey.get(node.key)?.tsFilePath ?? ''
          ),
          remote: info
            ? {
                id: info.id,
                revision: info.revision,
                alwaysOn: info.alwaysOn,
                cachePolyLibrary: info.cachePolyLibrary,
              }
            : null,
        };
      }),
      order,
      cyclic,
    });
  }

  const orphans: FunctionOrphan[] = [];
  if (options.detectOrphans && inventory) {
    const localKeys = new Set(
      files.map(file => remoteKey(file.type, keyOf(file)))
    );
    const candidates = [...inventory.entries()]
      .filter(([key]) => !localKeys.has(key))
      .map(([, info]) => ({
        type: 'function' as const,
        name: info.name,
        context: info.context,
        id: info.id,
        functionType: info.type,
      }));
    const { included, excluded } = filterOrphansByContext(candidates);
    if (excluded.length > 0) {
      logger.info(
        chalk.gray(
          `  ${excluded.length} function orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }
    if (included.length > 0) {
      logger.info(
        chalk.gray(
          `  ${included.length} deployed function(s) have no local file (orphans; reported in the summary)`
        )
      );
    }
    orphans.push(...included);
  }

  return {
    kind: 'plan',
    plan: {
      graph,
      closure,
      order,
      seeds,
      leaves,
      mustLeaves,
      filesByKey,
      inventory,
      flagExecutionApiKey,
      unchanged: [...comparedKeys].filter(key => !deploySet.has(key)).length,
      orphans,
    },
  };
}

/**
 * Ask the operator to confirm the whole run (y/N, and a typed leaf count above
 * --max-leaves). `plan` is undefined when --types leaves functions out; the
 * run is confirmed all the same. Returns false when cancelled; --yes skips
 * both prompts.
 */
export async function confirmPushDynamicPlan(
  plan: PushDynamicPlan | undefined,
  args: PushDynamicArgs,
  context: PushDynamicContext
): Promise<boolean> {
  if (args.yes) {
    return true;
  }
  const actions: string[] = [];
  if (plan && plan.order.length > 0) {
    actions.push(`deploy ${plan.order.length} function(s)`);
  }
  if (plan && context.deletesOrphans && plan.orphans.length > 0) {
    actions.push(`delete ${plan.orphans.length} orphaned function(s)`);
  }
  if (context.syncsOtherArtefacts) {
    actions.push(
      plan ? 'sync the other selected artefacts' : 'sync the selected artefacts'
    );
  }
  if (actions.length === 0) {
    return true; // nothing would change
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    logger.error(
      'Refusing to deploy without confirmation in a non-interactive terminal. Re-run with --yes or --dry-run.'
    );
    return false;
  }
  const joined =
    actions.length > 1
      ? `${actions.slice(0, -1).join(', ')} and ${actions[actions.length - 1]}`
      : actions[0];
  const what =
    plan && plan.order.length === 0
      ? `No function deploys planned; ${joined}`
      : `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
  const answer = (
    await context.confirm(
      `${what} to ${getBaseUrl()} (${context.envDisplayPath})? [y/N]: `
    )
  ).toLowerCase();
  if (!['y', 'yes'].includes(answer)) {
    logger.info(chalk.gray('Cancelled — nothing was deployed.'));
    return false;
  }
  if (plan && plan.leaves.length > args.maxLeaves) {
    const typed = await context.confirm(
      `This plan rebuilds ${plan.leaves.length} server function(s), more than --max-leaves ${args.maxLeaves}. Type ${plan.leaves.length} to continue: `
    );
    if (typed.trim() !== String(plan.leaves.length)) {
      logger.info(chalk.gray('Cancelled — nothing was deployed.'));
      return false;
    }
  }
  return true;
}

/**
 * The functions step of the sync pipeline: deploys the plan in order (stopping
 * at the first failure so no dependent is built on top of it), fills the
 * functions summary like `syncFunctions` does, and reports/deletes orphans.
 */
export async function executePushDynamicPlan(
  plan: PushDynamicPlan,
  args: PushDynamicArgs,
  context: PushDynamicContext,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean
): Promise<void> {
  const { graph, filesByKey, order } = plan;
  const seedByKey = new Map(plan.seeds.map(seed => [seed.key, seed]));
  summary.skipped += plan.unchanged;

  if (plan.orphans.length > 0) {
    if (deleteOrphans && !args.dryRun) {
      logger.info(
        warningColor(
          `Deleting ${plan.orphans.length} function(s) not in local files...`
        )
      );
      for (const orphan of plan.orphans) {
        const deleted =
          orphan.functionType === 'server'
            ? await deleteServerFunction(
                context.client,
                orphan.id,
                orphan.name,
                orphan.context
              )
            : await deleteClientFunction(
                context.client,
                orphan.id,
                orphan.name,
                orphan.context
              );
        if (deleted) {
          summary.deleted += 1;
        } else {
          summary.failed += 1;
        }
        await sleep(300);
      }
    } else if (deleteOrphans && args.dryRun) {
      summary.planned += plan.orphans.length;
      for (const orphan of plan.orphans) {
        logger.info(
          chalk.blue(
            `    [PLAN] Delete ${orphan.functionType} function ${orphan.name} (${orphan.context})`
          )
        );
      }
    } else {
      orphans.push(
        ...plan.orphans.map(({ type, name, context: orphanContext, id }) => ({
          type,
          name,
          context: orphanContext,
          id,
        }))
      );
    }
  }

  if (args.dryRun) {
    summary.planned += order.length;
    return;
  }

  logger.info(chalk.cyan.bold('\n[DEPLOY]'));
  let failedKey: string | undefined;
  const notRun: string[] = [];

  for (const [index, key] of order.entries()) {
    const file = filesByKey.get(key);
    const node = graph.nodes.get(key);
    if (!file || !node) {
      continue;
    }
    if (failedKey) {
      notRun.push(key);
      continue;
    }

    logger.info(
      chalk.dim(
        `  → [${index + 1}/${order.length}] ${key} [${typeLabel(node.type)}]`
      )
    );
    const result = await addFunction(file, plan.flagExecutionApiKey);
    if (result === 'deployed') {
      if (seedByKey.get(key)?.kind === 'create') {
        summary.created += 1;
      } else {
        summary.updated += 1;
      }
      logger.info(chalk.green('    [OK] Deployed'));
    } else {
      failedKey = key;
      summary.failed += 1;
      logger.error(
        chalk.red(
          '    [FAIL] Failed — stopping so no dependent is built on top of a failed deploy'
        )
      );
    }
    await sleep(500);
  }

  if (failedKey) {
    summary.skipped += notRun.length;
    if (notRun.length > 0) {
      logger.info(
        `  ${chalk.gray('[-]')} Not run:  ${notRun.length} (${notRun.join(', ')})`
      );
    }
    logger.info(
      chalk.gray(
        `  resume with: ENVPATH=${context.envDisplayPath} pnpm workflows push:dynamic -- --types functions --seed-from none --seeds ${[failedKey, ...notRun].join(',')}`
      )
    );
  }
}
