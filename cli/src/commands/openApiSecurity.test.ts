import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/openapi-security.json';
import { reconcileSecurity } from './openApiSecurity';
import { validateModel } from './trainingModel';

function model() {
  return validateModel(structuredClone(fixture.model));
}

for (const [header, argument] of [
  ['class', 'headerClass'],
  ['enum', 'headerEnum'],
  ['123-key', 'header123Key'],
])
  test(`restored argument is a valid identifier for header ${header}`, () => {
    process.env.POLYAPI_NAMESPACE = 'example';
    delete process.env.POLYAPI_NAMESPACES;
    const spec = {
      ...fixture.spec,
      components: {
        securitySchemes: {
          ...fixture.spec.components.securitySchemes,
          ApiKey: {
            ...fixture.spec.components.securitySchemes.ApiKey,
            name: header,
          },
        },
      },
    };
    const result = reconcileSecurity(model(), spec).functions[0];
    assert.equal(result.arguments.at(-1).name, argument);
    assert.equal(result.source.headers.at(-1).value, `{{${argument}}}`);
  });

test('combined auth restores a separate key, preserves input and is idempotent', () => {
  process.env.POLYAPI_NAMESPACE = 'example';
  delete process.env.POLYAPI_NAMESPACES;
  const original = model();
  const snapshot = structuredClone(original);
  const result = reconcileSecurity(original, fixture.spec);
  assert.deepEqual(
    result.functions[0].source.auth,
    original.functions[0].source.auth
  );
  assert.deepEqual(result.functions[0].source.headers, [
    { key: 'x-api-key', value: '{{xApiKey}}' },
  ]);
  assert.equal(result.functions[0].arguments.at(-1).required, true);
  assert.equal(
    result.functions[0].arguments.at(-1).removeIfNotPresentOnExecute,
    false
  );
  assert.deepEqual(original, snapshot);
  assert.deepEqual(reconcileSecurity(result, fixture.spec), result);
});

for (const security of [
  [{ Authorization: [] }, { ApiKey: [] }],
  [{ Authorization: [], ApiKey: [] }, { Authorization: [] }],
])
  test('security alternatives remain alternatives', () => {
    assert.deepEqual(
      reconcileSecurity(model(), { ...fixture.spec, security }),
      model()
    );
  });

test('operation overrides global security and unrelated specifications remain unchanged', () => {
  const spec = {
    ...fixture.spec,
    paths: { '/members/{id}/': { get: { security: [] } } },
  };
  const result = reconcileSecurity(model(), spec).functions[0];
  assert.deepEqual(result.source.auth, { type: 'noauth' });
  assert.deepEqual(result.source.headers, []);
  assert.deepEqual(reconcileSecurity(model(), { paths: spec.paths }), model());
});

test('literal Authorization prefix and header-only noauth are preserved', () => {
  const input = model();
  input.functions[0].source.auth = { type: 'noauth' };
  input.functions[0].source.headers = [
    { key: 'Authorization', value: 'JWT {{apiKey}}' },
  ];
  const result = reconcileSecurity(input, fixture.spec).functions[0];
  assert.deepEqual(result.source.auth, { type: 'noauth' });
  assert.deepEqual(
    result.source.headers[0],
    input.functions[0].source.headers[0]
  );
  assert.equal(result.source.headers[1].key, 'x-api-key');
  input.functions[0].source.headers = [];
  assert.deepEqual(
    reconcileSecurity(input, { ...fixture.spec, security: [{ ApiKey: [] }] })
      .functions[0].source.auth,
    { type: 'noauth' }
  );
});

for (const authType of ['bearer', 'basic'])
  test(`preserves primary ${authType} auth`, () => {
    const spec = {
      ...fixture.spec,
      components: {
        securitySchemes: {
          ...fixture.spec.components.securitySchemes,
          Primary: { type: 'http', scheme: authType },
        },
      },
      security: [{ Primary: [], ApiKey: [] }],
    };
    const input = model();
    input.functions[0].source.auth = { type: authType, [authType]: [] };
    const result = reconcileSecurity(input, spec).functions[0];
    assert.deepEqual(result.source.auth, input.functions[0].source.auth);
    assert.equal(result.source.headers[0].key, 'x-api-key');
  });

for (const used of [true, false])
  test(`argument collision handling, used=${used}`, () => {
    const input = model();
    input.functions[0].arguments.push({
      name: 'xApiKey',
      type: 'string',
      required: false,
    });
    if (used)
      input.functions[0].source.body = { mode: 'raw', raw: '{{xApiKey}}' };
    const result = reconcileSecurity(input, fixture.spec).functions[0];
    const expected = used ? 'xApiKey2' : 'xApiKey';
    assert.equal(result.source.headers[0].value, `{{${expected}}}`);
    assert.equal(
      result.arguments.find((arg: { name: string }) => arg.name === expected)
        .required,
      true
    );
  });

test('existing headers match case insensitively and disabled headers are replaced', () => {
  const input = model();
  input.functions[0].source.headers = [
    { key: 'X-API-KEY', value: '{{existing}}' },
  ];
  assert.deepEqual(reconcileSecurity(input, fixture.spec), input);
  input.functions[0].source.headers[0].disabled = true;
  assert.deepEqual(
    reconcileSecurity(input, fixture.spec).functions[0].source.headers,
    [{ key: 'x-api-key', value: '{{xApiKey}}' }]
  );
});

test('Swagger 2 local references, base paths, renamed arguments and space suffixes', () => {
  const { components, ...originalSpec } = fixture.spec;
  const spec = {
    ...originalSpec,
    swagger: '2.0',
    securityDefinitions: {
      ...components.securitySchemes,
      Alias: { $ref: '#/securityDefinitions/ApiKey' },
    },
    security: [{ Authorization: [], Alias: [] }],
    paths: {
      '/members/{id}/': { get: {}, post: { security: [] } },
      '/members/{id}/ ': { get: {} },
    },
  };
  const input = model();
  input.functions[0].source.url =
    'https://example.invalid/v1/members/{{memberId}}/%20?q=x';
  assert.equal(
    reconcileSecurity(input, spec).functions[0].source.headers[0].key,
    'x-api-key'
  );
  input.functions[0].source.method = 'POST';
  assert.deepEqual(reconcileSecurity(input, spec).functions[0].source.auth, {
    type: 'noauth',
  });
});

for (const failure of [
  'unmatched',
  'ambiguous',
  'undefined',
  'cycle',
  'external',
])
  test(`unsafe security mapping fails without mutation: ${failure}`, () => {
    const schemes = fixture.spec.components.securitySchemes;
    const variants = {
      unmatched: { ...fixture.spec, paths: {} },
      ambiguous: {
        ...fixture.spec,
        paths: {
          ...fixture.spec.paths,
          '/members/{other}/': { get: { security: [] } },
        },
      },
      undefined: { ...fixture.spec, security: [{ Missing: [] }] },
      cycle: {
        ...fixture.spec,
        components: {
          securitySchemes: {
            ...schemes,
            ApiKey: { $ref: '#/components/securitySchemes/ApiKey' },
          },
        },
      },
      external: {
        ...fixture.spec,
        components: {
          securitySchemes: {
            ...schemes,
            ApiKey: { $ref: 'https://example.invalid/security.json' },
          },
        },
      },
    };
    const input = model();
    const before = structuredClone(input);
    assert.throws(() =>
      reconcileSecurity(input, variants[failure as keyof typeof variants])
    );
    assert.deepEqual(input, before);
  });
