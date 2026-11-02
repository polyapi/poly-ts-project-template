import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanDescriptions,
  descriptionText,
  selectOperations,
} from './openApiPreparation';

test('operation selection preserves shared parameters and transitive schemas, removes unused operations, and leaves input unchanged', () => {
  const input = {
    openapi: '3.0.3',
    paths: {
      '/contacts': {
        parameters: [{ $ref: '#/components/parameters/id' }],
        get: {
          operationId: 'getContacts',
          responses: {
            200: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Parent' },
                },
              },
            },
          },
        },
        post: { operationId: 'createContact' },
      },
    },
    components: {
      parameters: {
        id: {
          name: 'id',
          in: 'query',
          schema: { $ref: '#/components/schemas/Id' },
        },
      },
      schemas: {
        Parent: {
          properties: { child: { $ref: '#/components/schemas/Child' } },
        },
        Child: { type: 'string' },
        Id: { type: 'integer' },
        Unused: { type: 'boolean' },
      },
    },
  };
  const before = JSON.stringify(input);
  const selected = selectOperations(input, ['getContacts']);
  assert.deepEqual(Object.keys(selected.paths['/contacts']), [
    'get',
    'parameters',
  ]);
  assert.deepEqual(Object.keys(selected.components.schemas), [
    'Parent',
    'Child',
    'Id',
  ]);
  assert.equal(JSON.stringify(input), before);
});

test('selection supports Swagger definitions, cycles and escaped pointers; rejects missing, duplicate and external references', () => {
  const input = {
    swagger: '2.0',
    paths: {
      '/test': {
        get: {
          operationId: 'test',
          responses: { 200: { schema: { $ref: '#/definitions/a~1b' } } },
        },
      },
    },
    definitions: {
      'a/b': { properties: { self: { $ref: '#/definitions/a~1b' } } },
      unused: { type: 'string' },
    },
  };
  assert.deepEqual(Object.keys(selectOperations(input, ['test']).definitions), [
    'a/b',
  ]);
  assert.throws(() => selectOperations(input, ['missing']), /found 0/);
  assert.throws(
    () =>
      selectOperations(
        {
          ...input,
          paths: { ...input.paths, '/duplicate': input.paths['/test'] },
        },
        ['test']
      ),
    /found 2/
  );
  assert.throws(
    () =>
      selectOperations(
        { ...input, definitions: { 'a/b': { $ref: 'other.json#/Thing' } } },
        ['test']
      ),
    /bundle external/
  );
});

test('HTML descriptions preserve readable blocks, decode entities and keep literal types', () => {
  assert.equal(
    descriptionText(
      'Use this API. <p><strong>OperationId:</strong>validatePhone</p>'
    ),
    'Use this API.\nOperationId:validatePhone'
  );
  assert.equal(
    descriptionText(
      '<p>A &amp; B &#x1F600;</p><ul><li>First</li><li>Second</li></ul><script>secret()</script>'
    ),
    'A & B 😀\n\n- First\n- Second'
  );
  assert.equal(
    descriptionText('List<T> and <hotelId> are required'),
    'List<T> and <hotelId> are required'
  );
});

test('metadata cleanup leaves request payloads, examples and default descriptions untouched', () => {
  const model = {
    description: '<b>API</b>',
    arguments: [{ name: 'body', description: '<p>Body</p>' }],
    source: { body: { description: '<b>literal</b>' } },
    definition: {
      properties: { example: { description: '<b>field</b>' } },
      example: { description: '<b>payload</b>' },
      default: { description: '<b>default</b>' },
    },
  };
  const cleaned = cleanDescriptions(model);
  assert.equal(cleaned.description, 'API');
  assert.equal(cleaned.arguments[0].description, 'Body');
  assert.equal(cleaned.definition.properties.example.description, 'field');
  assert.deepEqual(cleaned.source, model.source);
  assert.deepEqual(cleaned.definition.example, model.definition.example);
  assert.deepEqual(cleaned.definition.default, model.definition.default);
});
