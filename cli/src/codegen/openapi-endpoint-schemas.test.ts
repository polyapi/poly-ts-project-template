import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRemoteSpecLocation,
  patchKnownSchemaQuirks,
} from './openapi-endpoint-schemas';

test('regenerated schemas retain both native API-key entry kinds', () => {
  const key = { type: 'string', enum: ['key'] };
  const schema = {
    components: {
      schemas: { KeyValueApiKeyEntrySource: { properties: { key } } },
    },
  };
  patchKnownSchemaQuirks('CreateApiFunctionDto', schema);
  assert.deepEqual(key.enum, ['key', 'value']);
});

test('schema generation accepts a local OpenAPI file or an HTTP URL', () => {
  assert.equal(
    isRemoteSpecLocation('https://eu1.polyapi.io/swagger-json'),
    true
  );
  assert.equal(
    isRemoteSpecLocation('HTTP://localhost:8000/swagger-json'),
    true
  );
  assert.equal(isRemoteSpecLocation('../poly-alpha/swagger.json'), false);
  assert.equal(isRemoteSpecLocation('file:///tmp/swagger.json'), false);
});
