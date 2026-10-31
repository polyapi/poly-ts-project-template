import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mergeEnvironmentLayers,
  resolveWorkflowPolyConfig,
} from './environment';

test('saved Poly setup names populate Flow credentials without duplicates', () => {
  const values = mergeEnvironmentLayers(
    {
      POLY_API_BASE_URL: 'https://setup.polyapi.test',
      POLY_API_KEY: 'placeholder-setup-key',
    },
    { POLYAPI_NAMESPACE: 'demo' }
  );
  assert.equal(values.BASE_URL, 'https://setup.polyapi.test');
  assert.equal(values.API_KEY, 'placeholder-setup-key');
  assert.equal(values.POLYAPI_BASE_URL, values.POLY_API_BASE_URL);
  assert.equal(values.POLYAPI_API_KEY, values.POLY_API_KEY);
});

test('explicit environment layers override all credential aliases together', () => {
  const saved = {
    POLY_API_BASE_URL: 'https://saved.polyapi.test',
    POLY_API_KEY: 'placeholder-saved',
  };
  for (const selected of [
    {
      BASE_URL: 'https://selected.polyapi.test',
      API_KEY: 'placeholder-selected',
    },
    {
      POLYAPI_BASE_URL: 'https://selected.polyapi.test',
      POLYAPI_API_KEY: 'placeholder-selected',
    },
    {
      POLY_API_BASE_URL: 'https://selected.polyapi.test',
      POLY_API_KEY: 'placeholder-selected',
    },
  ]) {
    const values = mergeEnvironmentLayers(saved, selected);
    for (const name of ['BASE_URL', 'POLY_API_BASE_URL', 'POLYAPI_BASE_URL'])
      assert.equal(values[name], 'https://selected.polyapi.test');
    for (const name of ['API_KEY', 'POLY_API_KEY', 'POLYAPI_API_KEY'])
      assert.equal(values[name], 'placeholder-selected');
  }
  const empty = mergeEnvironmentLayers(saved, { API_KEY: '' });
  assert.equal(empty.POLY_API_KEY, '');
});

test('resolves pnpm and flat SDK layouts from the workflow package rather than the CLI dependency', () => {
  for (const sdk of [
    '/project/node_modules/.pnpm/polyapi@0.27.4/node_modules/polyapi/package.json',
    '/project/workflows/node_modules/polyapi/package.json',
  ]) {
    const expected = path.join(
      path.dirname(path.dirname(sdk)),
      '.poly/.config.env'
    );
    const config = resolveWorkflowPolyConfig(
      '/project',
      directory => {
        assert.equal(directory, '/project/workflows');
        return sdk;
      },
      candidate => candidate === expected
    );
    assert.equal(config, expected);
  }
});

test('an unconfigured workflow SDK never borrows another installed version configuration', () => {
  const checked: string[] = [];
  const result = resolveWorkflowPolyConfig(
    '/project',
    () =>
      '/project/node_modules/.pnpm/polyapi@new/node_modules/polyapi/package.json',
    candidate => {
      checked.push(String(candidate));
      return false;
    }
  );
  assert.equal(result, null);
  assert.deepEqual(checked, [
    '/project/node_modules/.pnpm/polyapi@new/node_modules/.poly/.config.env',
  ]);
  assert.equal(
    resolveWorkflowPolyConfig('/project', () => {
      throw new Error('not installed');
    }),
    null
  );
});

for (const override of [false, true]) {
  test(`Flow reads saved setup with a namespace-only env file${override ? ' and honors ENVPATH overrides' : ''}`, async t => {
    const directory = fs.realpathSync(
      fs.mkdtempSync(path.join(tmpdir(), 'flow-environment-'))
    );
    const workflow = path.join(directory, 'workflows');
    fs.mkdirSync(path.join(workflow, 'node_modules/polyapi'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(directory, 'pnpm-workspace.yaml'),
      'packages: [workflows]\n'
    );
    fs.writeFileSync(
      path.join(workflow, 'node_modules/polyapi/package.json'),
      '{"name":"polyapi"}'
    );
    const savedFile = path.join(workflow, 'node_modules/.poly/.config.env');
    const selectedFile = path.join(
      workflow,
      override ? 'selected.env' : 'dev.env'
    );
    const previousDirectory = process.cwd();
    const names = [
      'BASE_URL',
      'API_KEY',
      'POLY_API_BASE_URL',
      'POLY_API_KEY',
      'POLYAPI_BASE_URL',
      'POLYAPI_API_KEY',
      'POLYAPI_NAMESPACE',
      'POLY_API_NAMESPACE',
      'POLY_NAMESPACE',
      'POLYAPI_NAMESPACES',
      'ENVPATH',
      'OTP_ENABLED',
    ];
    const previous = names.map(name => [name, process.env[name]] as const);
    for (const name of names) delete process.env[name];
    if (override) process.env.ENVPATH = 'workflows/selected.env';
    t.after(() => {
      process.chdir(previousDirectory);
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    process.chdir(workflow);
    t.mock.method(process, 'exit', () => {
      throw new Error(
        'Unexpected process exit while loading test configuration'
      );
    });
    const originalExists = fs.existsSync;
    t.mock.method(fs, 'existsSync', (candidate: fs.PathLike) => {
      const name = String(candidate);
      if (name === savedFile || name === selectedFile) return true;
      if (name.endsWith('.env')) return false;
      return originalExists(candidate);
    });
    // Simulate file contents without opening any real environment/credential file.
    const dotenv = require('dotenv') as typeof import('dotenv');
    t.mock.method(
      dotenv,
      'config',
      (options?: import('dotenv').DotenvConfigOptions) => {
        if (options?.path === savedFile)
          return {
            parsed: {
              POLY_API_BASE_URL: 'https://setup.polyapi.test',
              POLY_API_KEY: 'placeholder-setup-key',
            },
          };
        assert.equal(options?.path, selectedFile);
        return {
          parsed: {
            POLYAPI_NAMESPACE: 'demo',
            ...(override
              ? {
                  BASE_URL: 'https://selected.polyapi.test',
                  API_KEY: 'placeholder-selected-key',
                }
              : {}),
          },
        };
      }
    );
    const requests: Request[] = [];
    t.mock.method(globalThis, 'fetch', async (request: Request) => {
      requests.push(request);
      return new Response('[]', {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const { loadEnv, createPolyApiClient } =
      require('./apiClient') as typeof import('./apiClient');
    loadEnv();
    await createPolyApiClient().GET('/schemas', {});
    assert.equal(
      new URL(requests[0].url).origin,
      override ? 'https://selected.polyapi.test' : 'https://setup.polyapi.test'
    );
    assert.equal(
      requests[0].headers.get('Authorization'),
      override
        ? 'Bearer placeholder-selected-key'
        : 'Bearer placeholder-setup-key'
    );
    assert.equal(process.env.POLY_API_KEY, process.env.API_KEY);
  });
}
