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
  optional?: boolean;
};

const ENDPOINT_SCHEMA_TARGETS: Record<string, EndpointSchemaTarget> = {
  CreateApiFunctionDto: { path: '/functions/api', method: 'post' },
  CreateSchemaDto: { path: '/schemas', method: 'post' },
  UpdateSchemaDto: { path: '/schemas/{id}', method: 'patch' },
  CreateWebhookHandleDto: { path: '/webhooks', method: 'post' },
  UpdateWebhookHandleDto: { path: '/webhooks/{id}', method: 'patch' },
  CreateTriggerDto: { path: '/triggers', method: 'post' },
  GraphQLSubscriptionCreateDto: {
    path: '/subscriptions/graphql',
    method: 'post',
  },
  GraphQLSubscriptionUpdateDto: {
    path: '/subscriptions/graphql/{id}',
    method: 'patch',
  },
  CreateVariableDto: { path: '/variables', method: 'post' },
  UpdateVariableDto: { path: '/variables/{id}', method: 'patch' },
  CreateTableDto: { path: '/tables', method: 'post' },
  UpdateTableDto: { path: '/tables/{id}', method: 'patch' },
  CreateJobDto: { path: '/jobs', method: 'post' },
  UpdateJobDto: { path: '/jobs/{id}', method: 'patch' },
  CreateServerCustomFunctionDto: { path: '/functions/server', method: 'post' },
  CreateClientCustomFunctionDto: { path: '/functions/client', method: 'post' },
  CreateAiFunctionV2Dto: {
    path: '/functions/ai',
    method: 'post',
    optional: true,
  },
  UpdateAiFunctionV2Dto: {
    path: '/functions/ai/{id}',
    method: 'patch',
    optional: true,
  },
  CreateMCPServerDto: { path: '/mcp-servers', method: 'post', optional: true },
  UpdateMCPServerDto: {
    path: '/mcp-servers/{id}',
    method: 'patch',
    optional: true,
  },
};

// Request schemas that keep only the components they reference.
const PRUNED_SCHEMA_TARGETS = new Set([
  'CreateApiFunctionDto',
  'CreateMCPServerDto',
  'UpdateMCPServerDto',
]);

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

function patchVariableValueSchema(
  schemaDocument: Record<string, unknown>,
  schemaName: 'CreateVariableDto' | 'UpdateVariableDto'
): void {
  const components = schemaDocument.components as
    | Record<string, unknown>
    | undefined;
  const schemas = components?.schemas as Record<string, unknown> | undefined;
  const variableDto = schemas?.[schemaName] as
    | Record<string, unknown>
    | undefined;
  const properties = variableDto?.properties as
    | Record<string, unknown>
    | undefined;

  if (properties?.value !== undefined) {
    // Accept scalar env placeholders like "{{COMPANY_DOMAIN}}" and any JSON value.
    properties.value = true;
  }
}

function patchWebhookTemplateBodyRequirement(
  schemaDocument: Record<string, unknown>,
  schemaName: 'CreateWebhookHandleDto' | 'UpdateWebhookHandleDto'
): void {
  const components = schemaDocument.components as
    | Record<string, unknown>
    | undefined;
  const schemas = components?.schemas as Record<string, unknown> | undefined;
  const webhookDto = schemas?.[schemaName] as
    | Record<string, unknown>
    | undefined;

  if (!webhookDto || !Array.isArray(webhookDto.required)) {
    return;
  }

  webhookDto.required = webhookDto.required.filter(
    entry => String(entry).trim() !== 'templateBody'
  );

  if (Array.isArray(schemaDocument.required)) {
    schemaDocument.required = schemaDocument.required.filter(
      entry => String(entry).trim() !== 'templateBody'
    );
  }
}

export function patchKnownSchemaQuirks(
  schemaName: string,
  schemaDocument: Record<string, unknown>
): void {
  const schemas = (
    schemaDocument.components as
      | {
          schemas?: {
            KeyValueApiKeyEntrySource?: {
              properties?: { key?: { enum?: string[] } };
            };
          };
        }
      | undefined
  )?.schemas;
  const apiKeyEntry = schemas?.KeyValueApiKeyEntrySource?.properties?.key;
  if (apiKeyEntry) {
    // Native API-key auth has separate key and value entries.
    apiKeyEntry.enum = ['key', 'value'];
  }
  if (schemaName === 'CreateTableDto' || schemaName === 'UpdateTableDto') {
    patchTableDefaultSchema(schemaDocument);
  }

  if (
    schemaName === 'CreateVariableDto' ||
    schemaName === 'UpdateVariableDto'
  ) {
    patchVariableValueSchema(
      schemaDocument,
      schemaName as 'CreateVariableDto' | 'UpdateVariableDto'
    );
  }

  if (
    schemaName === 'CreateWebhookHandleDto' ||
    schemaName === 'UpdateWebhookHandleDto'
  ) {
    patchWebhookTemplateBodyRequirement(
      schemaDocument,
      schemaName as 'CreateWebhookHandleDto' | 'UpdateWebhookHandleDto'
    );
  }

  if (
    schemaName === 'CreateAiFunctionV2Dto' ||
    schemaName === 'UpdateAiFunctionV2Dto'
  ) {
    const components = schemaDocument.components as
      | Record<string, unknown>
      | undefined;
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    const aiDto = schemas?.[schemaName] as Record<string, unknown> | undefined;
    const properties = aiDto?.properties as Record<string, unknown> | undefined;
    if (properties) {
      // The API accepts string values such as TEXT, while the OpenAPI
      // document currently describes this as an untyped object.
      properties.type = { type: 'string' };
      properties.apiType = { type: 'string' };
      properties.returnType = { type: ['string', 'null'] };
      properties.returnTypeSchema = { type: ['object', 'null'] };
      properties.outputSchema = { type: ['object', 'null'] };
    }
  }

  if (
    schemaName === 'CreateMCPServerDto' ||
    schemaName === 'UpdateMCPServerDto'
  ) {
    const components = schemaDocument.components as
      | Record<string, unknown>
      | undefined;
    const schemas = components?.schemas as Record<string, unknown> | undefined;
    const argument = schemas?.MCPToolFunctionArgumentConfigDto as
      | Record<string, unknown>
      | undefined;
    const properties = argument?.properties as
      | Record<string, unknown>
      | undefined;
    if (properties) {
      // Hardcoded tool values can be strings, numbers, or booleans, as for AI
      // Function tools; the OpenAPI document describes them as objects.
      properties.value = true;
    }
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
    let requestBodySchema: OpenApiSchema;
    try {
      requestBodySchema = resolveRequestBodySchema(spec, target);
    } catch (error) {
      if (target.optional) {
        logger.warn(
          `  Skipped ${schemaName}: endpoint is not present in this OpenAPI spec`
        );
        continue;
      }
      throw error;
    }
    const schemaDocument = normalizeSchemaPatterns(
      buildSchemaDocument(requestBodySchema, spec)
    ) as Record<string, unknown>;
    patchKnownSchemaQuirks(schemaName, schemaDocument);
    if (PRUNED_SCHEMA_TARGETS.has(schemaName)) {
      const schemas = (schemaDocument.components as any).schemas;
      const used: Record<string, unknown> = {};
      const visit = (node: any): void => {
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        if (!node || typeof node !== 'object') return;
        if (
          typeof node.$ref === 'string' &&
          node.$ref.startsWith('#/components/schemas/')
        ) {
          const name = node.$ref.slice('#/components/schemas/'.length);
          if (!(name in used)) {
            used[name] = schemas[name];
            visit(schemas[name]);
          }
        }
        Object.values(node).forEach(visit);
      };
      visit({ $ref: schemaDocument.$ref });
      schemaDocument.components = { schemas: used };
    }

    // Safety net: OpenAPI currently marks this as required in some specs, but
    // existing webhook artefacts and API behavior do not require it for updates.
    if (schemaName === 'UpdateWebhookHandleDto') {
      patchWebhookTemplateBodyRequirement(
        schemaDocument,
        'UpdateWebhookHandleDto'
      );
    }

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
