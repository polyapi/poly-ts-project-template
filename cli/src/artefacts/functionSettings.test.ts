import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import createClient from 'openapi-fetch';
import * as transpiler from 'polyapi/build/transpiler';
import type { paths } from '../sdk/schema';
import type { FunctionFile } from '../types';
import { createSummary } from '../types/summary';
import * as apiClient from '../utils/apiClient';
import * as deploymentConfig from '../utils/deploymentConfig';
import { validateFunctionArtifact } from '../utils/validation';
import {
  findFunctionFiles,
  getServerFunctionSettingsPatch,
  syncFunctions,
} from './functions';

const functionId = 'function-id';
const source = (settings: string) => `export const polyConfig = {
  name: 'worker',
  context: 'example.settings',
  description: 'Background worker',
  ${settings}
};
export default async function worker(): Promise<number> { return 1; }
`;
const configured = source(
  "serverSideAsync: true,\n  containerConcurrency: '{{WORKER_CONCURRENCY}}',"
);

function fixture(
  t: TestContext,
  options: {
    localSource?: string;
    remoteCode?: string;
    remoteSettings?: Record<string, unknown>;
  } = {}
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flow-settings-')));
  const cwd = process.cwd();
  const previousEnv = { ...process.env };
  const projectRoot = path.join(root, 'workflows');
  const serverDir = path.join(projectRoot, 'src/jobs/server');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages: [workflows]\n'
  );
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ dependencies: { polyapi: '0.28.6' } })
  );
  const localSource = options.localSource ?? configured;
  writeFileSync(path.join(serverDir, 'worker.ts'), localSource);
  process.chdir(projectRoot);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('POLY_DEPLOY_') || key === 'POLYAPI_NAMESPACES')
      delete process.env[key];
  }
  Object.assign(process.env, {
    POLYAPI_NAMESPACE: 'example',
    BASE_URL: 'https://polyapi.test',
    API_KEY: 'synthetic-api-key',
    OTP_ENABLED: 'false',
    WORKER_CONCURRENCY: '4',
  });
  t.after(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(apiClient, 'sleep', async () => {});
  t.mock.method(
    deploymentConfig,
    'getProductionExecutionApiKeyOverride',
    () => undefined
  );
  t.mock.method(transpiler, 'getDependencies', async () => [{}, {}]);
  t.mock.method(transpiler, 'getTSBaseUrl', () => projectRoot);
  const deploys: string[][] = [];
  t.mock.method(childProcess, 'spawn', (_command: string, args: string[]) => {
    deploys.push(args);
    const child = new childProcess.ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout?.emit('data', `Function ID: ${functionId}\n`);
      child.emit('close', 0, null);
    });
    return child;
  });

  const remote = {
    id: functionId,
    context: 'example.settings',
    name: 'worker',
    description: 'Background worker',
    code: options.remoteCode ?? localSource,
    visibility: 'ENVIRONMENT',
    externalDependencies: {},
    serverSideAsync: false,
    containerConcurrency: null,
    ...options.remoteSettings,
  };
  const patches: Array<{ route: string; body: unknown }> = [];
  const client = createClient<paths>({
    baseUrl: 'https://polyapi.test',
    fetch: async request => {
      const route = new URL(request.url).pathname;
      if (request.method === 'PATCH') {
        patches.push({ route, body: await request.json() });
        return Response.json(remote);
      }
      if (route === '/functions/server') return Response.json([remote]);
      if (route === '/functions/client') return Response.json([]);
      if (route === `/functions/server/${functionId}`)
        return Response.json(remote);
      throw new Error(`Unexpected request: ${request.method} ${route}`);
    },
  });
  return { client, deploys, patches };
}

async function sync(
  client: ReturnType<typeof createClient<paths>>,
  dryRun = false
) {
  const summary = createSummary().functions;
  await syncFunctions(client, summary, [], false, false, {
    dryRun,
    detectOrphans: false,
  });
  return summary;
}

test('polyConfig reads serverSideAsync and containerConcurrency', t => {
  fixture(t);
  const [func] = findFunctionFiles({ respectSkipPaths: false });
  assert.equal(func.metadata.serverSideAsync, true);
  assert.equal(func.metadata.containerConcurrency, 4);
  assert.equal(validateFunctionArtifact(func.metadata, func.tsFilePath), true);
});

test('settings patch contains only the declared values that differ', () => {
  const func = {
    tsFilePath: 'worker.ts',
    type: 'server',
    metadata: {
      name: 'worker',
      context: 'example.settings',
      description: '',
      serverSideAsync: true,
      containerConcurrency: null,
    },
  } as FunctionFile;
  assert.deepEqual(
    getServerFunctionSettingsPatch(func, {
      serverSideAsync: true,
      containerConcurrency: null,
    }),
    {}
  );
  assert.deepEqual(
    getServerFunctionSettingsPatch(func, { containerConcurrency: 8 }),
    { serverSideAsync: true, containerConcurrency: null }
  );
  assert.deepEqual(getServerFunctionSettingsPatch(func, null), {
    serverSideAsync: true,
    containerConcurrency: null,
  });
  assert.deepEqual(
    getServerFunctionSettingsPatch({ ...func, type: 'client' }, null),
    {}
  );
});

test('a settings-only change is PATCHed without a redeploy', async t => {
  const { client, deploys, patches } = fixture(t);
  const summary = await sync(client);
  assert.deepEqual(deploys, []);
  assert.deepEqual(patches, [
    {
      route: `/functions/server/${functionId}`,
      body: { serverSideAsync: true, containerConcurrency: 4 },
    },
  ]);
  assert.equal(summary.updated, 1);
});

test('dry run plans the settings update without writing', async t => {
  const { client, deploys, patches } = fixture(t);
  const summary = await sync(client, true);
  assert.deepEqual(deploys, []);
  assert.deepEqual(patches, []);
  assert.equal(summary.planned, 1);
});

test('matching settings are skipped', async t => {
  const { client, deploys, patches } = fixture(t, {
    remoteSettings: { serverSideAsync: true, containerConcurrency: 4 },
  });
  const summary = await sync(client);
  assert.deepEqual(deploys, []);
  assert.deepEqual(patches, []);
  assert.equal(summary.skipped, 1);
});

test('a code change re-applies matching settings the deploy drops', async t => {
  const { client, deploys, patches } = fixture(t, {
    remoteCode: 'export default async function worker() { return 0; }',
    remoteSettings: { serverSideAsync: true, containerConcurrency: 4 },
  });
  await sync(client);
  assert.equal(deploys.length, 1);
  assert.deepEqual(patches, [
    {
      route: `/functions/server/${functionId}`,
      body: { serverSideAsync: true, containerConcurrency: 4 },
    },
  ]);
});

test('a code change redeploys, then applies every declared setting', async t => {
  const { client, deploys, patches } = fixture(t, {
    remoteCode: 'export default async function worker() { return 0; }',
    remoteSettings: { serverSideAsync: true },
  });
  const summary = await sync(client);
  assert.equal(deploys.length, 1);
  assert.deepEqual(patches, [
    {
      route: `/functions/server/${functionId}`,
      body: { serverSideAsync: true, containerConcurrency: 4 },
    },
  ]);
  assert.equal(summary.updated, 1);
});
