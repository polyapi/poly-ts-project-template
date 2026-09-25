#!/usr/bin/env node

/**
 * PolyAPI Sync CLI - Main Entry Point
 *
 * Synchronizes local artifacts (schemas, webhooks, functions, triggers) with PolyAPI.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import chalk from "chalk";
import { findAiFunctionFiles, syncAiFunctions } from "./artefacts/aiFunctions";
import { findCanopyFiles, syncCanopy } from "./artefacts/canopy";
import { findFunctionFiles, getPolyCliEnv, syncFunctions, writePolyGenerateProvenance } from "./artefacts/functions";
import { findJobFiles, syncJobs } from "./artefacts/jobs";
import { findSchemaFiles, syncSchemas } from "./artefacts/schemas";
import { findTableFiles, syncTables } from "./artefacts/tables";
import { findTriggerFiles, syncTriggers } from "./artefacts/triggers";
import { findVariableFiles, syncVariables } from "./artefacts/variables";
import { findWebhookFiles, syncWebhooks } from "./artefacts/webhooks";
import {
    confirmPushDynamicPlan,
    executePushDynamicPlan,
    type PushDynamicArgs,
    type PushDynamicPlan,
    planPushDynamic,
} from "./commands/pushDynamic";
import { createSummary, getTotalStats } from "./types/summary";
import { createPolyApiClient, getBaseUrl, loadEnv } from "./utils/apiClient";
import {
    buildDeploymentPreflight,
    expectedBranchEnvFileExists,
    getPolyprodExecKey,
    getProductionConfirmationValue,
    resolveBranchEnvFile,
} from "./utils/deploymentConfig";
import { collectMissingEnvTokenRefs, printMissingEnvTokenWarning } from "./utils/envPreflight";
import { findWorkspaceRoot, type WalkDirOptions } from "./utils/fileSystem";
import { bullet, checkMark, createHeader, heavyRule, logger, thinRule } from "./utils/logger";
import { printFlowLogo } from "./utils/logo";
import { printNamespaceBanner } from "./utils/namespace";
import {
    validateAiFunctionArtifact,
    validateFunctionArtifact,
    validateJobArtifact,
    validateSchemaArtifact,
    validateTableArtifact,
    validateTriggerArtifact,
    validateVariableArtifact,
    validateWebhookArtifact,
} from "./utils/validation";

type ArtifactType =
    | "canopy"
    | "variables"
    | "schemas"
    | "tables"
    | "functions"
    | "ai-functions"
    | "webhooks"
    | "triggers"
    | "jobs";

type FunctionTypeSelection = "client" | "server";

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

const SKIP_VALIDATION_ACKNOWLEDGEMENT = "I know what am doing";

const DEFAULT_ENABLED_TYPES: ArtifactType[] = [
    "canopy",
    "variables",
    "schemas",
    "tables",
    "functions",
    "ai-functions",
    "webhooks",
    "triggers",
    "jobs",
];

const SUPPORTED_TYPE_SELECTIONS = [
    "canopy",
    "variables",
    "schemas",
    "tables",
    "functions",
    "client-functions",
    "server-functions",
    "ai-functions",
    "webhooks",
    "triggers",
    "jobs",
] as const;

function printRootHelp(): void {
    logger.info(`Flow is the PolyAPI deployment CLI for this repository.

Usage:
  flow push [options]
  flow push-dynamic [options] [file|directory|context.name ...]
  flow --help

Examples:
  flow push
  flow push --dry-run
  flow push --paths exampleWorkflow
  flow push --paths src/utilities --types functions,ai-functions,jobs
  flow push --delete-orphans
  flow push --help
  flow push-dynamic --dry-run
  flow push-dynamic --dry-run src/utilities/common/client/log.ts
  flow push-dynamic --help
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

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
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
        .split(",")
        .map((item) => item.trim())
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
        (item) => !SUPPORTED_TYPE_SELECTIONS.includes(item as (typeof SUPPORTED_TYPE_SELECTIONS)[number]),
    );
    if (invalidItems.length > 0) {
        throw new Error(
            `Unsupported --types value(s): ${invalidItems.join(
                ", ",
            )}. Expected one of: ${SUPPORTED_TYPE_SELECTIONS.join(", ")}`,
        );
    }

    const enabledTypes: ArtifactType[] = [];
    const functionTypes: FunctionTypeSelection[] = [];

    for (const item of items) {
        if (item === "client-functions" || item === "server-functions") {
            if (!enabledTypes.includes("functions")) {
                enabledTypes.push("functions");
            }
            const functionType = item === "client-functions" ? "client" : "server";
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
    const trimmedScope = rawScope.trim().replace(/\\/g, "/");
    const normalizedScope = trimmedScope.replace(/^\.\//, "");
    if (!normalizedScope) {
        throw new Error("Scope cannot be empty.");
    }

    // Candidates found relative to the invocation directory or the workspace
    // root must lie inside the workflows project: anything else would silently
    // sync nothing.
    const insideProject = (candidate: string): boolean => {
        const relative = path.relative(projectRoot, candidate);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    const invocationCwd = process.env.INIT_CWD?.trim();

    const candidates: Array<{ path: string; mustBeInside: boolean }> = [];
    if (path.isAbsolute(normalizedScope)) {
        candidates.push({ path: path.resolve(normalizedScope), mustBeInside: false });
    } else {
        // An explicitly cwd-relative scope (".", "./x", "../x") means the directory
        // the command was run from (pnpm's INIT_CWD), as in a shell.
        if (invocationCwd && /^\.\.?(\/|$)/.test(trimmedScope)) {
            candidates.push({ path: path.resolve(invocationCwd, trimmedScope), mustBeInside: true });
        }
        candidates.push({ path: path.resolve(projectRoot, normalizedScope), mustBeInside: false });
        if (!normalizedScope.startsWith("src/")) {
            candidates.push({ path: path.resolve(projectRoot, "src", normalizedScope), mustBeInside: false });
        }
        // Also relative to where the command was run and to the workspace root,
        // e.g. `workflows/src/sampleWorkflow` typed at the repo root — the forms
        // push-dynamic accepts for seeds.
        for (const base of [invocationCwd, findWorkspaceRoot(projectRoot)]) {
            if (base) {
                candidates.push({ path: path.resolve(base, normalizedScope), mustBeInside: true });
            }
        }
    }

    const attemptedPaths: string[] = [];
    for (const candidate of candidates) {
        const displayPath = path.relative(projectRoot, candidate.path) || candidate.path;
        if (!attemptedPaths.includes(displayPath)) {
            attemptedPaths.push(displayPath);
        }
        if (existsSync(candidate.path) && (!candidate.mustBeInside || insideProject(candidate.path))) {
            return candidate.path;
        }
    }

    throw new Error(`Could not resolve scope "${rawScope}" inside the workflows project. Tried: ${attemptedPaths.join(", ")}`);
}

function parseCliArgs(argv: string[] = process.argv.slice(2)): CliArgs | null {
    const normalizedArgv = argv.filter((arg) => arg !== "--");

    if (normalizedArgv.length === 0) {
        printRootHelp();
        return null;
    }

    if (normalizedArgv[0] === "--help" || normalizedArgv[0] === "-h" || normalizedArgv[0] === "help") {
        printRootHelp();
        return null;
    }

    const [command, ...rest] = normalizedArgv;
    if (command !== "push") {
        throw new Error(`Unknown command "${command}". Use "flow --help" for usage.`);
    }

    const { values, positionals } = parseNodeArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
            help: { type: "boolean", short: "h" },
            "dry-run": { type: "boolean" },
            force: { type: "boolean" },
            verbose: { type: "boolean" },
            "delete-orphans": { type: "boolean" },
            "build-schema": { type: "boolean" },
            "skip-invalid": { type: "boolean" },
            "skip-validation": { type: "string" },
            types: { type: "string" },
            paths: { type: "string" },
            "show-config": { type: "boolean" },
            "skip-generate": { type: "boolean" },
        },
    });

    if (values.help) {
        printPushHelp();
        return null;
    }

    if (positionals.length > 0) {
        throw new Error(`Unexpected positional arguments: ${positionals.join(", ")}`);
    }

    const parsedTypes = parseTypeSelection(parseCsvArgument(values.types));
    const skipValidationValue = values["skip-validation"];
    if (
        skipValidationValue !== undefined &&
        skipValidationValue !== SKIP_VALIDATION_ACKNOWLEDGEMENT
    ) {
        throw new Error(
            `--skip-validation must exactly equal "${SKIP_VALIDATION_ACKNOWLEDGEMENT}".`,
        );
    }

    return {
        dryRun: Boolean(values["dry-run"]),
        force: Boolean(values.force),
        verbose: Boolean(values.verbose),
        deleteOrphans: Boolean(values["delete-orphans"]),
        buildSchema: Boolean(values["build-schema"]),
        skipInvalid: Boolean(values["skip-invalid"]),
        skipValidationAcknowledged: skipValidationValue === SKIP_VALIDATION_ACKNOWLEDGEMENT,
        showConfig: Boolean(values["show-config"]),
        skipGenerate: Boolean(values["skip-generate"]),
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
    options: { dryRun?: boolean } = {},
): void {
    summary.endTime = Date.now();
    const duration = ((summary.endTime - summary.startTime) / 1000).toFixed(2);
    const totals = getTotalStats(summary);
    const variablesCollectionUrl = `${getBaseUrl().replace(/\/+$/, "")}/canopy/polyui/collections/variables`;

    logger.info(`\n${chalk.bold(heavyRule())}`);
    logger.info(chalk.bold.cyan("                    SYNCHRONIZATION SUMMARY                     "));
    logger.info(chalk.bold(`${heavyRule()}\n`));

    const artifacts = [
        { name: "Canopy", data: summary.canopy },
        { name: "Schemas", data: summary.schemas },
        { name: "Webhooks", data: summary.webhooks },
        { name: "Functions", data: summary.functions },
        { name: "AI Functions", data: summary.aiFunctions },
        { name: "Triggers", data: summary.triggers },
        { name: "Variables", data: summary.variables },
        { name: "Tables", data: summary.tables },
        { name: "Jobs", data: summary.jobs },
    ];

    artifacts.forEach(({ name, data }) => {
        if (data.created + data.updated + data.deleted + data.failed + data.skipped + data.planned > 0) {
            logger.info(chalk.bold(`${name}:`));
            if (data.created > 0) logger.info(`  ${chalk.green("[+]")} Created:  ${chalk.green(data.created)}`);
            if (data.updated > 0) logger.info(`  ${chalk.blue("[~]")} Updated:  ${chalk.blue(data.updated)}`);
            if (data.deleted > 0) logger.info(`  ${chalk.yellow("[-]")} Deleted:  ${chalk.yellow(data.deleted)}`);
            if (data.failed > 0) logger.info(`  ${chalk.red("[X]")} Failed:   ${chalk.red(data.failed)}`);
            if (data.skipped > 0) logger.info(`  ${chalk.gray("[=]")} Skipped:  ${chalk.gray(data.skipped)}`);
            if (data.planned > 0) logger.info(`  ${chalk.blue("[?]")} Planned:  ${chalk.blue(data.planned)}`);
            logger.info("");
        }
    });

    logger.info(chalk.bold("Total:"));
    if (totals.created > 0) logger.info(`  ${chalk.green("[+]")} Created:  ${chalk.green(totals.created)}`);
    if (totals.updated > 0) logger.info(`  ${chalk.blue("[~]")} Updated:  ${chalk.blue(totals.updated)}`);
    if (totals.deleted > 0) logger.info(`  ${chalk.yellow("[-]")} Deleted:  ${chalk.yellow(totals.deleted)}`);
    if (totals.failed > 0) logger.info(`  ${chalk.red("[X]")} Failed:   ${chalk.red(totals.failed)}`);
    if (totals.skipped > 0) logger.info(`  ${chalk.gray("[=]")} Skipped:  ${chalk.gray(totals.skipped)}`);
    if (totals.planned > 0) logger.info(`  ${chalk.blue("[?]")} Planned:  ${chalk.blue(totals.planned)}`);

    logger.info(`\n${chalk.bold("Duration: ")}${chalk.cyan(`${duration}s`)}`);
    logger.info(chalk.bold(heavyRule()));

    // Show orphaned resources if any were found
    if (summary.orphans.length > 0) {
        logger.info(chalk.yellow.bold("\n[ORPHANED RESOURCES DETECTED]"));
        logger.info(chalk.gray("The following resources exist remotely but not locally:\n"));

        // Group orphans by type
        const orphansByType = {
            variable: summary.orphans.filter((o) => o.type === "variable"),
            schema: summary.orphans.filter((o) => o.type === "schema"),
            webhook: summary.orphans.filter((o) => o.type === "webhook"),
            function: summary.orphans.filter((o) => o.type === "function"),
            "ai-function": summary.orphans.filter((o) => o.type === "ai-function"),
            trigger: summary.orphans.filter((o) => o.type === "trigger"),
            table: summary.orphans.filter((o) => o.type === "table"),
            job: summary.orphans.filter((o) => o.type === "job"),
        };

        for (const [type, orphans] of Object.entries(orphansByType)) {
            if (orphans.length > 0) {
                logger.info(chalk.bold(`  ${type.charAt(0).toUpperCase() + type.slice(1)}s (${orphans.length}):`));
                orphans.forEach((orphan) => {
                    logger.info(chalk.dim(`    - ${orphan.name} (${orphan.context})`));
                });
                logger.info("");
            }
        }

        logger.info(chalk.yellow("To delete these orphaned resources, run with:"));
        logger.info(chalk.cyan("  pnpm workflows push --delete-orphans\n"));
        logger.info(chalk.bold(heavyRule()));
    }

    // Show reminder for newly created variables
    if (createdVariables.length > 0) {
        logger.info(chalk.yellow.bold("\n[REMINDER] Variables Created - Values Must Be Set"));
        logger.info(chalk.gray("The following variables were created and need values set in PolyAPI Canopy:\n"));

        for (const variable of createdVariables) {
            logger.info(chalk.bold(`  ${bullet} ${variable.name}`) + chalk.gray(` (${variable.context})`));
            if (variable.instruction) {
                logger.info(chalk.dim(`    ${variable.instruction}`));
            }
        }

        logger.info(chalk.cyan("\nTo set values, visit: ") + chalk.underline(variablesCollectionUrl));
        logger.info(chalk.bold(heavyRule()));
    }

    if (totals.failed > 0) {
        logger.info(chalk.red.bold("\n[WARNING] Completed with errors"));
    } else if (options.dryRun) {
        logger.info(chalk.blue.bold("\n[DRY-RUN] No remote changes were applied"));
    } else {
        logger.info(chalk.green.bold("\n[SUCCESS] Synchronization completed successfully"));
    }
    logger.info(chalk.bold(`${heavyRule()}\n`));
}

function runPolyGenerateAfterPush(): boolean {
    const workspaceRoot = findWorkspaceRoot(process.cwd());

    logger.info(chalk.cyan.bold(`\n[POST-PUSH] ${thinRule(47)}`));
    logger.info(chalk.gray(`Running: pnpm workflows exec poly generate (cwd: ${workspaceRoot})`));

    try {
        execFileSync("pnpm", ["workflows", "exec", "poly", "generate"], {
            cwd: workspaceRoot,
            stdio: "inherit",
            shell: process.platform === "win32",
            env: getPolyCliEnv(),
        });
        writePolyGenerateProvenance(workspaceRoot);
        logger.info(chalk.green(`${checkMark} Post-push generation completed\n`));
        return true;
    } catch (error) {
        logger.error({ error: serializeErrorForLog(error) }, `Post-push generation failed: ${getErrorMessage(error)}`);
        return false;
    }
}

function runSchemaGenerationBeforePush(): boolean {
    const cliRoot = path.resolve(__dirname, "..");

    logger.info(chalk.cyan.bold(`[PRE-PUSH] ${thinRule(48)}`));
    logger.info(chalk.gray(`Running: pnpm generate (cwd: ${cliRoot})`));

    try {
        execFileSync("pnpm", ["generate"], {
            cwd: cliRoot,
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        logger.info(chalk.green(`${checkMark} Pre-push schema generation completed\n`));
        return true;
    } catch (error) {
        logger.error(
            { error: serializeErrorForLog(error) },
            `Pre-push schema generation failed: ${getErrorMessage(error)}`,
        );
        return false;
    }
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message || error.name;
    }

    if (typeof error === "string") {
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
            ...(errorRecord.status !== undefined ? { status: errorRecord.status } : {}),
            ...(errorRecord.statusText !== undefined ? { statusText: errorRecord.statusText } : {}),
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
                                    ...(errorRecord.cause.stack ? { stack: errorRecord.cause.stack } : {}),
                                }
                              : errorRecord.cause,
                  }
                : {}),
        };
    }

    if (typeof error === "string") {
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
        if ((error as Error)?.name === "AbortError") {
            throw new Error("Prompt cancelled");
        }
        throw error;
    } finally {
        readline.close();
    }
}

function formatEnvFileVisibility(envFile: { displayPath: string; exists: boolean }): string {
    return envFile.exists ? envFile.displayPath : `${envFile.displayPath} (missing, not loaded)`;
}

function buildBranchEnvMismatchWarning(
    projectRoot: string,
    preflight: ReturnType<typeof buildDeploymentPreflight>,
    expectedEnvPath: string,
): string {
    const expectedEnvFile = path.relative(projectRoot, expectedEnvPath) || path.basename(expectedEnvPath);

    if (!preflight.envFile.exists) {
        return `Branch "${preflight.expectedEnvBranch}" expects env file "${expectedEnvFile}", but no workspace env file was loaded because "${preflight.envFile.displayPath}" is missing.`;
    }

    return `Branch "${preflight.expectedEnvBranch}" expects env file "${expectedEnvFile}", but the selected workspace env file is "${preflight.envFile.displayPath}".`;
}

function warnForMissingDefaultEnvFile(envFile: { exists: boolean; fromEnvPath: boolean }): void {
    if (envFile.exists || envFile.fromEnvPath) {
        return;
    }

    logger.warn(
        "No default env file was found at `workflows/dev.env`. Create it or set `ENVPATH` to point to a specific env file.",
    );
}

async function maybeConfirmBranchEnvFileMatch(
    projectRoot: string,
    preflight: ReturnType<typeof buildDeploymentPreflight>,
    cliArgs: Pick<CliArgs, "dryRun" | "skipValidationAcknowledged">,
): Promise<void> {
    if (!preflight.expectedEnvFile) {
        return;
    }

    if (!expectedBranchEnvFileExists(projectRoot, preflight)) {
        return;
    }

    const expectedEnvPath = resolveBranchEnvFile(projectRoot, preflight.expectedEnvFile);
    if (path.resolve(preflight.envFile.resolvedPath) === expectedEnvPath) {
        return;
    }

    const warningMessage = buildBranchEnvMismatchWarning(projectRoot, preflight, expectedEnvPath);

    logger.warn(chalk.yellow(`WARN: ${warningMessage}`));

    if (cliArgs.skipValidationAcknowledged) {
        logger.warn("Branch environment-file mismatch acknowledged non-interactively.");
        return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(`${warningMessage} Run interactively to confirm or update ENVPATH.`);
    }

    const answer = (await promptForConfirmation("Continue with this env file anyway? [y/N]: ")).toLowerCase();

    if (!["y", "yes"].includes(answer)) {
        throw new Error("Deployment cancelled because the selected env file was not confirmed for the current branch.");
    }
}

async function maybePromptForMissingEnvTokens(
    files: Parameters<typeof collectMissingEnvTokenRefs>[0],
    cliArgs: CliArgs,
): Promise<void> {
    const refs = collectMissingEnvTokenRefs(files);

    if (refs.length === 0) {
        return;
    }

    printMissingEnvTokenWarning(refs);

    if (cliArgs.skipValidationAcknowledged) {
        throw new Error(
            `Missing env-file values for deploy placeholders: ${[
                ...new Set(refs.map((ref) => ref.envName)),
            ]
                .sort()
                .join(", ")}`,
        );
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            `Missing env-file values for deploy placeholders in non-interactive mode: ${[
                ...new Set(refs.map((ref) => ref.envName)),
            ]
                .sort()
                .join(", ")}`,
        );
    }

    const answer = (
        await promptForConfirmation("Continue anyway and leave unresolved placeholders as-is? [y/N]: ")
    ).toLowerCase();

    if (!["y", "yes", "c", "continue"].includes(answer)) {
        throw new Error("Stopped so you can configure the missing env-file values and try again.");
    }
}

function productionSafeguardsTriggered(
    preflight: ReturnType<typeof buildDeploymentPreflight>,
    cliArgs: Pick<CliArgs, "dryRun" | "skipValidationAcknowledged">,
): boolean {
    return preflight.productionSensitive && !cliArgs.dryRun;
}

async function enforceProductionSafeguards(
    preflight: ReturnType<typeof buildDeploymentPreflight>,
    cliArgs: Pick<CliArgs, "dryRun" | "skipValidationAcknowledged">,
): Promise<void> {
    if (!productionSafeguardsTriggered(preflight, cliArgs)) {
        return;
    }

    if (!getPolyprodExecKey()) {
        throw new Error(
            "Production safeguards were triggered but POLYPROD_EXEC_KEY is not set. Set it before deploying.",
        );
    }

    if (cliArgs.skipValidationAcknowledged) {
        logger.warn("Production confirmation acknowledged non-interactively.");
        return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            `Production-sensitive deployment requires an interactive terminal so you can type "${getProductionConfirmationValue()}".`,
        );
    }

    const answer = await promptForConfirmation(
        `Production safeguards are active for "${
            preflight.currentBranch
        }". Type "${getProductionConfirmationValue()}" to continue: `,
    );

    if (answer !== getProductionConfirmationValue()) {
        throw new Error(
            `Production-sensitive deployment cancelled. Type "${getProductionConfirmationValue()}" exactly to continue.`,
        );
    }
}

async function maybePromptForInitialScope(projectRoot: string, cliArgs: CliArgs): Promise<CliArgs> {
    if (cliArgs.pathFilters.length > 0) {
        return cliArgs;
    }

    if (cliArgs.skipValidationAcknowledged) {
        logger.info(chalk.gray("Scope: full repository sync (acknowledged non-interactively)"));
        return cliArgs;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return cliArgs;
    }

    const rawScope = await promptForConfirmation(
        'Press Enter to sync the entire repo, or type a path like "exampleWorkflow" or "src/utilities": ',
    );
    if (!rawScope) {
        logger.info(chalk.gray("Scope: full repository sync"));
        return cliArgs;
    }

    const selectedScope = resolveScopeFilter(projectRoot, rawScope);
    logger.info(chalk.gray(`Scope: ${path.relative(projectRoot, selectedScope) || selectedScope}`));
    return {
        ...cliArgs,
        pathFilters: [selectedScope],
    };
}

function normalizeCliPathFilters(projectRoot: string, cliArgs: CliArgs): CliArgs {
    return {
        ...cliArgs,
        pathFilters: cliArgs.pathFilters.map((scope) => resolveScopeFilter(projectRoot, scope)),
    };
}

function getDiscoveryOptions(cliArgs: CliArgs): WalkDirOptions {
    return cliArgs.pathFilters.length > 0 ? { includePaths: cliArgs.pathFilters } : {};
}

function describeScope(cliArgs: CliArgs, projectRoot: string): string {
    if (cliArgs.pathFilters.length === 0) {
        return "full repo";
    }

    return cliArgs.pathFilters.map((scope) => path.relative(projectRoot, scope) || scope).join(", ");
}

function describeProductionSafeguards(
    preflight: ReturnType<typeof buildDeploymentPreflight>,
    cliArgs: Pick<CliArgs, "dryRun" | "skipValidationAcknowledged">,
): string {
    if (productionSafeguardsTriggered(preflight, cliArgs)) {
        return `triggered (${preflight.sensitiveReason})`;
    }

    if (preflight.productionSensitive && cliArgs.dryRun) {
        return "not triggered (dry-run)";
    }

    if (preflight.safeguardExemptionReason) {
        return `not triggered (${preflight.safeguardExemptionReason})`;
    }

    return "not triggered";
}

function printConfig(
    cliArgs: CliArgs,
    envFile: ReturnType<typeof loadEnv>,
    preflight: ReturnType<typeof buildDeploymentPreflight>,
    projectRoot: string,
    dynamic?: PushDynamicArgs,
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
                    pathFilters: cliArgs.pathFilters.map((scope) => path.relative(projectRoot, scope) || scope),
                },
                envFile,
                preflight,
                ...(dynamic
                    ? {
                          pushDynamic: {
                              ...dynamic,
                              // Never print the key itself.
                              executionApiKey: dynamic.executionApiKey ? "<set>" : undefined,
                              // main() copies the resolved --paths in only after this dump.
                              scopePaths: cliArgs.pathFilters.map((scope) => path.relative(projectRoot, scope) || scope),
                          },
                      }
                    : {}),
            },
            null,
            2,
        ),
    );
}

function printPushDynamicHelp(): void {
    logger.info(`\`flow push\` whose function step follows the call graph (dependency-aware deploy).

Everything else is identical to push: the same discovery, validation, artefact types in the
same order (variables, canopy, schemas, tables, functions, ai-functions, webhooks, triggers,
jobs), scope prompt, production safeguards, summary and post-push \`poly generate\`. Only the
functions step differs: a changed client function (CFX) is picked up by a server function (SFX)
only when that SFX is rebuilt, so changed functions are expanded to their transitive
client-function callers up to the first server function on every path, the trees are merged,
and the whole tree is deployed in dependency order.

Usage:
  flow push-dynamic [options] [file|directory|context.name ...]

Naming functions (as arguments or via --seeds) forces them as seeds: they and every function
that embeds them are deployed even when their code is unchanged, and automatic change detection
is OFF unless --seed-from or --paths is given. The intermediate client functions inside every
tree are compared with the target. Unless --paths, --types or --seed-from says otherwise, such a
run deploys only their trees (like push --paths <file>): no other artefact type, no scope prompt.
A run that names functions never detects or deletes orphans.

Shared with push:
  --dry-run           Show planned actions without changing anything remotely
  --paths <csv>       Scope: artefacts under these paths are synced and only functions under them
                      are compared for changes (the function closure is never scoped). A bare
                      workflow name means src/<workflow>
  --types <csv>       canopy,variables,schemas,tables,functions,client-functions,server-functions,
                      ai-functions,webhooks,triggers,jobs (function sub-types select functions)
  --force             Update unchanged artefacts (functions are governed by seeds, not --force)
  --delete-orphans, --build-schema, --skip-invalid, --show-config, --skip-generate, --verbose
                      as for push
  --skip-validation   Bypass interactive confirmations only when its value is exactly
                      "${SKIP_VALIDATION_ACKNOWLEDGEMENT}" (as for push)

Function seeds:
  --seeds <csv>              Forced seeds: function files, directories or context.name identities
  --seed-from <source>       remote: compare every function file (in scope) with the deployed code
                             (default when nothing is forced)
                             specs: offline compare against the generated SDK specs cache
                             none: only forced seeds (default when functions are named and
                             --paths is not given)

Function closure:
  --skip-unchanged-cfx       Do NOT re-add intermediate client functions whose deployed code is identical
                             (default: the whole tree is deployed)
  --through-sfx              Report only: also show callers of the server functions in the tree
  --why <context.name>       Print the seed → … → function chains (up to 25) and exit
  --hubs                     Print client functions by blast radius and exit
  --experimental-wildcards   EXPERIMENTAL: expand computed access (poly.utilities[key].toCents(...))
                             to every function that could match (over-approximates)

Output (--json, --hubs and --why imply --dry-run):
  --json                     Print the function plan as JSON on stdout (log lines go to stderr;
                             not combinable with --build-schema or a --types without functions)

Execution:
  --yes, -y                  Skip the y/N confirmation of the run (required for non-interactive runs)
  --max-leaves <n>           Ask for a typed confirmation above n server-function leaves (default 10)
  --execution-api-key <key>  Execution API key for server functions — optional, as for push
                             (precedence: POLYPROD_EXEC_KEY on production-sensitive branches >
                             --execution-api-key > FLOW_EXECUTION_API_KEY > polyConfig.executionApiKey)
  --help, -h                 Show this help

Notes:
  - Without --paths, an interactive run asks for a scope as push does, unless it only deploys the
    trees of named functions; a scope typed there counts as --paths.
  - Every function the plan deploys is validated (polyConfig and namespace), in scope or not;
    --skip-invalid does not apply to the function tree, where skipping one would strand its callers.
  - Production safeguards (typed "PROD" confirmation, POLYPROD_EXEC_KEY) apply exactly as for push.
  - Leaves flagged MUST are alwaysOn or cachePolyLibrary on the platform: they never recycle their
    pod, so a redeploy is the only way new client-function code reaches them.
  - Function seeds are detected by code only; an npm-pin or flag-only change is not a seed.
`);
}

type ParsedPushDynamic = {
    cliArgs: CliArgs;
    dynamic: PushDynamicArgs;
    /** Named functions without --paths/--types/--seed-from: only the function trees are deployed. */
    functionsOnly: boolean;
    /** --seed-from was given; otherwise a scope typed at the prompt re-enables detection like --paths. */
    seedFromExplicit: boolean;
};

function parsePushDynamicArgs(rest: string[]): ParsedPushDynamic | null {
    const { values, positionals } = parseNodeArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
            help: { type: "boolean", short: "h" },
            // shared with push
            "dry-run": { type: "boolean" },
            force: { type: "boolean" },
            verbose: { type: "boolean" },
            "delete-orphans": { type: "boolean" },
            "build-schema": { type: "boolean" },
            "skip-invalid": { type: "boolean" },
            "skip-validation": { type: "string" },
            types: { type: "string" },
            paths: { type: "string" },
            "show-config": { type: "boolean" },
            "skip-generate": { type: "boolean" },
            // dynamic function step
            seeds: { type: "string" },
            "seed-from": { type: "string" },
            "skip-unchanged-cfx": { type: "boolean" },
            "through-sfx": { type: "boolean" },
            json: { type: "boolean" },
            yes: { type: "boolean", short: "y" },
            "max-leaves": { type: "string" },
            "execution-api-key": { type: "string" },
            why: { type: "string" },
            hubs: { type: "boolean" },
            "experimental-wildcards": { type: "boolean" },
        },
    });

    if (values.help) {
        printPushDynamicHelp();
        return null;
    }

    // Positional arguments are forced seeds, exactly like --seeds. Naming
    // functions switches detection off unless --seed-from or --paths is explicit.
    const forcedSeeds = [...parseCsvArgument(values.seeds), ...positionals.map((item) => item.trim()).filter(Boolean)];
    const pathFilters = parseCsvArgument(values.paths);
    const seedFrom = (
        values["seed-from"] ?? (forcedSeeds.length > 0 && pathFilters.length === 0 ? "none" : "remote")
    ).trim();
    if (seedFrom !== "remote" && seedFrom !== "specs" && seedFrom !== "none") {
        throw new Error(`Unsupported --seed-from value "${seedFrom}". Expected remote, specs or none.`);
    }

    const rawMaxLeaves = values["max-leaves"];
    const maxLeaves = rawMaxLeaves === undefined ? 10 : Number(rawMaxLeaves);
    if (!Number.isInteger(maxLeaves) || maxLeaves < 0) {
        throw new Error(`--max-leaves must be a non-negative integer, got "${rawMaxLeaves}".`);
    }

    const skipValidationValue = values["skip-validation"];
    if (skipValidationValue !== undefined && skipValidationValue !== SKIP_VALIDATION_ACKNOWLEDGEMENT) {
        throw new Error(`--skip-validation must exactly equal "${SKIP_VALIDATION_ACKNOWLEDGEMENT}".`);
    }
    const skipValidationAcknowledged = skipValidationValue === SKIP_VALIDATION_ACKNOWLEDGEMENT;

    const executionApiKey = values["execution-api-key"]?.trim() || undefined;
    const why = values.why?.trim();
    const typeItems = parseCsvArgument(values.types);
    const parsedTypes = parseTypeSelection(typeItems);
    if ((values.hubs || why || values.json) && !parsedTypes.enabledTypes.includes("functions")) {
        throw new Error("--hubs, --why and --json report on functions; drop --types or include functions in it.");
    }
    if (values.json && values["build-schema"]) {
        throw new Error("--json cannot be combined with --build-schema (its output would corrupt the JSON on stdout).");
    }
    // Naming functions without --paths or --types deploys just their trees, the
    // way `flow push --paths <file>` syncs just that file; the other artefact
    // types join only when --types or --paths asks for them.
    const functionsOnly =
        forcedSeeds.length > 0 && pathFilters.length === 0 && typeItems.length === 0 && seedFrom === "none";
    // --json, --hubs and --why are report-only: they never reach a deploy, so
    // they must not trigger the production safeguards either.
    const dryRun = Boolean(values["dry-run"]) || Boolean(values.json) || Boolean(values.hubs) || Boolean(why);

    const cliArgs: CliArgs = {
        dryRun,
        force: Boolean(values.force),
        verbose: Boolean(values.verbose),
        deleteOrphans: Boolean(values["delete-orphans"]),
        buildSchema: Boolean(values["build-schema"]),
        skipInvalid: Boolean(values["skip-invalid"]),
        skipValidationAcknowledged,
        showConfig: Boolean(values["show-config"]),
        skipGenerate: Boolean(values["skip-generate"]),
        pathFilters,
        enabledTypes: functionsOnly ? ["functions"] : parsedTypes.enabledTypes,
        functionTypes: parsedTypes.functionTypes,
    };
    const dynamic: PushDynamicArgs = {
        dryRun,
        seeds: forcedSeeds,
        scopePaths: [], // filled from the resolved cliArgs.pathFilters in main()
        seedFrom,
        skipUnchangedCfx: Boolean(values["skip-unchanged-cfx"]),
        throughSfx: Boolean(values["through-sfx"]),
        json: Boolean(values.json),
        yes: Boolean(values.yes),
        maxLeaves,
        executionApiKey,
        skipGenerate: Boolean(values["skip-generate"]),
        why: why || undefined,
        hubs: Boolean(values.hubs),
        experimentalWildcards: Boolean(values["experimental-wildcards"]),
        skipValidationAcknowledged,
        verbose: Boolean(values.verbose),
    };
    return { cliArgs, dynamic, functionsOnly, seedFromExplicit: values["seed-from"] !== undefined };
}

async function main(): Promise<void> {
    // `push-dynamic` is `push` with a dependency-aware functions step: same
    // pipeline, same prompts and safeguards; only the function sync differs.
    const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
    let parsedArgs: CliArgs | null;
    let dynamic: PushDynamicArgs | undefined;
    let functionsOnly = false;
    let seedFromExplicit = false;
    if (rawArgs[0] === "push-dynamic") {
        let parsed: ParsedPushDynamic | null;
        try {
            parsed = parsePushDynamicArgs(rawArgs.slice(1));
        } catch (error) {
            logger.fatal(`${getErrorMessage(error)} Run "flow push-dynamic --help" for the accepted options.`);
            exitProcess(1);
            return;
        }
        if (!parsed) {
            exitProcess(0);
            return;
        }
        parsedArgs = parsed.cliArgs;
        dynamic = parsed.dynamic;
        functionsOnly = parsed.functionsOnly;
        seedFromExplicit = parsed.seedFromExplicit;
    } else {
        parsedArgs = parseCliArgs();
    }
    if (!parsedArgs) {
        exitProcess(0);
        return;
    }

    if (parsedArgs.verbose) {
        logger.level = "debug";
    }
    if (dynamic?.json) {
        // stdout carries only the JSON plan: the logger writes to stderr in this
        // mode (see utils/logger.ts) and dotenv's "injecting env" tip is muted.
        process.env.DOTENV_CONFIG_QUIET = "true";
    }

    const envFile = loadEnv();

    try {
        const projectRoot = process.cwd();
        let cliArgs = normalizeCliPathFilters(projectRoot, parsedArgs);
        const preflight = buildDeploymentPreflight(projectRoot, envFile);

        warnForMissingDefaultEnvFile(envFile);

        if (cliArgs.showConfig) {
            printConfig(cliArgs, envFile, preflight, projectRoot, dynamic);
            exitProcess(0);
            return;
        }

        await maybeConfirmBranchEnvFileMatch(projectRoot, preflight, cliArgs);
        // The report-only modes, and named functions with nothing else selected,
        // already say what to look at.
        const skipScopePrompt = Boolean(
            dynamic &&
                (dynamic.hubs ||
                    dynamic.why ||
                    (dynamic.seeds.length > 0 && cliArgs.enabledTypes.every((type) => type === "functions"))),
        );
        cliArgs = skipScopePrompt ? cliArgs : await maybePromptForInitialScope(projectRoot, cliArgs);
        if (dynamic) {
            dynamic.scopePaths = cliArgs.pathFilters;
            // A scope typed at the prompt counts as --paths: with named functions it
            // turns change detection back on, unless --seed-from was given.
            if (!seedFromExplicit && dynamic.seeds.length > 0 && cliArgs.pathFilters.length > 0) {
                dynamic.seedFrom = "remote";
            }
        }
        // Scoped runs skip orphans (as push does), and so do runs that name
        // functions: they are targeted, never a full reconciliation.
        const namedFunctions = Boolean(dynamic && dynamic.seeds.length > 0);
        const detectOrphans = cliArgs.pathFilters.length === 0 && !namedFunctions;
        await enforceProductionSafeguards(preflight, cliArgs);
        if (cliArgs.buildSchema && !runSchemaGenerationBeforePush()) {
            throw new Error("Schema generation failed before sync.");
        }

        const discoveryOptions = getDiscoveryOptions(cliArgs);
        const variableFiles = cliArgs.enabledTypes.includes("variables") ? findVariableFiles(discoveryOptions) : [];
        const canopyFiles = cliArgs.enabledTypes.includes("canopy") ? findCanopyFiles(discoveryOptions) : [];
        const schemaFiles = cliArgs.enabledTypes.includes("schemas") ? findSchemaFiles(discoveryOptions) : [];
        const tableFiles = cliArgs.enabledTypes.includes("tables") ? findTableFiles(discoveryOptions) : [];
        const functionFiles = cliArgs.enabledTypes.includes("functions")
            ? findFunctionFiles(discoveryOptions).filter(
                  (func) => !cliArgs.functionTypes || cliArgs.functionTypes.includes(func.type),
              )
            : [];
        const aiFunctionFiles = cliArgs.enabledTypes.includes("ai-functions")
            ? findAiFunctionFiles(discoveryOptions)
            : [];
        const webhookFiles = cliArgs.enabledTypes.includes("webhooks") ? findWebhookFiles(discoveryOptions) : [];
        const triggerFiles = cliArgs.enabledTypes.includes("triggers") ? findTriggerFiles(discoveryOptions) : [];
        const jobFiles = cliArgs.enabledTypes.includes("jobs") ? findJobFiles(discoveryOptions) : [];

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
            cliArgs,
        );

        if (!dynamic?.json) {
            printFlowLogo();
        }
        logger.info(chalk.gray(`Base URL: ${getBaseUrl()}`));
        printNamespaceBanner();
        logger.info(chalk.gray(`Env File: ${chalk.cyan(formatEnvFileVisibility(envFile))}`));
        logger.info(chalk.gray(`Current Branch: ${chalk.cyan(preflight.currentBranch)}`));
        logger.info(chalk.gray(`Production Branch: ${chalk.cyan(preflight.productionBranch)}`));
        logger.info(
            productionSafeguardsTriggered(preflight, cliArgs)
                ? chalk.yellow(`Production Safeguards: ${describeProductionSafeguards(preflight, cliArgs)}`)
                : chalk.gray(`Production Safeguards: ${describeProductionSafeguards(preflight, cliArgs)}`),
        );
        const modeLabel = cliArgs.dryRun
            ? "Dry run"
            : cliArgs.deleteOrphans
              ? "Delete orphaned resources"
              : "Safe sync (orphans will be reported)";
        logger.info(
            cliArgs.dryRun || cliArgs.deleteOrphans
                ? chalk.yellow(`Mode: ${modeLabel}${dynamic ? ` ${bullet} push-dynamic` : ""}`)
                : chalk.gray(`Mode: ${modeLabel}${dynamic ? ` ${bullet} push-dynamic` : ""}`),
        );
        if (dynamic && !dynamic.hubs) {
            logger.info(
                chalk.gray(
                    `Function seeds: ${dynamic.seeds.length > 0 ? `${dynamic.seeds.length} forced` : "auto-detect"} ${bullet} auto-detect: ${
                        dynamic.seedFrom === "none" ? "off" : dynamic.seedFrom
                    }${cliArgs.pathFilters.length > 0 ? " (scoped)" : ""} ${bullet} Intermediate CFX: ${
                        dynamic.skipUnchangedCfx ? "skipped when unchanged" : "re-added (whole tree)"
                    }${dynamic.throughSfx ? ` ${bullet} Tree expanded past SFX (report only)` : ""}`,
                ),
            );
        }
        logger.info(chalk.gray(`Types: ${chalk.cyan(cliArgs.enabledTypes.join(", "))}`));
        if (functionsOnly) {
            logger.info(
                chalk.gray(
                    "Other artefact types: skipped (named functions deploy only their trees; add --types or --paths to sync them too)",
                ),
            );
        }
        if (cliArgs.enabledTypes.includes("functions") && cliArgs.functionTypes) {
            logger.info(chalk.gray(`Function Types: ${chalk.cyan(cliArgs.functionTypes.join(", "))}`));
        }
        logger.info(chalk.gray(`Scope: ${chalk.cyan(describeScope(cliArgs, projectRoot))}`));
        if (cliArgs.force) {
            logger.info(chalk.gray("Force: enabled (existing remote artifacts will be updated even if unchanged)"));
        }
        if (cliArgs.buildSchema) {
            logger.info(chalk.gray("Schema Build: enabled (--build-schema)"));
        }
        if (cliArgs.pathFilters.length > 0) {
            logger.info(chalk.gray("Orphans: skipped for scoped sync"));
        } else if (namedFunctions) {
            logger.info(
                chalk.gray(
                    `Orphans: skipped (functions are named)${cliArgs.deleteOrphans ? "; --delete-orphans has no effect" : ""}`,
                ),
            );
        }
        logger.info(
            cliArgs.skipInvalid
                ? chalk.yellow("Validation: Skip invalid artifacts (--skip-invalid)")
                : chalk.gray("Validation: Stop on invalid artifacts (use --skip-invalid to continue)"),
        );
        logger.info("");

        logger.info(chalk.cyan.bold(`[VALIDATION PHASE] ${thinRule(40)}`));
        logger.info(chalk.gray("Validating selected artifacts before sync...\n"));

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
            if (validateVariableArtifact(variable.content, variable.filePath, cliArgs.skipInvalid)) {
                validVariables++;
                totalValidated++;
            }
        }

        for (const canopy of canopyFiles) {
            totalArtifacts++;
            if (canopy.content && typeof canopy.content === "object") {
                validCanopy++;
                totalValidated++;
            } else if (!cliArgs.skipInvalid) {
                throw new Error(`Invalid Canopy artifact structure in ${canopy.filePath}. Expected a JSON object.`);
            }
        }

        for (const schema of schemaFiles) {
            totalArtifacts++;
            if (validateSchemaArtifact(schema.content, schema.filePath, cliArgs.skipInvalid)) {
                validSchemas++;
                totalValidated++;
            }
        }

        for (const table of tableFiles) {
            totalArtifacts++;
            if (validateTableArtifact(table.content, table.filePath, cliArgs.skipInvalid)) {
                validTables++;
                totalValidated++;
            }
        }

        for (const func of functionFiles) {
            totalArtifacts++;
            if (validateFunctionArtifact(func.metadata, func.tsFilePath, cliArgs.skipInvalid)) {
                validFunctions++;
                totalValidated++;
            }
        }

        for (const aiFunction of aiFunctionFiles) {
            totalArtifacts++;
            if (validateAiFunctionArtifact(aiFunction.content, aiFunction.filePath, cliArgs.skipInvalid)) {
                validAiFunctions++;
                totalValidated++;
            }
        }

        for (const webhook of webhookFiles) {
            totalArtifacts++;
            if (validateWebhookArtifact(webhook.content, webhook.filePath, cliArgs.skipInvalid)) {
                validWebhooks++;
                totalValidated++;
            }
        }

        for (const trigger of triggerFiles) {
            totalArtifacts++;
            if (validateTriggerArtifact(trigger.content, trigger.filePath, cliArgs.skipInvalid)) {
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

        logger.info("");
        if (variableFiles.length > 0) {
            logger.info(
                chalk.green(checkMark) + chalk.gray(` Variables:  ${validVariables}/${variableFiles.length} validated`),
            );
        }
        if (canopyFiles.length > 0) {
            logger.info(chalk.green(checkMark) + chalk.gray(` Canopy:     ${validCanopy}/${canopyFiles.length} validated`));
        }
        if (schemaFiles.length > 0) {
            logger.info(chalk.green(checkMark) + chalk.gray(` Schemas:    ${validSchemas}/${schemaFiles.length} validated`));
        }
        if (tableFiles.length > 0) {
            logger.info(chalk.green(checkMark) + chalk.gray(` Tables:     ${validTables}/${tableFiles.length} validated`));
        }
        if (functionFiles.length > 0) {
            logger.info(
                chalk.green(checkMark) + chalk.gray(` Functions:  ${validFunctions}/${functionFiles.length} validated`),
            );
        }
        if (aiFunctionFiles.length > 0) {
            logger.info(
                chalk.green(checkMark) +
                    chalk.gray(` AI Functions: ${validAiFunctions}/${aiFunctionFiles.length} validated`),
            );
        }
        if (webhookFiles.length > 0) {
            logger.info(
                chalk.green(checkMark) + chalk.gray(` Webhooks:   ${validWebhooks}/${webhookFiles.length} validated`),
            );
        }
        if (triggerFiles.length > 0) {
            logger.info(
                chalk.green(checkMark) + chalk.gray(` Triggers:   ${validTriggers}/${triggerFiles.length} validated`),
            );
        }
        if (jobFiles.length > 0) {
            logger.info(chalk.green(checkMark) + chalk.gray(` Jobs:       ${validJobs}/${jobFiles.length} validated`));
        }

        logger.info("");
        logger.info(
            chalk.green.bold(`${checkMark} Total: `) +
                chalk.green(`${totalValidated}/${totalArtifacts} artifacts validated successfully`),
        );
        logger.info("");

        const client = createPolyApiClient();
        const dynamicContext = {
            client,
            projectRoot,
            workspaceRoot: findWorkspaceRoot(projectRoot),
            invocationCwd: process.env.INIT_CWD?.trim() || projectRoot,
            productionSensitive: preflight.productionSensitive,
            envDisplayPath: envFile.displayPath,
            currentBranch: preflight.currentBranch,
            confirm: promptForConfirmation,
            syncsOtherArtefacts: cliArgs.enabledTypes.some((type) => type !== "functions"),
            deletesOrphans: cliArgs.deleteOrphans,
        };
        let functionPlan: PushDynamicPlan | undefined;
        if (dynamic && cliArgs.enabledTypes.includes("functions")) {
            logger.info(chalk.cyan.bold(`[FUNCTION PLAN] ${thinRule(42)}`));
            logger.info(chalk.gray("Following the call graph from the changed/forced functions...\n"));
            const planned = await planPushDynamic(dynamic, dynamicContext, { detectOrphans });
            if (planned.kind === "exit") {
                exitProcess(planned.exitCode);
                return;
            }
            functionPlan = planned.plan;
            logger.info("");
            if (!cliArgs.dryRun && !(await confirmPushDynamicPlan(functionPlan, dynamic, dynamicContext))) {
                exitProcess(1);
                return;
            }
        } else if (dynamic) {
            if (dynamic.seeds.length > 0) {
                logger.warn(
                    chalk.yellow("Seeds were given but --types excludes functions; the function step is skipped."),
                );
            }
            if (!cliArgs.dryRun && !(await confirmPushDynamicPlan(undefined, dynamic, dynamicContext))) {
                exitProcess(1);
                return;
            }
        }

        logger.info(chalk.cyan.bold(`[SYNC PHASE] ${thinRule(45)}`));
        logger.info("");

        const summary = createSummary();
        const syncOptions = {
            dryRun: cliArgs.dryRun,
            force: cliArgs.force,
            discoveryOptions,
            detectOrphans,
        };

        let createdVariables: any[] = [];
        if (cliArgs.enabledTypes.includes("variables")) {
            createdVariables = await syncVariables(
                client,
                summary.variables,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                syncOptions,
            );
        }
        if (cliArgs.enabledTypes.includes("canopy")) {
            await syncCanopy(summary.canopy, { dryRun: cliArgs.dryRun, force: cliArgs.force }, canopyFiles);
        }
        if (cliArgs.enabledTypes.includes("schemas")) {
            await syncSchemas(
                client,
                summary.schemas,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                syncOptions,
            );
        }
        if (cliArgs.enabledTypes.includes("tables")) {
            await syncTables(
                client,
                summary.tables,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                syncOptions,
            );
        }
        if (dynamic && functionPlan) {
            logger.info(chalk.cyan(createHeader("FUNCTIONS")));
            await executePushDynamicPlan(
                functionPlan,
                dynamic,
                dynamicContext,
                summary.functions,
                summary.orphans,
                cliArgs.deleteOrphans,
            );
        } else if (!dynamic && cliArgs.enabledTypes.includes("functions")) {
            await syncFunctions(
                client,
                summary.functions,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                {
                    ...syncOptions,
                    functionTypes: cliArgs.functionTypes ?? undefined,
                },
            );
        }
        if (cliArgs.enabledTypes.includes("ai-functions")) {
            await syncAiFunctions(
                client,
                summary.aiFunctions,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                syncOptions,
            );
        }
        if (cliArgs.enabledTypes.includes("webhooks")) {
            await syncWebhooks(
                client,
                summary.webhooks,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                syncOptions,
            );
        }
        if (cliArgs.enabledTypes.includes("triggers")) {
            await syncTriggers(
                client,
                summary.triggers,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                syncOptions,
            );
        }
        if (cliArgs.enabledTypes.includes("jobs")) {
            await syncJobs(
                client,
                summary.jobs,
                summary.orphans,
                cliArgs.deleteOrphans,
                cliArgs.skipInvalid,
                syncOptions,
            );
        }

        printSummary(summary, createdVariables, { dryRun: cliArgs.dryRun });

        const shouldRunGenerate =
            !cliArgs.dryRun &&
            !cliArgs.skipGenerate &&
            (cliArgs.enabledTypes.includes("functions") || cliArgs.enabledTypes.includes("ai-functions"));
        const postPushGenerateSuccess = shouldRunGenerate ? runPolyGenerateAfterPush() : true;

        exitProcess(getTotalStats(summary).failed > 0 || !postPushGenerateSuccess ? 1 : 0);
    } catch (error) {
        logger.fatal(
            { error: serializeErrorForLog(error) },
            `Fatal error during synchronization: ${getErrorMessage(error)}`,
        );
        exitProcess(1);
    }
}

// Run the CLI
installSignalHandlers();
main();
