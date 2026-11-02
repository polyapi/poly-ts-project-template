import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOpenApiSchemaNames } from './openApiSchemaNames';

test('normalizes numeric schema names and references without changing status codes or source', () => {
  const source = {
    openapi: '3.0.2',
    components: {
      schemas: {
        '200': {
          type: 'object',
          example: { statusCode: 200, description: '200' },
        },
      },
    },
    paths: {
      '/weather': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/200' },
                },
              },
            },
          },
        },
      },
    },
  };
  const before = JSON.stringify(source);
  const result = normalizeOpenApiSchemaNames(source);
  assert.deepEqual(result.renames, ['200 -> Schema200']);
  assert.deepEqual(result.document, {
    ...source,
    components: { schemas: { Schema200: source.components.schemas['200'] } },
    paths: {
      '/weather': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Schema200' },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(JSON.stringify(source), before);
});

test('avoids existing names and updates discriminator mappings and JSON pointer references', () => {
  const source = {
    components: {
      schemas: {
        Schema200: { type: 'string' },
        '200': { type: 'object' },
        'a/b': { type: 'object' },
        choice: {
          discriminator: {
            propertyName: 'type',
            mapping: { success: '200', escaped: '#/components/schemas/a~1b' },
          },
          oneOf: [{ $ref: '#/components/schemas/200' }],
        },
      },
    },
  };
  const result = normalizeOpenApiSchemaNames(source);
  assert.deepEqual(result.renames, ['200 -> Schema200_2', 'a/b -> a_b']);
  const schemas = (result.document.components as typeof source.components)
    .schemas;
  assert.deepEqual(schemas.choice.discriminator.mapping, {
    success: 'Schema200_2',
    escaped: '#/components/schemas/a_b',
  });
  assert.equal(
    schemas.choice.oneOf[0].$ref,
    '#/components/schemas/Schema200_2'
  );
});

test('normalizes Swagger definitions before conversion and leaves external references alone', () => {
  const result = normalizeOpenApiSchemaNames({
    swagger: '2.0',
    definitions: { 'invalid-name': { type: 'string' } },
    responses: {
      first: { schema: { $ref: '#/definitions/invalid-name' } },
      external: { schema: { $ref: 'other.json#/definitions/invalid-name' } },
    },
  });
  assert.deepEqual(result.document, {
    swagger: '2.0',
    definitions: { invalid_name: { type: 'string' } },
    responses: {
      first: { schema: { $ref: '#/definitions/invalid_name' } },
      external: { schema: { $ref: 'other.json#/definitions/invalid-name' } },
    },
  });
});
