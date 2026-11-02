import assert from 'node:assert/strict';
import test from 'node:test';
import { schemaLayers } from './trainingModel';

test('schema dependencies are ready before consuming schemas', () => {
  const parent = {
    name: 'Parent',
    context: 'demo',
    definition: {
      properties: { child: { 'x-poly-ref': { path: 'demo.Child' } } },
    },
  };
  const child = {
    name: 'Child',
    context: 'demo',
    definition: { type: 'string' },
  };
  assert.deepEqual(
    schemaLayers([parent, child]).map(layer => layer.map(item => item.name)),
    [['Child'], ['Parent']]
  );
});

test('self-recursive and mutually recursive schema groups retain contracts and wait for external dependencies', () => {
  const schemas = [
    {
      name: 'Parent',
      context: 'demo',
      definition: {
        properties: {
          child: { 'x-poly-ref': { path: 'demo.Child' } },
          value: { 'x-poly-ref': { path: 'demo.Value' } },
        },
      },
    },
    {
      name: 'Child',
      context: 'demo',
      definition: {
        properties: { parent: { 'x-poly-ref': { path: 'demo.Parent' } } },
      },
    },
    { name: 'Value', context: 'demo', definition: { type: 'string' } },
    {
      name: 'Recursive',
      context: 'demo',
      definition: {
        properties: { self: { 'x-poly-ref': { path: 'demo.Recursive' } } },
      },
    },
  ];
  const before = JSON.stringify(schemas);
  const layers = schemaLayers(schemas);
  assert.deepEqual(
    new Set(layers[0].map(item => item.name)),
    new Set(['Value', 'Recursive'])
  );
  assert.deepEqual(
    new Set(layers[1].map(item => item.name)),
    new Set(['Parent', 'Child'])
  );
  assert.equal(JSON.stringify(schemas), before);
});
