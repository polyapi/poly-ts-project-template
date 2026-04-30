#!/usr/bin/env node
/**
 * OpenAPI to TypeBox Schema Generator
 *
 * Parses OpenAPI specifications and generates TypeBox schemas for:
 * - Request/response types
 * - Reusable component schemas
 * - Validation schemas
 *
 * Usage: tsx src/codegen/openapi-to-typebox.ts <openapi-spec-path> [output-path]
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../utils/logger';

type OpenApiReference = {
  $ref?: string;
};

type OpenApiSchema = OpenApiReference & {
  type?: string;
  items?: OpenApiSchema | OpenApiReference;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, OpenApiSchema | OpenApiReference>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema | OpenApiReference;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  nullable?: boolean;
  enum?: unknown[];
  description?: string;
};

type OpenApiDocument = {
  openapi?: string;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
};

interface GeneratorOptions {
  specPath: string;
  outputPath: string;
}

/**
 * Parse OpenAPI spec (JSON or YAML)
 */
function parseOpenApiSpec(specPath: string): OpenApiDocument {
  const content = fs.readFileSync(specPath, 'utf-8');
  const ext = path.extname(specPath).toLowerCase();

  if (ext === '.json') {
    return JSON.parse(content);
  } else if (ext === '.yaml' || ext === '.yml') {
    return parseYaml(content) as OpenApiDocument;
  } else {
    throw new Error(`Unsupported file extension: ${ext}`);
  }
}

/**
 * Convert OpenAPI type to TypeBox type constructor
 */
function openApiTypeToTypeBox(
  schema: OpenApiSchema | OpenApiReference,
  indent = 1
): string {
  const indentStr = '  '.repeat(indent);

  // Handle $ref - convert to schema name reference
  if ('$ref' in schema && schema.$ref) {
    const refName = schema.$ref.split('/').pop();
    return `${refName}Schema`;
  }

  // Cast to SchemaObject for remaining checks
  const schemaObj = schema as OpenApiSchema;

  // Handle array
  if (schemaObj.type === 'array') {
    const items = schemaObj.items as OpenApiSchema;
    const itemType = openApiTypeToTypeBox(items, indent);
    const constraints: string[] = [];

    if (schemaObj.minItems !== undefined)
      constraints.push(`minItems: ${schemaObj.minItems}`);
    if (schemaObj.maxItems !== undefined)
      constraints.push(`maxItems: ${schemaObj.maxItems}`);

    const constraintsStr =
      constraints.length > 0 ? `, { ${constraints.join(', ')} }` : '';
    return `Type.Array(${itemType}${constraintsStr})`;
  }

  // Handle object
  if (schemaObj.type === 'object' || schemaObj.properties) {
    const props: string[] = [];
    const required = schemaObj.required || [];

    if (schemaObj.properties) {
      for (const [propName, propSchema] of Object.entries(
        schemaObj.properties
      )) {
        const prop = propSchema as OpenApiSchema;
        const propType = openApiTypeToTypeBox(prop, indent + 1);
        const isRequired = required.includes(propName);
        const typeWrapper = isRequired
          ? propType
          : `Type.Optional(${propType})`;

        const description = prop.description
          ? `\n${indentStr}  /** ${prop.description} */`
          : '';
        props.push(
          `${description}\n${indentStr}  ${propName}: ${typeWrapper},`
        );
      }
    }

    const additionalProps =
      schemaObj.additionalProperties === false
        ? ', { additionalProperties: false }'
        : '';

    return `Type.Object({\n${props.join('\n')}\n${indentStr}}${additionalProps})`;
  }

  // Handle string with format/pattern
  if (schemaObj.type === 'string') {
    const constraints: string[] = [];

    if (schemaObj.minLength !== undefined)
      constraints.push(`minLength: ${schemaObj.minLength}`);
    if (schemaObj.maxLength !== undefined)
      constraints.push(`maxLength: ${schemaObj.maxLength}`);
    if (schemaObj.pattern) constraints.push(`pattern: '${schemaObj.pattern}'`);
    if (schemaObj.format) constraints.push(`format: '${schemaObj.format}'`);

    const constraintsStr =
      constraints.length > 0 ? `{ ${constraints.join(', ')} }` : '';
    return constraints.length > 0
      ? `Type.String(${constraintsStr})`
      : 'Type.String()';
  }

  // Handle number/integer
  if (schemaObj.type === 'integer' || schemaObj.type === 'number') {
    const constraints: string[] = [];

    if (schemaObj.minimum !== undefined)
      constraints.push(`minimum: ${schemaObj.minimum}`);
    if (schemaObj.maximum !== undefined)
      constraints.push(`maximum: ${schemaObj.maximum}`);

    const constraintsStr =
      constraints.length > 0 ? `{ ${constraints.join(', ')} }` : '';
    const typeConstructor =
      schemaObj.type === 'integer' ? 'Type.Integer' : 'Type.Number';
    return constraints.length > 0
      ? `${typeConstructor}(${constraintsStr})`
      : `${typeConstructor}()`;
  }

  // Handle boolean
  if (schemaObj.type === 'boolean') {
    return 'Type.Boolean()';
  }

  // Handle nullable
  if (schemaObj.nullable) {
    const baseType = openApiTypeToTypeBox(
      { ...schemaObj, nullable: false },
      indent
    );
    return `Type.Union([${baseType}, Type.Null()])`;
  }

  // Handle enum
  if (schemaObj.enum) {
    const literals = schemaObj.enum.map(val =>
      typeof val === 'string'
        ? `Type.Literal('${val}')`
        : `Type.Literal(${val})`
    );
    return literals.length === 1
      ? literals[0]
      : `Type.Union([${literals.join(', ')}])`;
  }

  // Fallback
  return 'Type.Any()';
}

/**
 * Find all $ref dependencies in a schema
 */
function findSchemaDependencies(schema: OpenApiSchema): Set<string> {
  const deps = new Set<string>();

  function traverse(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;

    if ('$ref' in obj && typeof obj.$ref === 'string') {
      const refName = obj.$ref.split('/').pop();
      if (refName) deps.add(refName);
    }

    if (Array.isArray(obj)) {
      obj.forEach(traverse);
    } else {
      Object.values(obj).forEach(traverse);
    }
  }

  traverse(schema);
  return deps;
}

/**
 * Topologically sort schemas by dependencies
 */
function topologicalSort(schemas: Record<string, OpenApiSchema>): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string) {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      // Circular dependency - just add it anyway
      return;
    }

    visiting.add(name);
    const schema = schemas[name];
    if (schema) {
      const deps = findSchemaDependencies(schema);
      for (const dep of deps) {
        if (schemas[dep]) {
          visit(dep);
        }
      }
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  for (const name of Object.keys(schemas)) {
    visit(name);
  }

  return sorted;
}

/**
 * Generate TypeBox schema code from OpenAPI components
 */
function generateTypeBoxSchemas(spec: OpenApiDocument): string {
  const lines: string[] = [
    '/**',
    ' * Auto-generated TypeBox schemas from OpenAPI specification',
    ' * DO NOT EDIT - generated by openapi-to-typebox.ts',
    ' */',
    '',
    "import { Type, Static } from '@sinclair/typebox';",
    '',
  ];

  // Generate schemas from components in topological order
  if (spec.components?.schemas) {
    const schemas = spec.components.schemas;
    const sortedNames = topologicalSort(schemas);

    for (const name of sortedNames) {
      const schemaObj = schemas[name];
      const description = schemaObj.description;

      if (description) {
        lines.push('/**');
        lines.push(` * ${description}`);
        lines.push(' */');
      }

      const typeBoxCode = openApiTypeToTypeBox(schemaObj, 0);
      lines.push(`export const ${name}Schema = ${typeBoxCode};`);
      lines.push('');
      lines.push(`export type ${name} = Static<typeof ${name}Schema>;`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Main generator function
 */
async function generate(options: GeneratorOptions): Promise<void> {
  logger.info(`Parsing OpenAPI spec: ${options.specPath}`);
  const spec = parseOpenApiSpec(options.specPath);

  logger.info(`Generating TypeBox schemas...`);
  const code = generateTypeBoxSchemas(spec);

  // Ensure output directory exists
  const outputDir = path.dirname(options.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  logger.info(`Writing to: ${options.outputPath}`);
  fs.writeFileSync(options.outputPath, code, 'utf-8');

  logger.info(`TypeBox schemas generated successfully!`);
}

// CLI entry point
if (require.main === module) {
  const specPath = process.argv[2];
  const outputPath = process.argv[3] || 'src/generated/openapi-schemas.ts';

  if (!specPath) {
    logger.error(
      'Usage: tsx openapi-to-typebox.ts <openapi-spec-path> [output-path]'
    );
    process.exit(1);
  }

  if (!fs.existsSync(specPath)) {
    logger.error(`Error: OpenAPI spec not found: ${specPath}`);
    process.exit(1);
  }

  generate({ specPath, outputPath }).catch(error => {
    logger.error({ error }, 'Generation failed');
    process.exit(1);
  });
}

export { generate, generateTypeBoxSchemas, parseOpenApiSpec };
