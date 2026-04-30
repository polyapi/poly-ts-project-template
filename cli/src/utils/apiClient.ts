import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import chalk from 'chalk';
import * as dotenv from 'dotenv';
import createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import type { EnvLoadResult } from './deploymentConfig';
import { parseBooleanEnv } from './deploymentConfig';
import { findWorkspaceRoot } from './fileSystem';
import { logger } from './logger';

class OtpManager {
  private cachedOtp?: string;

  async getDeleteHeaders(): Promise<Record<string, string>> {
    if (!parseBooleanEnv('OTP_ENABLED', false)) {
      return {};
    }

    if (!this.cachedOtp) {
      this.cachedOtp = await promptForHiddenInput(
        'OTP is required to delete resources. Enter OTP: '
      );
    }

    return { 'x-otp': this.cachedOtp };
  }
}

const otpManager = new OtpManager();

async function promptForHiddenInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'OTP is required to delete resources, but no interactive terminal is available'
    );
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
    mutedOutput.muted = true;
    const answer = (await readline.question(prompt)).trim();
    process.stdout.write('\n');

    if (!answer) {
      throw new Error('OTP is required to delete resources');
    }

    return answer;
  } finally {
    readline.close();
  }
}

/**
 * Load environment variables from .env files
 * @throws Error if required environment variables are missing
 */
export function loadEnv(): EnvLoadResult {
  const polyEnvPath = resolvePolyEnvPath();
  const localEnvPath = path.join(__dirname, '../../.env');
  const rootEnvPath = path.join(__dirname, '../../../.env');

  // Load root .env first (lowest priority)
  if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath });
  }

  // Load CLI package .env (can override root)
  if (fs.existsSync(localEnvPath)) {
    dotenv.config({ path: localEnvPath, override: true });
  }

  // Load Poly CLI config if present (can override previous)
  if (polyEnvPath && fs.existsSync(polyEnvPath)) {
    dotenv.config({ path: polyEnvPath, override: true });
  }

  const envPathOverride = process.env.ENVPATH?.trim();
  const selectedEnvPath = envPathOverride
    ? resolveSelectedEnvPath(envPathOverride)
    : path.join(process.cwd(), '.env');

  if (envPathOverride && !fs.existsSync(selectedEnvPath)) {
    throw new Error(
      `ENVPATH points to "${envPathOverride}", but that file does not exist.`
    );
  }

  // Load the selected workspace env file (highest priority)
  if (fs.existsSync(selectedEnvPath)) {
    dotenv.config({ path: selectedEnvPath, override: true });
  }

  // Map Poly CLI env names to this CLI's expected names
  if (!process.env.BASE_URL && process.env.POLY_API_BASE_URL) {
    process.env.BASE_URL = process.env.POLY_API_BASE_URL;
  }
  if (!process.env.POLY_API_BASE_URL && process.env.BASE_URL) {
    process.env.POLY_API_BASE_URL = process.env.BASE_URL;
  }
  if (!process.env.API_KEY && process.env.POLY_API_KEY) {
    process.env.API_KEY = process.env.POLY_API_KEY;
  }
  if (!process.env.POLY_API_KEY && process.env.API_KEY) {
    process.env.POLY_API_KEY = process.env.API_KEY;
  }
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
  if (
    !process.env.POLYAPI_NAMESPACE ||
    process.env.POLYAPI_NAMESPACE.trim() === ''
  ) {
    logger.error(
      '\n' +
        chalk.bold.red(
          '══════════════════════════════════════════════════════════'
        )
    );
    logger.error(
      chalk.bold.red(
        '             CONFIGURATION ERROR                          '
      )
    );
    logger.error(
      chalk.bold.red(
        '══════════════════════════════════════════════════════════'
      )
    );
    logger.error(
      chalk.yellow('\n[!] Missing required environment variable: ') +
        chalk.bold('POLYAPI_NAMESPACE')
    );
    logger.error(
      chalk.gray('\nAll artifacts must be namespaced for proper organization.')
    );
    logger.error(chalk.gray('Please add this variable to your .env file.\n'));
    logger.error(chalk.cyan('Example:\n'));
    logger.error(chalk.white('  POLYAPI_NAMESPACE=example'));
    logger.error(chalk.gray('\nChecked:'));
    logger.error(chalk.dim(`  - ${rootEnvPath}`));
    logger.error(chalk.dim(`  - ${localEnvPath}`));
    logger.error(
      chalk.dim(
        `  - ${polyEnvPath ?? 'polyapi config not found (checked pnpm + node_modules/.poly)'}`
      )
    );
    logger.error(
      chalk.dim(`  - ${path.join(process.cwd(), '.env')} (current directory)`)
    );
    logger.error(
      chalk.bold.red(
        '\n══════════════════════════════════════════════════════════\n'
      )
    );

    process.exit(1);
  }

  return {
    displayPath: envPathOverride || '.env',
    resolvedPath: selectedEnvPath,
    exists: fs.existsSync(selectedEnvPath),
    fromEnvPath: Boolean(envPathOverride),
  };
}

function resolveSelectedEnvPath(envPathOverride: string): string {
  const cwdCandidate = path.resolve(process.cwd(), envPathOverride);
  if (fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const workspaceCandidate = path.resolve(workspaceRoot, envPathOverride);
  if (fs.existsSync(workspaceCandidate)) {
    return workspaceCandidate;
  }

  return cwdCandidate;
}

function findUp(relativePath: string): string | null {
  let current = process.cwd();

  while (true) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolvePolyEnvPath(): string | null {
  const fromPackage = resolvePolyEnvPathFromPackage();
  if (fromPackage) {
    return fromPackage;
  }

  const fromPnpm = findPnpmPolyEnvPath();
  if (fromPnpm) {
    return fromPnpm;
  }

  const fromNodeModules = findUp('node_modules/.poly/.config.env');
  if (fromNodeModules) {
    return fromNodeModules;
  }

  const fallback = path.join(
    __dirname,
    '../../../node_modules/.poly/.config.env'
  );
  return fs.existsSync(fallback) ? fallback : null;
}

function resolvePolyEnvPathFromPackage(): string | null {
  try {
    const pkgJsonPath = require.resolve('polyapi/package.json', {
      paths: [process.cwd()],
    });
    const pkgDir = path.dirname(pkgJsonPath);
    const nodeModulesDir = path.dirname(pkgDir);
    const candidate = path.join(nodeModulesDir, '.poly', '.config.env');
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function findPnpmPolyEnvPath(): string | null {
  const pnpmRoot = findUp('node_modules/.pnpm');
  if (!pnpmRoot) {
    return null;
  }

  const pnpmDir = path.join(pnpmRoot, 'node_modules/.pnpm');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(pnpmDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.startsWith('polyapi@')) {
      continue;
    }

    const candidate = path.join(
      pnpmDir,
      entry,
      'node_modules/.poly/.config.env'
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Get the base URL for PolyAPI
 */
export function getBaseUrl(): string {
  return process.env.BASE_URL || 'https://eu1.polyapi.io';
}

/**
 * Create a PolyAPI client instance
 */
export function createPolyApiClient(): ReturnType<typeof createClient<paths>> {
  const baseUrl = getBaseUrl();

  return createClient<paths>({
    baseUrl,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.API_KEY && {
        Authorization: `Bearer ${process.env.API_KEY}`,
      }),
    },
  });
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getDeleteHeaders(): Promise<Record<string, string>> {
  return otpManager.getDeleteHeaders();
}
