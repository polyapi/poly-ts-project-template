import assert from 'node:assert/strict';
import test from 'node:test';
import { patchKnownSchemaQuirks } from './openapi-endpoint-schemas';

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
