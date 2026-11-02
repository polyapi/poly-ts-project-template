import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import test, { type TestContext } from 'node:test';
import { createSummary } from '../types/summary';
import { syncCanopy } from './canopy';

const config = { name: 'AI agent', subpath: 'ai-agent', collections: [] };
const description = 'This is the SMS AI agent demo.';

const testEnvironment = {
  BASE_URL: 'https://polyapi.test',
  API_KEY: 'placeholder-api-key',
  OTP_ENABLED: 'false',
};

test('creates an application with description metadata outside its config', async t => {
  t.mock.property(process, 'env', testEnvironment);
  const directory = mkdtempSync(join(tmpdir(), 'canopy-description-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'aiAgent.json');
  const content = { ...config, description, visibility: 'ENVIRONMENT' };
  writeFileSync(filePath, JSON.stringify(content));
  const writes: unknown[] = [];

  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://polyapi.test/applications');
    if (init.method === 'GET') {
      return new Response('[]');
    }
    assert.equal(init.method, 'POST');
    writes.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: 'app-id' }), { status: 201 });
  });

  const summary = createSummary().canopy;
  await syncCanopy(summary, {}, [
    { filePath, fileName: 'aiAgent.json', content },
  ]);

  assert.deepEqual(writes, [
    { name: 'AI agent', config, description, visibility: 'ENVIRONMENT' },
  ]);
  assert.equal(summary.updated, 1);
  assert.equal(summary.failed, 0);
  assert.equal(
    JSON.parse(readFileSync(filePath, 'utf8')).description,
    description
  );
});

for (const scenario of [
  {
    name: 'updates a changed description when config is unchanged',
    local: description,
    remote: '',
    dryRun: false,
    updated: 1,
    skipped: 0,
    planned: 0,
  },
  {
    name: 'skips an unchanged description and config',
    local: description,
    remote: description,
    dryRun: false,
    updated: 0,
    skipped: 1,
    planned: 0,
  },
  {
    name: 'preserves the remote description when the local field is omitted',
    local: undefined,
    remote: description,
    dryRun: false,
    updated: 0,
    skipped: 1,
    planned: 0,
  },
  {
    name: 'plans a description change without writing during dry run',
    local: description,
    remote: '',
    dryRun: true,
    updated: 0,
    skipped: 0,
    planned: 1,
  },
  {
    name: 'clears an existing description with an empty string',
    local: '',
    remote: description,
    dryRun: false,
    updated: 1,
    skipped: 0,
    planned: 0,
  },
]) {
  test(scenario.name, async t => {
    t.mock.property(process, 'env', testEnvironment);
    const writes: unknown[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (url: string, init: RequestInit) => {
        if (init.method === 'GET' && url.endsWith('/applications')) {
          return Response.json([
            { id: 'app-id', ...config, description: scenario.remote },
          ]);
        }
        if (
          init.method === 'GET' &&
          url.endsWith('/applications/app-id/config')
        ) {
          return Response.json(config);
        }
        assert.equal(url, 'https://polyapi.test/applications/app-id');
        assert.equal(init.method, 'PATCH');
        writes.push(JSON.parse(String(init.body)));
        return Response.json({});
      }
    );

    const summary = createSummary().canopy;
    await syncCanopy(summary, { dryRun: scenario.dryRun }, [
      {
        filePath: '/unused/aiAgent.json',
        fileName: 'aiAgent.json',
        content: { id: 'app-id', ...config, description: scenario.local },
      },
    ]);

    assert.deepEqual(
      writes,
      scenario.updated ? [{ config, description: scenario.local }] : []
    );
    assert.equal(summary.updated, scenario.updated);
    assert.equal(summary.skipped, scenario.skipped);
    assert.equal(summary.planned, scenario.planned);
    assert.equal(summary.failed, 0);
  });
}

for (const remoteConfigMissing of [false, true]) {
  test(
    remoteConfigMissing
      ? 'initializes missing config with PATCH while omitting description metadata'
      : 'updates only config with PUT while omitting application metadata',
    async t => {
      t.mock.property(process, 'env', testEnvironment);
      const updatedConfig = { ...config, name: 'Updated AI agent' };
      const writes: unknown[] = [];
      t.mock.method(
        globalThis,
        'fetch',
        async (url: string, init: RequestInit) => {
          if (init.method === 'GET' && url.endsWith('/applications')) {
            return Response.json([
              {
                id: 'app-id',
                ...config,
                description,
                visibility: 'ENVIRONMENT',
              },
            ]);
          }
          if (
            init.method === 'GET' &&
            url.endsWith('/applications/app-id/config')
          ) {
            return remoteConfigMissing
              ? new Response(null, { status: 404 })
              : Response.json(config);
          }

          assert.equal(
            url,
            `https://polyapi.test/applications/app-id${remoteConfigMissing ? '' : '/config'}`
          );
          assert.equal(init.method, remoteConfigMissing ? 'PATCH' : 'PUT');
          writes.push(JSON.parse(String(init.body)));
          return Response.json({});
        }
      );

      const summary = createSummary().canopy;
      await syncCanopy(summary, {}, [
        {
          filePath: '/unused/aiAgent.json',
          fileName: 'aiAgent.json',
          content: { id: 'app-id', ...updatedConfig, visibility: 'PUBLIC' },
        },
      ]);

      assert.deepEqual(
        writes,
        remoteConfigMissing ? [{ config: updatedConfig }] : [updatedConfig]
      );
      assert.equal(summary.updated, 1);
      assert.equal(summary.failed, 0);
    }
  );
}

function setInteractiveTerminal(t: TestContext, enabled: boolean): void {
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', {
      configurable: true,
      value: enabled,
    });
    t.after(() => {
      if (descriptor) {
        Object.defineProperty(stream, 'isTTY', descriptor);
      } else {
        Reflect.deleteProperty(stream, 'isTTY');
      }
    });
  }
}

function loadCanopy(): typeof import('./canopy') {
  // Each OTP test represents a fresh Flow process with its own cached OTP.
  delete require.cache[require.resolve('../utils/apiClient')];
  delete require.cache[require.resolve('./canopy')];
  return require('./canopy');
}

test('Canopy POST, PUT, and PATCH writes share one OTP and reads omit it', async t => {
  t.mock.property(process, 'env', { ...testEnvironment, OTP_ENABLED: 'true' });
  setInteractiveTerminal(t, true);
  t.mock.method(process.stdout, 'write', () => true);
  const question = t.mock.fn(async () => ' 000000 ');
  const close = t.mock.fn();
  const createInterface = t.mock.method(readline, 'createInterface', () => ({
    question,
    close,
  }));
  const directory = mkdtempSync(join(tmpdir(), 'canopy-otp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'created.json');
  const createConfig = {
    ...config,
    name: 'Created app',
    subpath: 'created-app',
  };
  const updatedConfig = { ...config, name: 'Updated app' };
  writeFileSync(filePath, JSON.stringify(createConfig));
  const methods: (string | undefined)[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer placeholder-api-key');
    if (init.method === 'GET') {
      assert.equal(headers.has('x-otp'), false);
      if (url.endsWith('/applications')) {
        return Response.json([
          { id: 'put-id', ...config, description },
          { id: 'patch-id', ...config, description: '' },
        ]);
      }
      assert.match(url, /\/applications\/(put-id|patch-id)\/config$/);
      return Response.json(config);
    }

    assert.equal(headers.get('x-otp'), '000000');
    methods.push(init.method);
    const body = JSON.parse(String(init.body));
    if (init.method === 'POST') {
      assert.equal(url, 'https://polyapi.test/applications');
      assert.deepEqual(body, { name: 'Created app', config: createConfig });
      return Response.json({ id: 'created-id' }, { status: 201 });
    }
    if (init.method === 'PUT') {
      assert.equal(url, 'https://polyapi.test/applications/put-id/config');
      assert.deepEqual(body, updatedConfig);
      return Response.json({});
    }
    assert.equal(init.method, 'PATCH');
    assert.equal(url, 'https://polyapi.test/applications/patch-id');
    assert.deepEqual(body, { config, description });
    return Response.json({});
  });

  const summary = createSummary().canopy;
  await loadCanopy().syncCanopy(summary, {}, [
    { filePath, fileName: 'created.json', content: createConfig },
    {
      filePath: '/unused/updated.json',
      fileName: 'updated.json',
      content: { id: 'put-id', ...updatedConfig },
    },
    {
      filePath: '/unused/described.json',
      fileName: 'described.json',
      content: { id: 'patch-id', ...config, description },
    },
  ]);

  assert.deepEqual(methods, ['POST', 'PUT', 'PATCH']);
  assert.equal(createInterface.mock.callCount(), 1);
  assert.equal(question.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(summary.updated, 3);
  assert.equal(summary.failed, 0);
});

test('OTP-enabled Canopy dry runs do not prompt without an interactive terminal', async t => {
  t.mock.property(process, 'env', { ...testEnvironment, OTP_ENABLED: 'true' });
  setInteractiveTerminal(t, false);
  const createInterface = t.mock.method(readline, 'createInterface', () => {
    throw new Error('Dry runs must not prompt for OTP');
  });
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init: RequestInit) => {
      assert.equal(init.method, 'GET');
      assert.equal(new Headers(init.headers).has('x-otp'), false);
      if (url.endsWith('/applications')) {
        return Response.json([{ id: 'app-id', ...config, description: '' }]);
      }
      assert.equal(url, 'https://polyapi.test/applications/app-id/config');
      return Response.json(config);
    }
  );

  const summary = createSummary().canopy;
  await loadCanopy().syncCanopy(summary, { dryRun: true }, [
    {
      filePath: '/unused/created.json',
      fileName: 'created.json',
      content: { ...config, name: 'Created app', subpath: 'created-app' },
    },
    {
      filePath: '/unused/described.json',
      fileName: 'described.json',
      content: { id: 'app-id', ...config, description },
    },
  ]);

  assert.equal(createInterface.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(summary.planned, 2);
  assert.equal(summary.updated, 0);
  assert.equal(summary.failed, 0);
});
