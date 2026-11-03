import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEndpointPayload } from './apiSchemaValidation';

// Validators are compiled once per process, so this file keeps the first
// compile of each schema, which is when Ajv would warn about unknown formats.
test('endpoint schemas compile without unknown-format warnings', t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const context = { artifactType: 'MCP Server', artifactName: 'weather-tools' };
  assert.equal(
    validateEndpointPayload(
      'CreateMCPServerDto',
      {
        name: 'weather-tools',
        toolFunctions: [],
        oauthRedirectUris: ['https://client.example.test/callback'],
      },
      context
    ),
    true
  );
  assert.equal(
    validateEndpointPayload(
      'UpdateMCPServerDto',
      { oauthRedirectUris: ['https://client.example.test/callback'] },
      context
    ),
    true
  );
  assert.equal(warnings.mock.callCount(), 0);
});

test('declared formats are not checked, as before; PolyAPI checks them', t => {
  t.mock.method(console, 'warn', () => {});
  assert.equal(
    validateEndpointPayload(
      'UpdateMCPServerDto',
      { oauthRedirectUris: ['not a URI'] },
      { artifactType: 'MCP Server', artifactName: 'weather-tools' }
    ),
    true
  );
});
