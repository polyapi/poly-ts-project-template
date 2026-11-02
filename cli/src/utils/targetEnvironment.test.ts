import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import type { EnvLoadResult } from './deploymentConfig';
import {
  enforceTargetEnvironment,
  fetchRemoteEnvironment,
  getTargetEnvId,
} from './targetEnvironment';

const selected: EnvLoadResult = {
  displayPath: 'workflows/dev.env',
  resolvedPath: '/project/workflows/dev.env',
  exists: true,
  fromEnvPath: true,
  declaredTargetEnvId: 'development-target',
};
let restore: () => void;
beforeEach(() => {
  const names = ['API_KEY', 'BASE_URL', 'TARGET_ENV_ID', 'OTP_ENABLED'];
  const previous = names.map(name => [name, process.env[name]] as const);
  restore = () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  process.env.API_KEY = 'placeholder-test-key';
  process.env.BASE_URL = 'https://polyapi.test';
  process.env.OTP_ENABLED = 'true';
});
afterEach(() => restore());

test('matching file pin verifies the authenticated target without requesting OTP', async t => {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    requests.push(request);
    return Response.json({
      environmentId: 'development-target',
      environmentName: 'Development',
    });
  });
  assert.deepEqual(await enforceTargetEnvironment(selected), {
    environmentId: 'development-target',
    environmentName: 'Development',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://polyapi.test/whoami');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].redirect, 'error');
  assert.equal(
    requests[0].headers.get('Authorization'),
    'Bearer placeholder-test-key'
  );
  assert.equal(requests[0].headers.has('x-otp'), false);
});

test('a production key at the same instance fails a development file pin', async t => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ environmentId: 'production-target' })
  );
  await assert.rejects(
    enforceTargetEnvironment(selected),
    /pinned to TARGET_ENV_ID=development-target.*production-target.*Refusing/
  );
});

test('missing, empty, or shell-only pins fail before HTTP dispatch', async t => {
  process.env.TARGET_ENV_ID = 'production-target';
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('Missing file pin must stop before HTTP')
  );
  for (const pin of [undefined, '', '  ']) {
    await assert.rejects(
      enforceTargetEnvironment({ ...selected, declaredTargetEnvId: pin }),
      /Exporting it in your shell does not count/
    );
  }
  assert.throws(
    () => getTargetEnvId({ ...selected, exists: false }),
    /does not exist/
  );
});

for (const payload of [
  {},
  [],
  null,
  { environmentId: '' },
  { environmentId: 'bad\nINJECT=1' },
  { environmentId: 123 },
]) {
  test(`invalid or unauthenticated whoami body is rejected: ${JSON.stringify(payload)}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    await assert.rejects(enforceTargetEnvironment(selected), /GET \/whoami/);
  });
}

test('HTTP and transport failures stop verification without displaying response bodies or request details', async t => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'placeholder-sensitive-detail' }, { status: 401 })
  );
  await assert.rejects(fetchRemoteEnvironment(), /HTTP 401/);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('placeholder-sensitive-detail');
  });
  await assert.rejects(fetchRemoteEnvironment(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /target environment could not be verified/);
    assert.equal(error.message.includes('placeholder-sensitive-detail'), false);
    return true;
  });
});

test('missing connection fails before contacting a host', async t => {
  delete process.env.API_KEY;
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('Missing key must stop before HTTP')
  );
  await assert.rejects(fetchRemoteEnvironment(), /Missing PolyAPI connection/);
});
