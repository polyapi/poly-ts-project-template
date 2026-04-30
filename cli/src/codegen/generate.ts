#!/usr/bin/env node
/**
 * Schema Generation Pipeline
 *
 * Runs the complete schema generation workflow:
 * 1. Generate TypeScript types from PolyAPI OpenAPI spec
 * 2. Generate TypeBox schemas from an optional local OpenAPI spec
 * 3. Generate JSON Schema files from TypeBox schemas
 */

import fs from 'node:fs';
import path from 'node:path';
import * as dotenv from 'dotenv';
import { logger } from '../utils/logger';
import {
  generate as generateTypeBox,
  parseOpenApiSpec,
} from './openapi-to-typebox';
import { generateArtifactSchemas } from './typebox-to-json-schema';

const DESIGNS_DIR_ENV_VAR = 'POLYAPI_DESIGNS_DIR';
const repoRoot = path.join(__dirname, '..', '..', '..');

function loadCodegenEnv(): void {
  const cliEnvPath = path.join(__dirname, '..', '..', '.env');

  if (fs.existsSync(cliEnvPath)) {
    dotenv.config({ path: cliEnvPath });
  }
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
    // Step 1: Keep the checked-in minimal SDK type surface.
    logger.info(
      'Step 1/3: Using checked-in minimal PolyAPI SDK type surface...'
    );
    logger.info(
      'To use a full generated SDK, replace src/sdk/schema.d.ts from your project tooling.\n'
    );

    // Step 2: Generate TypeBox schemas from OpenAPI spec
    logger.info('Step 2/3: Generating TypeBox schemas from OpenAPI spec...');
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

    // Step 3: Generate JSON Schema files from TypeBox
    logger.info('Step 3/3: Generating JSON Schema files...');
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
