import assert from 'node:assert/strict';
import test from 'node:test';
import securityFixture from '../commands/fixtures/openapi-security.json';
import { validateEndpointPayload } from './apiSchemaValidation';

test('native API-key auth passes the checked-in endpoint schema', () => {
  assert.equal(
    validateEndpointPayload(
      'CreateApiFunctionDto',
      securityFixture.model.functions[0],
      { artifactType: 'api', artifactName: 'synthetic' }
    ),
    true
  );
});

for (const failure of ['location', 'entry', 'length', 'value_type'])
  test(`native API-key validation still rejects invalid auth: ${failure}`, t => {
    t.mock.method(console, 'error', () => {});
    const input = structuredClone(securityFixture.model.functions[0]);
    const entries = input.source.auth.apikey;
    if (failure === 'location') entries[0].value = 'cookie';
    else if (failure === 'entry') entries[2].key = 'unknown';
    else if (failure === 'length') entries.pop();
    else Object.assign(entries[2], { value: 42 });
    assert.equal(
      validateEndpointPayload('CreateApiFunctionDto', input, {
        artifactType: 'api',
        artifactName: 'synthetic',
      }),
      false
    );
  });

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
