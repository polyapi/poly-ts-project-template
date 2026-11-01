import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import * as dotenv from "dotenv";
import createClient from "openapi-fetch";
import type { paths } from "../sdk/schema";
import type { EnvLoadResult } from "./deploymentConfig";
import { parseBooleanEnv } from "./deploymentConfig";
import { mergeEnvironmentLayers, resolveWorkflowPolyConfig } from "./environment";
import { findWorkspaceRoot } from "./fileSystem";
import { chalk, logger, warningColor } from "./logger";

class OtpManager {
    private cachedOtp?: Promise<string>;

    async getHeaders(method: string): Promise<Record<string, string>> {
        if (
            !["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase()) ||
            !parseBooleanEnv("OTP_ENABLED", false)
        ) {
            return {};
        }

        this.cachedOtp ??= promptForHiddenInput(
            "OTP is required to modify resources. Enter OTP: ",
        ).catch(error => {
            this.cachedOtp = undefined;
            throw error;
        });

        return { "x-otp": await this.cachedOtp };
    }
}

const otpManager = new OtpManager();

async function promptForHiddenInput(prompt: string): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("OTP is required to modify resources, but no interactive terminal is available");
    }

    const mutedOutput = new Writable({
        write(chunk, encoding, callback) {
            if (!(mutedOutput as Writable & { muted?: boolean }).muted) {
                process.stdout.write(chunk, encoding as BufferEncoding);
            }
            callback();
        },
    }) as Writable & { muted?: boolean };

    const readline = createInterface({
        input: process.stdin,
        output: mutedOutput,
        terminal: true,
    });

    try {
        process.stdout.write(prompt);
        mutedOutput.muted = true;
        const answer = (await readline.question("")).trim();
        process.stdout.write("\n");

        if (!answer) {
            throw new Error("OTP is required to modify resources");
        }

        return answer;
    } finally {
        readline.close();
    }
}

/**
 * Load environment variables from dev.env files
 * @throws Error if required environment variables are missing
 */
export function loadEnv(): EnvLoadResult {
    const workspaceRoot = findWorkspaceRoot(process.cwd());
    const defaultWorkflowEnvPath = path.join(workspaceRoot, "workflows", "dev.env");
    const polyEnvPath = resolveWorkflowPolyConfig(workspaceRoot);
    const rootEnvPath = path.join(__dirname, "../../../dev.env");

    const envPathOverride = process.env.ENVPATH?.trim();
    const selectedEnvPath = envPathOverride ? resolveSelectedEnvPath(envPathOverride) : defaultWorkflowEnvPath;
    if (envPathOverride && !fs.existsSync(selectedEnvPath)) {
        throw new Error(`ENVPATH points to "${envPathOverride}", but that file does not exist.`);
    }

    const readLayer = (filename: string | null): NodeJS.ProcessEnv => {
        if (!filename || !fs.existsSync(filename)) return {};
        const result = dotenv.config({ path: filename, processEnv: {}, quiet: true });
        if (result.error) throw new Error(`Unable to load environment configuration: ${filename}`);
        return result.parsed ?? {};
    };
    const selectedValues = readLayer(selectedEnvPath);
    // Selected env file > shell settings > this workflow SDK's setup > legacy root env.
    Object.assign(process.env, mergeEnvironmentLayers(
        readLayer(rootEnvPath),
        readLayer(polyEnvPath),
        process.env,
        selectedValues,
    ));

    if (!process.env.TENANT_ID && process.env.POLY_TENANT_ID) {
        process.env.TENANT_ID = process.env.POLY_TENANT_ID;
    }
    if (!process.env.POLY_TENANT_ID && process.env.TENANT_ID) {
        process.env.POLY_TENANT_ID = process.env.TENANT_ID;
    }
    if (!process.env.POLYAPI_NAMESPACE && process.env.POLY_API_NAMESPACE) {
        process.env.POLYAPI_NAMESPACE = process.env.POLY_API_NAMESPACE;
    }
    if (!process.env.POLY_API_NAMESPACE && process.env.POLYAPI_NAMESPACE) {
        process.env.POLY_API_NAMESPACE = process.env.POLYAPI_NAMESPACE;
    }
    if (!process.env.POLYAPI_NAMESPACE && process.env.POLY_NAMESPACE) {
        process.env.POLYAPI_NAMESPACE = process.env.POLY_NAMESPACE;
    }

    // Validate required environment variables
    // Deviation from upstream Flow: this project accepts either the single
    // POLYAPI_NAMESPACE or the comma-separated POLYAPI_NAMESPACES (see utils/namespace.ts).
    const hasNamespace = Boolean(process.env.POLYAPI_NAMESPACE?.trim());
    const hasNamespaces = Boolean(process.env.POLYAPI_NAMESPACES?.trim());
    if (!hasNamespace && !hasNamespaces) {
        logger.error("\n" + chalk.bold.red("══════════════════════════════════════════════════════════"));
        logger.error(chalk.bold.red("             CONFIGURATION ERROR                          "));
        logger.error(chalk.bold.red("══════════════════════════════════════════════════════════"));
        logger.error(
            warningColor("\n[!] Missing required environment variable: ") +
                chalk.bold("POLYAPI_NAMESPACE (or POLYAPI_NAMESPACES)"),
        );
        logger.error(chalk.gray("\nAll artifacts must be namespaced for proper organization."));
        logger.error(chalk.gray("Please add this variable to your dev.env file.\n"));
        logger.error(chalk.cyan("Example:\n"));
        logger.error(chalk.white("  POLYAPI_NAMESPACE=example"));
        logger.error(chalk.white("  POLYAPI_NAMESPACES=example,other"));
        logger.error(chalk.gray("\nChecked:"));
        logger.error(chalk.dim(`  - ${rootEnvPath}`));
        logger.error(chalk.dim(`  - ${polyEnvPath ?? "workflow PolyAPI setup not found"}`));
        logger.error(chalk.dim(`  - ${defaultWorkflowEnvPath} (default)`));
        if (envPathOverride) {
            logger.error(chalk.dim(`  - ${selectedEnvPath} (ENVPATH)`));
        }
        logger.error(chalk.bold.red("\n══════════════════════════════════════════════════════════\n"));

        process.exit(1);
    }

    return {
        displayPath: envPathOverride || "workflows/dev.env",
        resolvedPath: selectedEnvPath,
        exists: fs.existsSync(selectedEnvPath),
        fromEnvPath: Boolean(envPathOverride),
        declaredTargetEnvId: selectedValues.TARGET_ENV_ID?.trim(),
    };
}

function resolveSelectedEnvPath(envPathOverride: string): string {
    if (path.isAbsolute(envPathOverride)) {
        return envPathOverride;
    }

    const workspaceRoot = findWorkspaceRoot(process.cwd());
    const normalizedOverride = envPathOverride.replace(/\\/g, "/");
    const isWorkflowsRelative = normalizedOverride === "workflows" || normalizedOverride.startsWith("workflows/");

    if (isWorkflowsRelative) {
        return path.resolve(workspaceRoot, envPathOverride);
    }

    const workflowsCandidate = path.resolve(workspaceRoot, "workflows", envPathOverride);
    if (fs.existsSync(workflowsCandidate)) {
        return workflowsCandidate;
    }

    const cwdCandidate = path.resolve(process.cwd(), envPathOverride);
    if (fs.existsSync(cwdCandidate)) {
        return cwdCandidate;
    }

    const workspaceCandidate = path.resolve(workspaceRoot, envPathOverride);
    if (fs.existsSync(workspaceCandidate)) {
        return workspaceCandidate;
    }

    return workflowsCandidate;
}

/**
 * Get the base URL for PolyAPI
 */
export function getBaseUrl(): string {
    return process.env.BASE_URL || "https://eu1.polyapi.io";
}

/**
 * Create a PolyAPI client instance
 */
export function createPolyApiClient(): ReturnType<typeof createClient<paths>> {
    const baseUrl = getBaseUrl();

    const client = createClient<paths>({
        baseUrl,
        headers: {
            "Content-Type": "application/json",
            ...(process.env.API_KEY && {
                Authorization: `Bearer ${process.env.API_KEY}`,
            }),
        },
    });

    client.use({
        async onRequest({ request }) {
            const otpHeaders = await getOtpHeaders(request.method);
            for (const [name, value] of Object.entries(otpHeaders)) {
                request.headers.set(name, value);
            }
            return request;
        },
    });

    return client;
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getOtpHeaders(method: string): Promise<Record<string, string>> {
    return otpManager.getHeaders(method);
}

export async function getDeleteHeaders(): Promise<Record<string, string>> {
    return getOtpHeaders("DELETE");
}
