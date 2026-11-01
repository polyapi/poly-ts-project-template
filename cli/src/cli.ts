#!/usr/bin/env node

/**
 * PolyAPI Sync CLI - Main Entry Point
 *
 * Synchronizes local artifacts (schemas, webhooks, functions, triggers) with PolyAPI.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs as parseNodeArgs } from 'node:util';
import chalk from 'chalk';
import { findAiFunctionFiles, syncAiFunctions } from './artefacts/aiFunctions';
import { findCanopyFiles, syncCanopy } from './artefacts/canopy';
import { findFunctionFiles, syncFunctions } from './artefacts/functions';
import { findJobFiles, syncJobs } from './artefacts/jobs';
import { findSchemaFiles, syncSchemas } from './artefacts/schemas';
import { findTableFiles, syncTables } from './artefacts/tables';
import { findTriggerFiles, syncTriggers } from './artefacts/triggers';
import { findVariableFiles, syncVariables } from './artefacts/variables';
import { findWebhookFiles, syncWebhooks } from './artefacts/webhooks';
import {
  createMaintenanceRuntime,
  maintenanceHelp,
  parseMaintenanceArgs,
  runMaintenance,
} from './commands/maintenance';
import { createSummary, getTotalStats } from './types/summary';
import { createPolyApiClient, getBaseUrl, loadEnv } from './utils/apiClient';
import {
  buildDeploymentPreflight,
  expectedBranchEnvFileExists,
  getPolyprodExecKey,
  getProductionConfirmationValue,
  resolveBranchEnvFile,
} from './utils/deploymentConfig';
import {
  collectMissingEnvTokenRefs,
  printMissingEnvTokenWarning,
} from './utils/envPreflight';
import { findWorkspaceRoot, type WalkDirOptions } from './utils/fileSystem';
import { bullet, checkMark, heavyRule, logger, thinRule } from './utils/logger';
import { printFlowLogo } from './utils/logo';
import { printNamespaceBanner } from './utils/namespace';
import { getPolyGenerateEnvironment } from './utils/polyGenerateEnvironment';
import {
  enforceTargetEnvironment,
  fetchRemoteEnvironment,
} from './utils/targetEnvironment';
import {
  validateAiFunctionArtifact,
  validateFunctionArtifact,
  validateJobArtifact,
  validateSchemaArtifact,
  validateTableArtifact,
  validateTriggerArtifact,
  validateVariableArtifact,
  validateWebhookArtifact,
} from './utils/validation';

type ArtifactType =
  | 'canopy'
  | 'variables'
  | 'schemas'
  | 'tables'
  | 'functions'
  | 'ai-functions'
  | 'webhooks'
  | 'triggers'
  | 'jobs';

type FunctionTypeSelection = 'client' | 'server';

type CliArgs = {
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  deleteOrphans: boolean;
  buildSchema: boolean;
  skipInvalid: boolean;
  skipValidationAcknowledged: boolean;
  showConfig: boolean;
  skipGenerate: boolean;
  pathFilters: string[];
  enabledTypes: ArtifactType[];
  functionTypes: FunctionTypeSelection[] | null;
};

const SKIP_VALIDATION_ACKNOWLEDGEMENT = 'I know what am doing';
const FLOW_VERSION: string = require('../package.json').version;

const DEFAULT_ENABLED_TYPES: ArtifactType[] = [
  'canopy',
  'variables',
  'schemas',
  'tables',
  'functions',
  'ai-functions',
  'webhooks',
  'triggers',
  'jobs',
];

const SUPPORTED_TYPE_SELECTIONS = [
  'canopy',
  'variables',
  'schemas',
  'tables',
  'functions',
  'client-functions',
  'server-functions',
  'ai-functions',
  'webhooks',
  'triggers',
  'jobs',
] as const;

function printRootHelp(): void {
  logger.info(`Flow CLI ${FLOW_VERSION} is the PolyAPI deployment CLI for this repository.

Usage:
  flow push [options]
  flow target-env
  flow self-update [--check | --rollback] [--yes]
  flow train-openapi [spec-file-or-folder] [--context namespace.apis.{file}] [--operation-id ID] [--dry-run]
  flow train-model <model-file> [--dry-run]
  flow delete-content [--types api-functions,schemas] [--context namespace.prefix] [--include-children] [--apply]
  flow logs [function-id] [--keyword error] [--raw]
  flow --help
  flow --version

Examples:
  flow push
  flow push --dry-run
  flow push --paths exampleWorkflow
  flow push --paths src/utilities --types functions,ai-functions,jobs
  flow push --delete-orphans
  flow push --help
`);
}

function installSignalHandlers(): void {
  let signalCount = 0;

  const handleSignal = (signal: NodeJS.Signals): void => {
    signalCount += 1;

    if (signalCount === 1) {
      process.stderr.write(`\nReceived ${signal}. Exiting...\n`);
      process.exit(130);
    }

    process.stderr.write(`\nReceived ${signal} again. Force exiting now.\n`);
    process.exit(130);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

/**
 * Exit the process without racing pending async handles (e.g. keep-alive
 * HTTP sockets from the fetch/undici client used by the API client).
 * Calling `process.exit()` immediately after network I/O can hit a libuv
 * handle-teardown race that crashes with an assertion failure on some
 * Windows terminals (observed on Git Bash/MinTTY). Setting `exitCode` lets
 * Node drain and close those handles cooperatively; the unref'd timer is
 * only a safety net in case something never closes on its own.
 */
function exitProcess(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
}

function printPushHelp(): void {
  logger.info(`Deploy PolyAPI artefacts from local files with env-driven behavior.

Usage:
  flow push [options]

  Options:
  --dry-run           Show planned actions without changing anything remotely
  --force             Update existing remote artifacts even when payload is unchanged
  --verbose           Print debug logging while scanning and diffing
  --delete-orphans    Delete remote artefacts that no longer exist locally
  --build-schema      Regenerate OpenAPI SDK/schemas before sync
  --types             Comma-separated types: canopy,variables,schemas,tables,functions,client-functions,server-functions,ai-functions,webhooks,triggers,jobs
  --paths             Comma-separated scope filters, e.g. exampleWorkflow or src/utilities
  --show-config       Print resolved CLI config and exit
  --skip-generate     Skip pnpm workflows exec poly generate after sync
  --skip-invalid      Continue after validation failures
  --skip-validation   Bypass interactive confirmations only when its value is exactly "I know what am doing"
  --help, -h          Show this help

Notes:
  - Interactive runs without --paths prompt for full-repo sync or a specific scope.
  - Scoped runs skip orphan detection to avoid false orphan reports.
  - Production safeguards are skipped for --dry-run.
`);
}

function parseCsvArgument(rawValue: string | undefined): string[] {
  if (!rawValue?.trim()) {
    return [];
  }

  return rawValue
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseTypeSelection(items: string[]): {
  enabledTypes: ArtifactType[];
  functionTypes: FunctionTypeSelection[] | null;
} {
  if (items.length === 0) {
    return { enabledTypes: DEFAULT_ENABLED_TYPES, functionTypes: null };
  }

  const invalidItems = items.filter(
    item =>
      !SUPPORTED_TYPE_SELECTIONS.includes(
        item as (typeof SUPPORTED_TYPE_SELECTIONS)[number]
      )
  );
  if (invalidItems.length > 0) {
    throw new Error(
      `Unsupported --types value(s): ${invalidItems.join(
        ', '
      )}. Expected one of: ${SUPPORTED_TYPE_SELECTIONS.join(', ')}`
    );
  }

  const enabledTypes: ArtifactType[] = [];
  const functionTypes: FunctionTypeSelection[] = [];

  for (const item of items) {
    if (item === 'client-functions' || item === 'server-functions') {
      if (!enabledTypes.includes('functions')) {
        enabledTypes.push('functions');
      }
      const functionType = item === 'client-functions' ? 'client' : 'server';
      if (!functionTypes.includes(functionType)) {
        functionTypes.push(functionType);
      }
      continue;
    }

    const artifactType = item as ArtifactType;
    if (!enabledTypes.includes(artifactType)) {
      enabledTypes.push(artifactType);
    }
  }

  return {
    enabledTypes,
    functionTypes: functionTypes.length > 0 ? functionTypes : null,
  };
}

function resolveScopeFilter(projectRoot: string, rawScope: string): string {
  const normalizedScope = rawScope
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!normalizedScope) {
    throw new Error('Scope cannot be empty.');
  }

  const attemptedPaths: string[] = [];
  const candidates = path.isAbsolute(normalizedScope)
    ? [path.resolve(normalizedScope)]
    : [
        path.resolve(projectRoot, normalizedScope),
        ...(normalizedScope.startsWith('src/')
          ? []
          : [path.resolve(projectRoot, 'src', normalizedScope)]),
      ];

  for (const candidate of candidates) {
    const displayPath = path.relative(projectRoot, candidate) || candidate;
    attemptedPaths.push(displayPath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not resolve scope "${rawScope}". Tried: ${attemptedPaths.join(', ')}`
  );
}

function parseCliArgs(argv: string[] = process.argv.slice(2)): CliArgs | null {
  const normalizedArgv = argv.filter(arg => arg !== '--');

  if (normalizedArgv.length === 0) {
    printRootHelp();
    return null;
  }

  if (
    normalizedArgv[0] === '--help' ||
    normalizedArgv[0] === '-h' ||
    normalizedArgv[0] === 'help'
  ) {
    printRootHelp();
    return null;
  }

  const [command, ...rest] = normalizedArgv;
  if (command !== 'push') {
    throw new Error(
      `Unknown command "${command}". Use "flow --help" for usage.`
    );
  }

  const { values, positionals } = parseNodeArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      verbose: { type: 'boolean' },
      'delete-orphans': { type: 'boolean' },
      'build-schema': { type: 'boolean' },
      'skip-invalid': { type: 'boolean' },
      'skip-validation': { type: 'string' },
      types: { type: 'string' },
      paths: { type: 'string' },
      'show-config': { type: 'boolean' },
      'skip-generate': { type: 'boolean' },
    },
  });

  if (values.help) {
    printPushHelp();
    return null;
  }

  if (positionals.length > 0) {
    throw new Error(
      `Unexpected positional arguments: ${positionals.join(', ')}`
    );
  }

  const parsedTypes = parseTypeSelection(parseCsvArgument(values.types));
  const skipValidationValue = values['skip-validation'];
  if (
    skipValidationValue !== undefined &&
    skipValidationValue !== SKIP_VALIDATION_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      `--skip-validation must exactly equal "${SKIP_VALIDATION_ACKNOWLEDGEMENT}".`
    );
  }

  return {
    dryRun: Boolean(values['dry-run']),
    force: Boolean(values.force),
    verbose: Boolean(values.verbose),
    deleteOrphans: Boolean(values['delete-orphans']),
    buildSchema: Boolean(values['build-schema']),
    skipInvalid: Boolean(values['skip-invalid']),
    skipValidationAcknowledged:
      skipValidationValue === SKIP_VALIDATION_ACKNOWLEDGEMENT,
    showConfig: Boolean(values['show-config']),
    skipGenerate: Boolean(values['skip-generate']),
    pathFilters: parseCsvArgument(values.paths),
    enabledTypes: parsedTypes.enabledTypes,
    functionTypes: parsedTypes.functionTypes,
  };
}

/**
 * Print final summary
 */
function printSummary(
  summary: ReturnType<typeof createSummary>,
  createdVariables: any[] = [],
  options: { dryRun?: boolean } = {}
): void {
  summary.endTime = Date.now();
  const duration = ((summary.endTime - summary.startTime) / 1000).toFixed(2);
  const totals = getTotalStats(summary);
  const variablesCollectionUrl = `${getBaseUrl().replace(/\/+$/, '')}/canopy/polyui/collections/variables`;

  logger.info(`\n${chalk.bold(heavyRule())}`);
  logger.info(
    chalk.bold.cyan(
      '                    SYNCHRONIZATION SUMMARY                     '
    )
  );
  logger.info(chalk.bold(`${heavyRule()}\n`));

  const artifacts = [
    { name: 'Canopy', data: summary.canopy },
    { name: 'Schemas', data: summary.schemas },
    { name: 'Webhooks', data: summary.webhooks },
    { name: 'Functions', data: summary.functions },
    { name: 'AI Functions', data: summary.aiFunctions },
    { name: 'Triggers', data: summary.triggers },
    { name: 'Variables', data: summary.variables },
    { name: 'Tables', data: summary.tables },
    { name: 'Jobs', data: summary.jobs },
  ];

  artifacts.forEach(({ name, data }) => {
    if (
      data.created +
        data.updated +
        data.deleted +
        data.failed +
        data.skipped +
        data.planned >
      0
    ) {
      logger.info(chalk.bold(`${name}:`));
      if (data.created > 0)
        logger.info(
          `  ${chalk.green('[+]')} Created:  ${chalk.green(data.created)}`
        );
      if (data.updated > 0)
        logger.info(
          `  ${chalk.blue('[~]')} Updated:  ${chalk.blue(data.updated)}`
        );
      if (data.deleted > 0)
        logger.info(
          `  ${chalk.yellow('[-]')} Deleted:  ${chalk.yellow(data.deleted)}`
        );
      if (data.failed > 0)
        logger.info(
          `  ${chalk.red('[X]')} Failed:   ${chalk.red(data.failed)}`
        );
      if (data.skipped > 0)
        logger.info(
          `  ${chalk.gray('[=]')} Skipped:  ${chalk.gray(data.skipped)}`
        );
      if (data.planned > 0)
        logger.info(
          `  ${chalk.blue('[?]')} Planned:  ${chalk.blue(data.planned)}`
        );
      logger.info('');
    }
  });

  logger.info(chalk.bold('Total:'));
  if (totals.created > 0)
    logger.info(
      `  ${chalk.green('[+]')} Created:  ${chalk.green(totals.created)}`
    );
  if (totals.updated > 0)
    logger.info(
      `  ${chalk.blue('[~]')} Updated:  ${chalk.blue(totals.updated)}`
    );
  if (totals.deleted > 0)
    logger.info(
      `  ${chalk.yellow('[-]')} Deleted:  ${chalk.yellow(totals.deleted)}`
    );
  if (totals.failed > 0)
    logger.info(`  ${chalk.red('[X]')} Failed:   ${chalk.red(totals.failed)}`);
  if (totals.skipped > 0)
    logger.info(
      `  ${chalk.gray('[=]')} Skipped:  ${chalk.gray(totals.skipped)}`
    );
  if (totals.planned > 0)
    logger.info(
      `  ${chalk.blue('[?]')} Planned:  ${chalk.blue(totals.planned)}`
    );

  logger.info(`\n${chalk.bold('Duration: ')}${chalk.cyan(`${duration}s`)}`);
  logger.info(chalk.bold(heavyRule()));

  // Show orphaned resources if any were found
  if (summary.orphans.length > 0) {
    logger.info(chalk.yellow.bold('\n[ORPHANED RESOURCES DETECTED]'));
    logger.info(
      chalk.gray('The following resources exist remotely but not locally:\n')
    );

    // Group orphans by type
    const orphansByType = {
      variable: summary.orphans.filter(o => o.type === 'variable'),
      schema: summary.orphans.filter(o => o.type === 'schema'),
      webhook: summary.orphans.filter(o => o.type === 'webhook'),
      function: summary.orphans.filter(o => o.type === 'function'),
      'ai-function': summary.orphans.filter(o => o.type === 'ai-function'),
      trigger: summary.orphans.filter(o => o.type === 'trigger'),
      table: summary.orphans.filter(o => o.type === 'table'),
      job: summary.orphans.filter(o => o.type === 'job'),
    };

    for (const [type, orphans] of Object.entries(orphansByType)) {
      if (orphans.length > 0) {
        logger.info(
          chalk.bold(
            `  ${type.charAt(0).toUpperCase() + type.slice(1)}s (${orphans.length}):`
          )
        );
        orphans.forEach(orphan => {
          logger.info(chalk.dim(`    - ${orphan.name} (${orphan.context})`));
        });
        logger.info('');
      }
    }

    logger.info(chalk.yellow('To delete these orphaned resources, run with:'));
    logger.info(chalk.cyan('  pnpm workflows push --delete-orphans\n'));
    logger.info(chalk.bold(heavyRule()));
  }

  // Show reminder for newly created variables
  if (createdVariables.length > 0) {
    logger.info(
      chalk.yellow.bold('\n[REMINDER] Variables Created - Values Must Be Set')
    );
    logger.info(
      chalk.gray(
        'The following variables were created and need values set in PolyAPI Canopy:\n'
      )
    );

    for (const variable of createdVariables) {
      logger.info(
        chalk.bold(`  ${bullet} ${variable.name}`) +
          chalk.gray(` (${variable.context})`)
      );
      if (variable.instruction) {
        logger.info(chalk.dim(`    ${variable.instruction}`));
      }
    }

    logger.info(
      chalk.cyan('\nTo set values, visit: ') +
        chalk.underline(variablesCollectionUrl)
    );
    logger.info(chalk.bold(heavyRule()));
  }

  if (totals.failed > 0) {
    logger.info(chalk.red.bold('\n[WARNING] Completed with errors'));
  } else if (options.dryRun) {
    logger.info(chalk.blue.bold('\n[DRY-RUN] No remote changes were applied'));
  } else {
    logger.info(
      chalk.green.bold('\n[SUCCESS] Synchronization completed successfully')
    );
  }
  logger.info(chalk.bold(`${heavyRule()}\n`));
}

function runPolyGenerateAfterPush(): boolean {
  const workspaceRoot = findWorkspaceRoot(process.cwd());

  logger.info(chalk.cyan.bold(`\n[POST-PUSH] ${thinRule(47)}`));
  logger.info(
    chalk.gray(
      `Running: pnpm workflows exec poly generate (cwd: ${workspaceRoot})`
    )
  );

  try {
    execFileSync('pnpm', ['workflows', 'exec', 'poly', 'generate'], {
      cwd: workspaceRoot,
      env: getPolyGenerateEnvironment(process.env),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    logger.info(chalk.green(`${checkMark} Post-push generation completed\n`));
    return true;
  } catch (error) {
    logger.error(
      { error: serializeErrorForLog(error) },
      `Post-push generation failed: ${getErrorMessage(error)}`
    );
    return false;
  }
}

function runSchemaGenerationBeforePush(): boolean {
  const cliRoot = path.resolve(__dirname, '..');

  logger.info(chalk.cyan.bold(`[PRE-PUSH] ${thinRule(48)}`));
  logger.info(chalk.gray(`Running: pnpm generate (cwd: ${cliRoot})`));

  try {
    execFileSync('pnpm', ['generate'], {
      cwd: cliRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    logger.info(
      chalk.green(`${checkMark} Pre-push schema generation completed\n`)
    );
    return true;
  } catch (error) {
    logger.error(
      { error: serializeErrorForLog(error) },
      `Pre-push schema generation failed: ${getErrorMessage(error)}`
    );
    return false;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
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

function serializeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const errorRecord = error as Error & {
      cause?: unknown;
      code?: unknown;
      response?: {
        data?: unknown;
        status?: unknown;
        statusText?: unknown;
      };
      status?: unknown;
      statusText?: unknown;
    };

    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(errorRecord.code !== undefined ? { code: errorRecord.code } : {}),
      ...(errorRecord.status !== undefined
        ? { status: errorRecord.status }
        : {}),
      ...(errorRecord.statusText !== undefined
        ? { statusText: errorRecord.statusText }
        : {}),
      ...(errorRecord.response
        ? {
            response: {
              status: errorRecord.response.status,
              statusText: errorRecord.response.statusText,
              data: errorRecord.response.data,
            },
          }
        : {}),
      ...(errorRecord.cause !== undefined
        ? {
            cause:
              errorRecord.cause instanceof Error
                ? {
                    name: errorRecord.cause.name,
                    message: errorRecord.cause.message,
                    ...(errorRecord.cause.stack
                      ? { stack: errorRecord.cause.stack }
                      : {}),
                  }
                : errorRecord.cause,
          }
        : {}),
    };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  return {
    message: getErrorMessage(error),
    value: error,
  };
}

async function promptForConfirmation(prompt: string): Promise<string> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return (await readline.question(prompt)).trim();
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error('Prompt cancelled');
    }
    throw error;
  } finally {
    readline.close();
  }
}

function formatEnvFileVisibility(envFile: {
  displayPath: string;
  exists: boolean;
}): string {
  return envFile.exists
    ? envFile.displayPath
    : `${envFile.displayPath} (missing, not loaded)`;
}

function buildBranchEnvMismatchWarning(
  projectRoot: string,
  preflight: ReturnType<typeof buildDeploymentPreflight>,
  expectedEnvPath: string
): string {
  const expectedEnvFile =
    path.relative(projectRoot, expectedEnvPath) ||
    path.basename(expectedEnvPath);

  if (!preflight.envFile.exists) {
    return `Branch "${preflight.expectedEnvBranch}" expects env file "${expectedEnvFile}", but no workspace env file was loaded because "${preflight.envFile.displayPath}" is missing.`;
  }

  return `Branch "${preflight.expectedEnvBranch}" expects env file "${expectedEnvFile}", but the selected workspace env file is "${preflight.envFile.displayPath}".`;
}

function warnForMissingDefaultEnvFile(envFile: {
  exists: boolean;
  fromEnvPath: boolean;
}): void {
  if (envFile.exists || envFile.fromEnvPath) {
    return;
  }

  logger.warn(
    'No default env file was found at `workflows/dev.env`. Create it or set `ENVPATH` to point to a specific env file.'
  );
}

async function maybeConfirmBranchEnvFileMatch(
  projectRoot: string,
  preflight: ReturnType<typeof buildDeploymentPreflight>,
  cliArgs: Pick<CliArgs, 'skipValidationAcknowledged'>
): Promise<void> {
  if (!preflight.expectedEnvFile) {
    return;
  }

  if (!expectedBranchEnvFileExists(projectRoot, preflight)) {
    return;
  }

  const expectedEnvPath = resolveBranchEnvFile(
    projectRoot,
    preflight.expectedEnvFile
  );
  if (path.resolve(preflight.envFile.resolvedPath) === expectedEnvPath) {
    return;
  }

  const warningMessage = buildBranchEnvMismatchWarning(
    projectRoot,
    preflight,
    expectedEnvPath
  );

  process.stdout.write(chalk.yellow(`WARN: ${warningMessage}\n`));

  if (cliArgs.skipValidationAcknowledged) {
    logger.warn(
      'Branch environment-file mismatch acknowledged non-interactively.'
    );
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${warningMessage} Run interactively to confirm or update ENVPATH.`
    );
  }

  const answer = (
    await promptForConfirmation('Continue with this env file anyway? [y/N]: ')
  ).toLowerCase();

  if (!['y', 'yes'].includes(answer)) {
    throw new Error(
      'Deployment cancelled because the selected env file was not confirmed for the current branch.'
    );
  }
}

async function maybePromptForMissingEnvTokens(
  files: Parameters<typeof collectMissingEnvTokenRefs>[0],
  cliArgs: CliArgs
): Promise<void> {
  const refs = collectMissingEnvTokenRefs(files);

  if (refs.length === 0) {
    return;
  }

  printMissingEnvTokenWarning(refs);

  if (cliArgs.skipValidationAcknowledged) {
    throw new Error(
      `Missing env-file values for deploy placeholders: ${[
        ...new Set(refs.map(ref => ref.envName)),
      ]
        .sort()
        .join(', ')}`
    );
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Missing env-file values for deploy placeholders in non-interactive mode: ${[
        ...new Set(refs.map(ref => ref.envName)),
      ]
        .sort()
        .join(', ')}`
    );
  }

  const answer = (
    await promptForConfirmation(
      'Continue anyway and leave unresolved placeholders as-is? [y/N]: '
    )
  ).toLowerCase();

  if (!['y', 'yes', 'c', 'continue'].includes(answer)) {
    throw new Error(
      'Stopped so you can configure the missing env-file values and try again.'
    );
  }
}

function productionSafeguardsTriggered(
  preflight: ReturnType<typeof buildDeploymentPreflight>,
  cliArgs: Pick<CliArgs, 'dryRun'>
): boolean {
  return preflight.productionSensitive && !cliArgs.dryRun;
}

async function enforceProductionSafeguards(
  preflight: ReturnType<typeof buildDeploymentPreflight>,
  cliArgs: Pick<CliArgs, 'dryRun' | 'skipValidationAcknowledged'>
): Promise<void> {
  if (!productionSafeguardsTriggered(preflight, cliArgs)) {
    return;
  }

  if (!getPolyprodExecKey()) {
    throw new Error(
      'Production safeguards were triggered but POLYPROD_EXEC_KEY is not set. Set it before deploying.'
    );
  }

  if (cliArgs.skipValidationAcknowledged) {
    logger.warn('Production confirmation acknowledged non-interactively.');
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Production-sensitive deployment requires an interactive terminal so you can type "${getProductionConfirmationValue()}".`
    );
  }

  const answer = await promptForConfirmation(
    `Production safeguards are active for "${
      preflight.currentBranch
    }". Type "${getProductionConfirmationValue()}" to continue: `
  );

  if (answer !== getProductionConfirmationValue()) {
    throw new Error(
      `Production-sensitive deployment cancelled. Type "${getProductionConfirmationValue()}" exactly to continue.`
    );
  }
}

async function maybePromptForInitialScope(
  projectRoot: string,
  cliArgs: CliArgs
): Promise<CliArgs> {
  if (cliArgs.pathFilters.length > 0) {
    return cliArgs;
  }

  if (cliArgs.skipValidationAcknowledged) {
    logger.info(
      chalk.gray('Scope: full repository sync (acknowledged non-interactively)')
    );
    return cliArgs;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return cliArgs;
  }

  const rawScope = await promptForConfirmation(
    'Press Enter to sync the entire repo, or type a path like "exampleWorkflow" or "src/utilities": '
  );
  if (!rawScope) {
    logger.info(chalk.gray('Scope: full repository sync'));
    return cliArgs;
  }

  const selectedScope = resolveScopeFilter(projectRoot, rawScope);
  logger.info(
    chalk.gray(
      `Scope: ${path.relative(projectRoot, selectedScope) || selectedScope}`
    )
  );
  return {
    ...cliArgs,
    pathFilters: [selectedScope],
  };
}

function normalizeCliPathFilters(
  projectRoot: string,
  cliArgs: CliArgs
): CliArgs {
  return {
    ...cliArgs,
    pathFilters: cliArgs.pathFilters.map(scope =>
      resolveScopeFilter(projectRoot, scope)
    ),
  };
}

function getDiscoveryOptions(cliArgs: CliArgs): WalkDirOptions {
  return cliArgs.pathFilters.length > 0
    ? { includePaths: cliArgs.pathFilters }
    : {};
}

function describeScope(cliArgs: CliArgs, projectRoot: string): string {
  if (cliArgs.pathFilters.length === 0) {
    return 'full repo';
  }

  return cliArgs.pathFilters
    .map(scope => path.relative(projectRoot, scope) || scope)
    .join(', ');
}

function describeProductionSafeguards(
  preflight: ReturnType<typeof buildDeploymentPreflight>,
  cliArgs: CliArgs
): string {
  if (productionSafeguardsTriggered(preflight, cliArgs)) {
    return `triggered (${preflight.sensitiveReason})`;
  }

  if (preflight.productionSensitive && cliArgs.dryRun) {
    return 'not triggered (dry-run)';
  }

  if (preflight.safeguardExemptionReason) {
    return `not triggered (${preflight.safeguardExemptionReason})`;
  }

  return 'not triggered';
}

function printConfig(
  cliArgs: CliArgs,
  envFile: ReturnType<typeof loadEnv>,
  preflight: ReturnType<typeof buildDeploymentPreflight>,
  projectRoot: string
): void {
  logger.info(
    JSON.stringify(
      {
        cliArgs: {
          dryRun: cliArgs.dryRun,
          force: cliArgs.force,
          verbose: cliArgs.verbose,
          deleteOrphans: cliArgs.deleteOrphans,
          buildSchema: cliArgs.buildSchema,
          skipInvalid: cliArgs.skipInvalid,
          skipValidationAcknowledged: cliArgs.skipValidationAcknowledged,
          showConfig: cliArgs.showConfig,
          skipGenerate: cliArgs.skipGenerate,
          enabledTypes: cliArgs.enabledTypes,
          functionTypes: cliArgs.functionTypes,
          pathFilters: cliArgs.pathFilters.map(
            scope => path.relative(projectRoot, scope) || scope
          ),
        },
        envFile,
        preflight,
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  if (['--version', '-V'].includes(process.argv[2])) {
    process.stdout.write(`Flow CLI ${FLOW_VERSION}\n`);
    return;
  }
  if (process.argv[2] === 'target-env') {
    const { values, positionals } = parseNodeArgs({
      args: process.argv.slice(3),
      options: { help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
    if (positionals.length)
      throw new Error('target-env does not accept positional arguments.');
    if (values.help) {
      process.stdout.write(
        'Read the authenticated environment ID from saved Poly setup or connection overrides. Prints TARGET_ENV_ID=<id>; does not edit files.\n'
      );
      return;
    }
    loadEnv();
    const { environmentId } = await fetchRemoteEnvironment();
    process.stdout.write(`TARGET_ENV_ID=${environmentId}\n`);
    return;
  }
  const maintenance = parseMaintenanceArgs(process.argv.slice(2));
  if (maintenance) {
    if (maintenance.help) {
      process.stdout.write(`${maintenanceHelp(maintenance.command)}\n`);
      return;
    }
    const invocationDirectory = process.cwd();
    const workspaceRoot = findWorkspaceRoot(invocationDirectory);
    process.chdir(path.join(workspaceRoot, 'workflows'));
    const envFile = loadEnv();
    const offlineTrainingPreview =
      maintenance.dryRun &&
      ['train-openapi', 'train-model'].includes(maintenance.command);
    if (!offlineTrainingPreview) await enforceTargetEnvironment(envFile);
    if (maintenance.command !== 'logs') {
      const preflight = buildDeploymentPreflight(process.cwd(), envFile);
      const safetyArgs = {
        dryRun: maintenance.dryRun,
        skipValidationAcknowledged: false,
      };
      await maybeConfirmBranchEnvFileMatch(
        process.cwd(),
        preflight,
        safetyArgs
      );
      await enforceProductionSafeguards(preflight, safetyArgs);
    }
    await runMaintenance(
      maintenance,
      createMaintenanceRuntime(workspaceRoot, invocationDirectory)
    );
    exitProcess(0);
    return;
  }
  const parsedArgs = parseCliArgs();
  if (!parsedArgs) {
    exitProcess(0);
    return;
  }

  if (parsedArgs.verbose) {
    logger.level = 'debug';
  }

  const envFile = loadEnv();

  try {
    const projectRoot = process.cwd();
    let cliArgs = normalizeCliPathFilters(projectRoot, parsedArgs);
    const preflight = buildDeploymentPreflight(projectRoot, envFile);

    warnForMissingDefaultEnvFile(envFile);

    if (cliArgs.showConfig) {
      printConfig(cliArgs, envFile, preflight, projectRoot);
      exitProcess(0);
      return;
    }

    await enforceTargetEnvironment(envFile);
    await maybeConfirmBranchEnvFileMatch(projectRoot, preflight, cliArgs);
    cliArgs = await maybePromptForInitialScope(projectRoot, cliArgs);
    await enforceProductionSafeguards(preflight, cliArgs);
    if (cliArgs.buildSchema && !runSchemaGenerationBeforePush()) {
      throw new Error('Schema generation failed before sync.');
    }

    const discoveryOptions = getDiscoveryOptions(cliArgs);
    const variableFiles = cliArgs.enabledTypes.includes('variables')
      ? findVariableFiles(discoveryOptions)
      : [];
    const canopyFiles = cliArgs.enabledTypes.includes('canopy')
      ? findCanopyFiles(discoveryOptions)
      : [];
    const schemaFiles = cliArgs.enabledTypes.includes('schemas')
      ? findSchemaFiles(discoveryOptions)
      : [];
    const tableFiles = cliArgs.enabledTypes.includes('tables')
      ? findTableFiles(discoveryOptions)
      : [];
    const functionFiles = cliArgs.enabledTypes.includes('functions')
      ? findFunctionFiles(discoveryOptions).filter(
          func =>
            !cliArgs.functionTypes || cliArgs.functionTypes.includes(func.type)
        )
      : [];
    const aiFunctionFiles = cliArgs.enabledTypes.includes('ai-functions')
      ? findAiFunctionFiles(discoveryOptions)
      : [];
    const webhookFiles = cliArgs.enabledTypes.includes('webhooks')
      ? findWebhookFiles(discoveryOptions)
      : [];
    const triggerFiles = cliArgs.enabledTypes.includes('triggers')
      ? findTriggerFiles(discoveryOptions)
      : [];
    const jobFiles = cliArgs.enabledTypes.includes('jobs')
      ? findJobFiles(discoveryOptions)
      : [];

    await maybePromptForMissingEnvTokens(
      [
        ...canopyFiles,
        ...schemaFiles,
        ...webhookFiles,
        ...triggerFiles,
        ...tableFiles,
        ...variableFiles,
        ...jobFiles,
        ...aiFunctionFiles,
      ],
      cliArgs
    );

    printFlowLogo();
    logger.info(chalk.gray(`Base URL: ${getBaseUrl()}`));
    printNamespaceBanner();
    logger.info(
      chalk.gray(`Env File: ${chalk.cyan(formatEnvFileVisibility(envFile))}`)
    );
    logger.info(
      chalk.gray(`Current Branch: ${chalk.cyan(preflight.currentBranch)}`)
    );
    logger.info(
      chalk.gray(`Production Branch: ${chalk.cyan(preflight.productionBranch)}`)
    );
    logger.info(
      productionSafeguardsTriggered(preflight, cliArgs)
        ? chalk.yellow(
            `Production Safeguards: ${describeProductionSafeguards(preflight, cliArgs)}`
          )
        : chalk.gray(
            `Production Safeguards: ${describeProductionSafeguards(preflight, cliArgs)}`
          )
    );
    logger.info(
      cliArgs.dryRun
        ? chalk.yellow('Mode: Dry run')
        : cliArgs.deleteOrphans
          ? chalk.yellow('Mode: Delete orphaned resources')
          : chalk.gray('Mode: Safe sync (orphans will be reported)')
    );
    logger.info(
      chalk.gray(`Types: ${chalk.cyan(cliArgs.enabledTypes.join(', '))}`)
    );
    if (cliArgs.enabledTypes.includes('functions') && cliArgs.functionTypes) {
      logger.info(
        chalk.gray(
          `Function Types: ${chalk.cyan(cliArgs.functionTypes.join(', '))}`
        )
      );
    }
    logger.info(
      chalk.gray(`Scope: ${chalk.cyan(describeScope(cliArgs, projectRoot))}`)
    );
    if (cliArgs.force) {
      logger.info(
        chalk.gray(
          'Force: enabled (existing remote artifacts will be updated even if unchanged)'
        )
      );
    }
    if (cliArgs.buildSchema) {
      logger.info(chalk.gray('Schema Build: enabled (--build-schema)'));
    }
    if (cliArgs.pathFilters.length > 0) {
      logger.info(chalk.gray('Orphans: skipped for scoped sync'));
    }
    logger.info(
      cliArgs.skipInvalid
        ? chalk.yellow('Validation: Skip invalid artifacts (--skip-invalid)')
        : chalk.gray(
            'Validation: Stop on invalid artifacts (use --skip-invalid to continue)'
          )
    );
    logger.info('');

    logger.info(chalk.cyan.bold(`[VALIDATION PHASE] ${thinRule(40)}`));
    logger.info(chalk.gray('Validating selected artifacts before sync...\n'));

    let validVariables = 0;
    let validCanopy = 0;
    let validSchemas = 0;
    let validWebhooks = 0;
    let validFunctions = 0;
    let validAiFunctions = 0;
    let validTriggers = 0;
    let validTables = 0;
    let validJobs = 0;
    let totalValidated = 0;
    let totalArtifacts = 0;

    for (const variable of variableFiles) {
      totalArtifacts++;
      if (
        validateVariableArtifact(
          variable.content,
          variable.filePath,
          cliArgs.skipInvalid
        )
      ) {
        validVariables++;
        totalValidated++;
      }
    }

    for (const canopy of canopyFiles) {
      totalArtifacts++;
      if (canopy.content && typeof canopy.content === 'object') {
        validCanopy++;
        totalValidated++;
      } else if (!cliArgs.skipInvalid) {
        throw new Error(
          `Invalid Canopy artifact structure in ${canopy.filePath}. Expected a JSON object.`
        );
      }
    }

    for (const schema of schemaFiles) {
      totalArtifacts++;
      if (
        validateSchemaArtifact(
          schema.content,
          schema.filePath,
          cliArgs.skipInvalid
        )
      ) {
        validSchemas++;
        totalValidated++;
      }
    }

    for (const table of tableFiles) {
      totalArtifacts++;
      if (
        validateTableArtifact(
          table.content,
          table.filePath,
          cliArgs.skipInvalid
        )
      ) {
        validTables++;
        totalValidated++;
      }
    }

    for (const func of functionFiles) {
      totalArtifacts++;
      if (
        validateFunctionArtifact(
          func.metadata,
          func.tsFilePath,
          cliArgs.skipInvalid
        )
      ) {
        validFunctions++;
        totalValidated++;
      }
    }

    for (const aiFunction of aiFunctionFiles) {
      totalArtifacts++;
      if (
        validateAiFunctionArtifact(
          aiFunction.content,
          aiFunction.filePath,
          cliArgs.skipInvalid
        )
      ) {
        validAiFunctions++;
        totalValidated++;
      }
    }

    for (const webhook of webhookFiles) {
      totalArtifacts++;
      if (
        validateWebhookArtifact(
          webhook.content,
          webhook.filePath,
          cliArgs.skipInvalid
        )
      ) {
        validWebhooks++;
        totalValidated++;
      }
    }

    for (const trigger of triggerFiles) {
      totalArtifacts++;
      if (
        validateTriggerArtifact(
          trigger.content,
          trigger.filePath,
          cliArgs.skipInvalid
        )
      ) {
        validTriggers++;
        totalValidated++;
      }
    }

    for (const job of jobFiles) {
      totalArtifacts++;
      if (validateJobArtifact(job.content, job.filePath, cliArgs.skipInvalid)) {
        validJobs++;
        totalValidated++;
      }
    }

    logger.info('');
    if (variableFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` Variables:  ${validVariables}/${variableFiles.length} validated`
          )
      );
    }
    if (canopyFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` Canopy:     ${validCanopy}/${canopyFiles.length} validated`
          )
      );
    }
    if (schemaFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` Schemas:    ${validSchemas}/${schemaFiles.length} validated`
          )
      );
    }
    if (tableFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` Tables:     ${validTables}/${tableFiles.length} validated`
          )
      );
    }
    if (functionFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` Functions:  ${validFunctions}/${functionFiles.length} validated`
          )
      );
    }
    if (aiFunctionFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` AI Functions: ${validAiFunctions}/${aiFunctionFiles.length} validated`
          )
      );
    }
    if (webhookFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` Webhooks:   ${validWebhooks}/${webhookFiles.length} validated`
          )
      );
    }
    if (triggerFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(
            ` Triggers:   ${validTriggers}/${triggerFiles.length} validated`
          )
      );
    }
    if (jobFiles.length > 0) {
      logger.info(
        chalk.green(checkMark) +
          chalk.gray(` Jobs:       ${validJobs}/${jobFiles.length} validated`)
      );
    }

    logger.info('');
    logger.info(
      chalk.green.bold(`${checkMark} Total: `) +
        chalk.green(
          `${totalValidated}/${totalArtifacts} artifacts validated successfully`
        )
    );
    logger.info('');

    logger.info(chalk.cyan.bold(`[SYNC PHASE] ${thinRule(45)}`));
    logger.info('');

    const client = createPolyApiClient();
    const summary = createSummary();
    const syncOptions = {
      dryRun: cliArgs.dryRun,
      force: cliArgs.force,
      discoveryOptions,
      detectOrphans: cliArgs.pathFilters.length === 0,
    };

    let createdVariables: any[] = [];
    if (cliArgs.enabledTypes.includes('variables')) {
      createdVariables = await syncVariables(
        client,
        summary.variables,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        syncOptions
      );
    }
    if (cliArgs.enabledTypes.includes('canopy')) {
      await syncCanopy(
        summary.canopy,
        { dryRun: cliArgs.dryRun, force: cliArgs.force },
        canopyFiles
      );
    }
    if (cliArgs.enabledTypes.includes('schemas')) {
      await syncSchemas(
        client,
        summary.schemas,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        syncOptions
      );
    }
    if (cliArgs.enabledTypes.includes('tables')) {
      await syncTables(
        client,
        summary.tables,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        syncOptions
      );
    }
    if (cliArgs.enabledTypes.includes('functions')) {
      await syncFunctions(
        client,
        summary.functions,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        {
          ...syncOptions,
          functionTypes: cliArgs.functionTypes ?? undefined,
        }
      );
    }
    if (cliArgs.enabledTypes.includes('ai-functions')) {
      await syncAiFunctions(
        client,
        summary.aiFunctions,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        syncOptions
      );
    }
    if (cliArgs.enabledTypes.includes('webhooks')) {
      await syncWebhooks(
        client,
        summary.webhooks,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        syncOptions
      );
    }
    if (cliArgs.enabledTypes.includes('triggers')) {
      await syncTriggers(
        client,
        summary.triggers,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        syncOptions
      );
    }
    if (cliArgs.enabledTypes.includes('jobs')) {
      await syncJobs(
        client,
        summary.jobs,
        summary.orphans,
        cliArgs.deleteOrphans,
        cliArgs.skipInvalid,
        syncOptions
      );
    }

    printSummary(summary, createdVariables, { dryRun: cliArgs.dryRun });

    const shouldRunGenerate =
      !cliArgs.dryRun &&
      !cliArgs.skipGenerate &&
      (cliArgs.enabledTypes.includes('functions') ||
        cliArgs.enabledTypes.includes('ai-functions'));
    const postPushGenerateSuccess = shouldRunGenerate
      ? runPolyGenerateAfterPush()
      : true;

    exitProcess(
      getTotalStats(summary).failed > 0 || !postPushGenerateSuccess ? 1 : 0
    );
  } catch (error) {
    logger.fatal(
      { error: serializeErrorForLog(error) },
      `Fatal error during synchronization: ${getErrorMessage(error)}`
    );
    exitProcess(1);
  }
}

// Run the CLI
installSignalHandlers();
main().catch(error => {
  logger.error(error instanceof Error ? error.message : 'Flow command failed.');
  exitProcess(1);
});
