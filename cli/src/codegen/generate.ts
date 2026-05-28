#!/usr/bin/env node
/**
 * Schema Generation Pipeline
 *
 * Runs the complete schema generation workflow:
 * 1. Generate TypeScript types from PolyAPI OpenAPI spec
 * 2. Generate API endpoint JSON schemas from OpenAPI request-body DTOs
 * 3. Generate TypeBox schemas from an optional local OpenAPI spec
 * 4. Generate JSON Schema files from TypeBox schemas
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as dotenv from 'dotenv';
import { logger } from '../utils/logger';
import { findWorkspaceRoot } from '../utils/fileSystem';
import { generateEndpointSchemas } from './openapi-endpoint-schemas';
import {
  generate as generateTypeBox,
  parseOpenApiSpec,
} from './openapi-to-typebox';
import { generateArtifactSchemas } from './typebox-to-json-schema';

const DESIGNS_DIR_ENV_VAR = 'POLYAPI_DESIGNS_DIR';
const OPENAPI_SPEC_URL_ENV_VAR = 'POLYAPI_OPENAPI_SPEC_URL';
const DEFAULT_OPENAPI_SPEC_URL = 'https://eu1.polyapi.io/swagger-json';
const repoRoot = path.join(__dirname, '..', '..', '..');
const execFileAsync = promisify(execFile);

function loadCodegenEnv(): void {
  const envPathOverride = process.env.ENVPATH?.trim();
  const selectedEnvPath = envPathOverride
    ? resolveCodegenSelectedEnvPath(envPathOverride)
    : path.join(findWorkspaceRoot(process.cwd()), 'workflows', '.env');

  if (fs.existsSync(selectedEnvPath)) {
    dotenv.config({ path: selectedEnvPath, override: true });
  }
}

function resolveCodegenSelectedEnvPath(envPathOverride: string): string {
  if (path.isAbsolute(envPathOverride)) {
    return envPathOverride;
  }

  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const normalizedOverride = envPathOverride.replace(/\\/g, '/');
  const isWorkflowsRelative =
    normalizedOverride === 'workflows' ||
    normalizedOverride.startsWith('workflows/');

  if (isWorkflowsRelative) {
    return path.resolve(workspaceRoot, envPathOverride);
  }

  const workflowsCandidate = path.resolve(
    workspaceRoot,
    'workflows',
    envPathOverride
  );
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

function resolveDesignsDir(): string | null {
  const configuredDir = process.env[DESIGNS_DIR_ENV_VAR];

  if (!configuredDir) {
    return null;
  }

  return path.isAbsolute(configuredDir)
    ? configuredDir
    : path.resolve(repoRoot, configuredDir);
}

function getOpenApiSpecUrl(): string {
  const configuredUrl = process.env[OPENAPI_SPEC_URL_ENV_VAR]?.trim();
  return configuredUrl || DEFAULT_OPENAPI_SPEC_URL;
}

function findOpenApiSpecPaths(searchDir: string): string[] {
  const specPaths: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!['.json', '.yaml', '.yml'].includes(extension)) {
        continue;
      }

      try {
        const spec = parseOpenApiSpec(entryPath);
        if (spec.openapi) {
          specPaths.push(entryPath);
        }
      } catch {
        // Ignore non-OpenAPI documents while scanning the designs directory.
      }
    }
  }

  walk(searchDir);
  return specPaths.sort();
}

function discoverOpenApiSpecPath(searchDir: string): string {
  if (!fs.existsSync(searchDir)) {
    throw new Error(`Designs directory not found: ${searchDir}`);
  }

  if (!fs.statSync(searchDir).isDirectory()) {
    throw new Error(`Designs directory is not a directory: ${searchDir}`);
  }

  const openApiSpecPaths = findOpenApiSpecPaths(searchDir);
  if (openApiSpecPaths.length > 1) {
    throw new Error(
      [
        `Multiple OpenAPI specs found under ${searchDir}:`,
        ...openApiSpecPaths.map(specPath => `- ${specPath}`),
        `Set ${DESIGNS_DIR_ENV_VAR} to a narrower folder.`,
      ].join('\n')
    );
  }

  if (openApiSpecPaths.length === 1) {
    return openApiSpecPaths[0];
  }

  throw new Error(`No OpenAPI specs found under ${searchDir}`);
}

async function main() {
  loadCodegenEnv();
  logger.info('Starting schema generation pipeline...\n');

  try {
    // Step 1: Generate TypeScript types from PolyAPI OpenAPI spec.
    const specUrl = getOpenApiSpecUrl();
    logger.info(
      `Step 1/4: Generating TypeScript types from PolyAPI (${specUrl})...`
    );
    const sdkOutputPath = path.join(__dirname, '..', 'sdk', 'schema.d.ts');
    await execFileAsync('openapi-typescript', [specUrl, '-o', sdkOutputPath]);
    logger.info('TypeScript types generated\n');

    // Step 2: Generate endpoint request-body schemas from the OpenAPI contract.
    logger.info('Step 2/4: Generating endpoint request-body schemas...');
    const endpointSchemasOutputDir = path.join(
      __dirname,
      '..',
      '..',
      'schemas',
      'openapi'
    );
    await generateEndpointSchemas(specUrl, endpointSchemasOutputDir);
    logger.info('Endpoint request-body schemas generated\n');

    // Step 3: Generate TypeBox schemas from OpenAPI spec
    logger.info('Step 3/4: Generating TypeBox schemas from OpenAPI spec...');
    const designsDir = resolveDesignsDir();
    if (!designsDir) {
      logger.info(
        `Skipping local OpenAPI schema generation (${DESIGNS_DIR_ENV_VAR} not set)\n`
      );
    } else {
      logger.info(`Scanning for OpenAPI spec in: ${designsDir}`);
      const specPath = discoverOpenApiSpecPath(designsDir);
      logger.info(`Using OpenAPI spec: ${specPath}`);
      const outputPath = path.join(
        __dirname,
        '..',
        'generated',
        'openapi-schemas.ts'
      );
      await generateTypeBox({ specPath, outputPath });
      logger.info('TypeBox schemas generated\n');
    }

    // Step 4: Generate JSON Schema files from TypeBox
    logger.info('Step 4/4: Generating JSON Schema files...');
    await generateArtifactSchemas();
    logger.info('JSON Schema files generated\n');

    logger.info('Schema generation complete!');
  } catch (error) {
    logger.error({ error }, 'Schema generation failed');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { main as generate };
