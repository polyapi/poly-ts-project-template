#!/usr/bin/env node
/**
 * TypeBox to JSON Schema Generator
 *
 * Compiles TypeBox schemas to JSON Schema Draft-07 format.
 * This allows using TypeBox as the source of truth while maintaining
 * JSON Schema files for validation and documentation.
 *
 * Usage: tsx src/codegen/typebox-to-json-schema.ts <typebox-file> [output-dir]
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { logger } from '../utils/logger';

interface GeneratorOptions {
  typeboxFilePath: string;
  outputDir: string;
}

/**
 * Convert TypeBox schema to JSON Schema
 *
 * TypeBox schemas already have a JSON Schema representation,
 * we just need to extract it and format it properly.
 */
function typeboxToJsonSchema(schema: TSchema): object {
  // TypeBox schemas are already JSON Schema compatible
  // We just need to ensure proper formatting
  const jsonSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...schema,
  };

  return jsonSchema;
}

/**
 * Extract exported schemas from a TypeBox module
 *
 * This dynamically imports the TypeBox schemas and extracts
 * all exported schemas (variables ending with 'Schema')
 */
async function extractSchemas(
  filePath: string
): Promise<Record<string, TSchema>> {
  const absolutePath = path.resolve(filePath);

  // Dynamic import to load the module
  const module = await import(absolutePath);

  const schemas: Record<string, TSchema> = {};

  // Extract all exports that end with 'Schema'
  for (const [key, value] of Object.entries(module)) {
    if (key.endsWith('Schema') && value && typeof value === 'object') {
      // Remove 'Schema' suffix for the output filename
      const schemaName = key.replace(/Schema$/, '');
      schemas[schemaName] = value as TSchema;
    }
  }

  return schemas;
}

/**
 * Generate JSON Schema files from TypeBox schemas
 */
async function generate(options: GeneratorOptions): Promise<void> {
  logger.info(`Loading TypeBox schemas from: ${options.typeboxFilePath}`);

  const schemas = await extractSchemas(options.typeboxFilePath);
  const schemaCount = Object.keys(schemas).length;

  if (schemaCount === 0) {
    logger.warn('No schemas found (expected exports ending with "Schema")');
    return;
  }

  logger.info(`Found ${schemaCount} schema(s) to generate`);

  // Ensure output directory exists
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }

  // Generate JSON Schema for each TypeBox schema
  for (const [name, schema] of Object.entries(schemas)) {
    const jsonSchema = typeboxToJsonSchema(schema);
    const outputPath = path.join(options.outputDir, `${name}.schema.json`);

    logger.info(`  Writing ${name}.schema.json`);
    fs.writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2), 'utf-8');
  }

  logger.info(
    `Generated ${schemaCount} JSON Schema file(s) in ${options.outputDir}`
  );
}

/**
 * Generate JSON schemas for artifact validation schemas
 * These are the schemas used by the CLI to validate artifact files
 */
async function generateArtifactSchemas(): Promise<void> {
  const schemasPath = path.join(__dirname, '..', 'utils', 'schemas.ts');
  const outputDir = path.join(__dirname, '..', '..', 'schemas');

  await generate({
    typeboxFilePath: schemasPath,
    outputDir,
  });
}

// CLI entry point
if (require.main === module) {
  const typeboxFile = process.argv[2];
  const outputDir = process.argv[3] || 'schemas';

  if (!typeboxFile) {
    // If no args, generate artifact schemas by default
    logger.info('Generating artifact validation schemas...');
    generateArtifactSchemas().catch(error => {
      logger.error({ error }, 'Generation failed');
      process.exit(1);
    });
  } else {
    if (!fs.existsSync(typeboxFile)) {
      logger.error(`Error: TypeBox file not found: ${typeboxFile}`);
      process.exit(1);
    }

    generate({ typeboxFilePath: typeboxFile, outputDir }).catch(error => {
      logger.error({ error }, 'Generation failed');
      process.exit(1);
    });
  }
}

export {
  extractSchemas,
  generate,
  generateArtifactSchemas,
  typeboxToJsonSchema,
};
