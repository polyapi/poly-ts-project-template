import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { logger } from '../utils/logger';

type OpenApiSchema = Record<string, unknown>;
type OpenApiRequestBody = {
  content?: Record<string, { schema?: OpenApiSchema }>;
};
type OpenApiOperation = {
  requestBody?: OpenApiRequestBody;
};
type OpenApiPathItem = Record<string, OpenApiOperation | undefined>;
type OpenApiDocument = {
  paths?: Record<string, OpenApiPathItem>;
  components?: Record<string, unknown>;
};

type EndpointSchemaTarget = {
  method: 'post' | 'patch';
  path: string;
};

const ENDPOINT_SCHEMA_TARGETS: Record<string, EndpointSchemaTarget> = {
  CreateSchemaDto: { path: '/schemas', method: 'post' },
  UpdateSchemaDto: { path: '/schemas/{id}', method: 'patch' },
  CreateWebhookHandleDto: { path: '/webhooks', method: 'post' },
  UpdateWebhookHandleDto: { path: '/webhooks/{id}', method: 'patch' },
  CreateTriggerDto: { path: '/triggers', method: 'post' },
  CreateVariableDto: { path: '/variables', method: 'post' },
  UpdateVariableDto: { path: '/variables/{id}', method: 'patch' },
  CreateTableDto: { path: '/tables', method: 'post' },
  UpdateTableDto: { path: '/tables/{id}', method: 'patch' },
  CreateJobDto: { path: '/jobs', method: 'post' },
  UpdateJobDto: { path: '/jobs/{id}', method: 'patch' },
  CreateServerCustomFunctionDto: { path: '/functions/server', method: 'post' },
  CreateClientCustomFunctionDto: { path: '/functions/client', method: 'post' },
};

function fetchOpenApiSpec(specUrl: string): Promise<OpenApiDocument> {
  return new Promise((resolve, reject) => {
    https
      .get(specUrl, response => {
        let body = '';
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body) as OpenApiDocument);
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function resolveRequestBodySchema(
  spec: OpenApiDocument,
  target: EndpointSchemaTarget
): OpenApiSchema {
  const operation = spec.paths?.[target.path]?.[
    target.method
  ] as OpenApiOperation | null;

  const schema = operation?.requestBody?.content?.['application/json']?.schema;
  if (!schema) {
    throw new Error(
      `No application/json request body schema for ${target.method.toUpperCase()} ${target.path}`
    );
  }

  return schema;
}

function buildSchemaDocument(
  requestBodySchema: OpenApiSchema,
  spec: OpenApiDocument
): Record<string, unknown> {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...requestBodySchema,
    ...(spec.components ? { components: spec.components } : {}),
  };
}

function normalizeDelimitedPattern(pattern: string): string {
  const match = pattern.match(/^\/(.+)\/([a-z]*)$/i);
  if (!match) {
    return pattern;
  }

  const [, body] = match;
  return body;
}

function normalizeSchemaPatterns(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeSchemaPatterns(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === 'pattern' && typeof nestedValue === 'string') {
      normalized[key] = normalizeDelimitedPattern(nestedValue);
    } else {
      normalized[key] = normalizeSchemaPatterns(nestedValue);
    }
  }

  return normalized;
}

function patchTableDefaultSchema(
  schemaDocument: Record<string, unknown>
): void {
  const components = schemaDocument.components as
    | Record<string, unknown>
    | undefined;
  const schemas = components?.schemas as Record<string, unknown> | undefined;
  const tableColumnDto = schemas?.TableColumnDto as
    | Record<string, unknown>
    | undefined;
  const properties = tableColumnDto?.properties as
    | Record<string, unknown>
    | undefined;

  if (properties?.default !== undefined) {
    // Accept scalar SQL defaults (e.g. "now()", "gen_random_uuid()") as well as objects.
    properties.default = true;
  }
}

function patchKnownSchemaQuirks(
  schemaName: string,
  schemaDocument: Record<string, unknown>
): void {
  if (schemaName === 'CreateTableDto' || schemaName === 'UpdateTableDto') {
    patchTableDefaultSchema(schemaDocument);
  }
}

export async function generateEndpointSchemas(
  specUrl: string,
  outputDir: string
): Promise<void> {
  logger.info(`Fetching OpenAPI spec for endpoint schemas: ${specUrl}`);
  const spec = await fetchOpenApiSpec(specUrl);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const [schemaName, target] of Object.entries(ENDPOINT_SCHEMA_TARGETS)) {
    const requestBodySchema = resolveRequestBodySchema(spec, target);
    const schemaDocument = normalizeSchemaPatterns(
      buildSchemaDocument(requestBodySchema, spec)
    ) as Record<string, unknown>;
    patchKnownSchemaQuirks(schemaName, schemaDocument);
    const outputPath = path.join(outputDir, `${schemaName}.schema.json`);
    fs.writeFileSync(
      outputPath,
      JSON.stringify(schemaDocument, null, 2),
      'utf-8'
    );
    logger.info(
      `  Wrote ${schemaName}.schema.json (${target.method.toUpperCase()} ${target.path})`
    );
  }
}
