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
import {
  executePushDynamicPlan,
  type PushDynamicArgs,
  type PushDynamicContext,
  planPushDynamic,
} from '../commands/pushDynamic';
import type { paths } from '../sdk/schema';
import { createSummary } from '../types/summary';
import * as deploymentConfig from '../utils/deploymentConfig';
import { getServerFunctionDeploymentPlan } from '../utils/serverFunctionDeployment';
import * as functions from './functions';
import { addFunction, findFunctionFiles, syncFunctions } from './functions';

const functionId = '12345678-1234-1234-1234-123456789abc';
const functionKey = 'example.database.adapter';
const source = `export const polyConfig = {
  name: 'adapter', context: 'example.database', description: 'Database adapter'
};
export default async function adapter(): Promise<number> { return 1; }
`;

function fixture(t: TestContext) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'flow-deployment-'))
  );
  const cwd = process.cwd();
  const previousEnv = { ...process.env };
  const projectRoot = path.join(root, 'workflows');
  const serverDir = path.join(projectRoot, 'src/database/server');
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    'packages: [workflows]\n'
  );
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ dependencies: { polyapi: '0.27.8' } })
  );
  writeFileSync(path.join(serverDir, 'adapter.ts'), source);
  process.chdir(projectRoot);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('POLY_DEPLOY_') || key === 'POLYAPI_NAMESPACES')
      delete process.env[key];
  }
  Object.assign(process.env, {
    POLYAPI_NAMESPACE: 'example',
    BASE_URL: 'https://polyapi.test',
    API_KEY: 'synthetic-api-key',
    ENVPATH: 'dev.env',
    CONFIG_ENV_PATH_PRIORITY: 'true',
    POLY_DEPLOY_SERVER_FUNCTION_IMAGES: `${functionKey}:db2-runtime:v2`,
    POLY_DEPLOY_SERVER_FUNCTION_SCRIPT: `${functionKey}:bash scripts/post.sh <id>`,
  });
  t.after(() => {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(
    deploymentConfig,
    'getProductionExecutionApiKeyOverride',
    () => undefined
  );
  t.mock.method(transpiler, 'getDependencies', async () => [{}, {}]);
  t.mock.method(transpiler, 'getTSBaseUrl', () => projectRoot);

  const calls: Array<{
    command: string;
    args: string[];
    options: childProcess.SpawnOptions;
  }> = [];
  const outcomes = {
    deployCode: 0,
    hookCode: 0,
    output: `Function ID: ${functionId}\n`,
  };
  t.mock.method(
    childProcess,
    'spawn',
    (command: string, args: string[], options: childProcess.SpawnOptions) => {
      calls.push({ command, args, options });
      const child = new childProcess.ChildProcess();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        const hook = args[0] === '-c';
        if (!hook) child.stdout?.emit('data', outcomes.output);
        child.emit(
          'close',
          hook ? outcomes.hookCode : outcomes.deployCode,
          null
        );
      });
      return child;
    }
  );
  const remote = {
    id: functionId,
    context: 'example.database',
    name: 'adapter',
    description: 'Database adapter',
    code: source,
    visibility: 'ENVIRONMENT',
    externalDependencies: {},
    image: 'db2-runtime:v1',
  };
  let deployed = true;
  const client = createClient<paths>({
    baseUrl: 'https://polyapi.test',
    fetch: async request => {
      assert.equal(request.method, 'GET');
      const pathname = new URL(request.url).pathname;
      if (pathname === '/functions/server')
        return Response.json(deployed ? [remote] : []);
      if (pathname === '/functions/client') return Response.json([]);
      if (pathname === `/functions/server/${functionId}`)
        return Response.json(remote);
      throw new Error(`Unexpected request: ${pathname}`);
    },
  });
  const args: PushDynamicArgs = {
    dryRun: false,
    seeds: [],
    scopePaths: [],
    seedFrom: 'remote',
    skipUnchangedCfx: false,
    throughSfx: false,
    json: false,
    yes: true,
    maxLeaves: 10,
    skipGenerate: true,
    hubs: false,
    experimentalWildcards: false,
    skipValidationAcknowledged: false,
    verbose: false,
  };
  const context: PushDynamicContext = {
    client,
    projectRoot,
    workspaceRoot: root,
    invocationCwd: root,
    productionSensitive: false,
    envDisplayPath: 'dev.env',
    currentBranch: 'develop',
    confirm: async () => 'y',
    syncsOtherArtefacts: false,
    deletesOrphans: false,
  };
  return {
    root,
    projectRoot,
    calls,
    outcomes,
    remote,
    client,
    args,
    context,
    file: findFunctionFiles()[0],
    setDeployed: (value: boolean) => {
      deployed = value;
    },
  };
}

test('server add forwards image and runs hook with verified connection and absolute ENVPATH', async t => {
  const f = fixture(t);
  assert.equal(await addFunction(f.file), 'deployed');
  assert.equal(f.calls.length, 2);
  const [deploy, hook] = f.calls;
  assert.equal(
    deploy.args[deploy.args.indexOf('--image') + 1],
    'db2-runtime:v2'
  );
  assert.equal(hook.options.cwd, f.root);
  assert.equal(hook.options.env?.FUNCTION_ID, functionId);
  assert.equal(hook.options.env?.SERVICE_NAME, `function-${functionId}`);
  assert.equal(hook.options.env?.ENVPATH, path.join(f.projectRoot, 'dev.env'));
  assert.equal(hook.options.env?.POLY_API_BASE_URL, 'https://polyapi.test');
  assert.equal(hook.options.env?.POLY_API_KEY, 'synthetic-api-key');
  assert.equal(hook.options.env?.CONFIG_ENV_PATH_PRIORITY, undefined);
  assert.ok(hook.args[1].endsWith(functionId));
});

test('client add ignores image and script mappings', async t => {
  const f = fixture(t);
  assert.equal(await addFunction({ ...f.file, type: 'client' }), 'deployed');
  assert.equal(f.calls.length, 1);
  assert.ok(!f.calls[0].args.includes('--image'));
});

test('deployments without hooks do not require a function ID in SDK output', async t => {
  const f = fixture(t);
  delete process.env.POLY_DEPLOY_SERVER_FUNCTION_SCRIPT;
  f.outcomes.output = 'Success\n';
  assert.equal(await addFunction(f.file), 'deployed');
  assert.equal(f.calls.length, 1);
});

test('failed deployments and missing IDs never run hooks; hook failures fail the operation', async t => {
  const f = fixture(t);
  f.outcomes.deployCode = 1;
  assert.equal(await addFunction(f.file), 'failed');
  assert.equal(f.calls.length, 1);
  f.outcomes.deployCode = 0;
  f.outcomes.output = 'ERROR: request failed with status code 400';
  assert.equal(await addFunction(f.file), 'failed');
  assert.equal(f.calls.length, 2);
  f.outcomes.output = 'Generated SDK\n';
  assert.equal(await addFunction(f.file), 'failed');
  assert.equal(f.calls.length, 3);
  f.outcomes.output = `Function ID: ${functionId}\n`;
  f.outcomes.hookCode = 7;
  assert.equal(await addFunction(f.file), 'failed');
  assert.equal(f.calls.length, 5);
});

test('normal push detects image-only updates, skips matches, and never executes dry-run hooks', async t => {
  const f = fixture(t);
  const preview = createSummary();
  await syncFunctions(f.client, preview.functions, [], false, false, {
    dryRun: true,
    detectOrphans: false,
  });
  assert.equal(preview.functions.planned, 1);
  assert.equal(f.calls.length, 0);
  const update = createSummary();
  await syncFunctions(f.client, update.functions, [], false, false, {
    detectOrphans: false,
  });
  assert.equal(update.functions.updated, 1);
  assert.equal(f.calls.length, 2);
  f.remote.image = 'db2-runtime:v2';
  const same = createSummary();
  await syncFunctions(f.client, same.functions, [], false, false, {
    detectOrphans: false,
  });
  assert.equal(same.functions.skipped, 1);
  assert.equal(f.calls.length, 2);
  const forced = createSummary();
  await syncFunctions(f.client, forced.functions, [], false, false, {
    force: true,
    detectOrphans: false,
  });
  assert.equal(forced.functions.updated, 1);
  assert.equal(f.calls.length, 4);
  delete process.env.POLY_DEPLOY_SERVER_FUNCTION_IMAGES;
  f.remote.image = 'unmanaged-image';
  const unmanaged = createSummary();
  await syncFunctions(f.client, unmanaged.functions, [], false, false, {
    detectOrphans: false,
  });
  assert.equal(unmanaged.functions.skipped, 1);
});

test('normal push runs hooks on create and reports hook failure', async t => {
  const f = fixture(t);
  f.setDeployed(false);
  const create = createSummary();
  await syncFunctions(f.client, create.functions, [], false, false, {
    detectOrphans: false,
  });
  assert.equal(create.functions.created, 1);
  f.outcomes.hookCode = 7;
  const failed = createSummary();
  await syncFunctions(f.client, failed.functions, [], false, false, {
    force: true,
    detectOrphans: false,
  });
  assert.equal(failed.functions.failed, 1);
  assert.equal(failed.functions.created, 0);
});

test('dynamic push seeds image-only changes and executes the shared deployment path', async t => {
  const f = fixture(t);
  const result = await planPushDynamic(f.args, f.context, {
    detectOrphans: false,
  });
  assert.equal(result.kind, 'plan');
  if (result.kind !== 'plan') throw new Error('Expected plan');
  assert.deepEqual(result.plan.order, [functionKey]);
  assert.match(result.plan.seeds[0].detail, /image differs/);
  const summary = createSummary();
  await executePushDynamicPlan(
    result.plan,
    { ...f.args, dryRun: true },
    f.context,
    summary.functions,
    [],
    false
  );
  assert.equal(f.calls.length, 0);
  await executePushDynamicPlan(
    result.plan,
    f.args,
    f.context,
    summary.functions,
    [],
    false
  );
  assert.equal(f.calls.length, 2);
  assert.equal(summary.functions.updated, 1);
  f.remote.image = 'db2-runtime:v2';
  const same = await planPushDynamic(f.args, f.context, {
    detectOrphans: false,
  });
  if (same.kind !== 'plan') throw new Error('Expected plan');
  assert.deepEqual(same.plan.order, []);
});

test('dynamic push stops subsequent functions after a hook fails', async t => {
  const f = fixture(t);
  const result = await planPushDynamic(f.args, f.context, {
    detectOrphans: false,
  });
  if (result.kind !== 'plan') throw new Error('Expected plan');
  const nextKey = 'example.consumer';
  result.plan.order.push(nextKey);
  result.plan.filesByKey.set(nextKey, {
    ...f.file,
    metadata: { ...f.file.metadata, context: 'example', name: 'consumer' },
  });
  const adapterNode = result.plan.graph.nodes.get(functionKey);
  if (!adapterNode) throw new Error('Expected adapter node');
  result.plan.graph.nodes.set(nextKey, {
    ...adapterNode,
    key: nextKey,
  });
  f.outcomes.hookCode = 7;
  const summary = createSummary();
  await executePushDynamicPlan(
    result.plan,
    f.args,
    f.context,
    summary.functions,
    [],
    false
  );
  assert.equal(summary.functions.failed, 1);
  assert.equal(summary.functions.skipped, 1);
  assert.equal(f.calls.length, 2);
});

test('dynamic JSON plans expose the image and hook presence without shell commands', async t => {
  const f = fixture(t);
  let output = '';
  t.mock.method(process.stdout, 'write', (chunk: string) => {
    output += chunk;
    return true;
  });
  await planPushDynamic({ ...f.args, dryRun: true, json: true }, f.context, {
    detectOrphans: false,
  });
  const plan = JSON.parse(output);
  assert.deepEqual(plan.nodes[0].deployment, {
    image: 'db2-runtime:v2',
    postDeployScript: true,
  });
  assert.ok(!output.includes('scripts/post.sh'));
  assert.equal(f.calls.length, 0);
});

test('specs-based dynamic detection redeploys configured images whose deployed value is unavailable', async t => {
  const f = fixture(t);
  const polyDir = path.join(f.root, 'synthetic-sdk');
  mkdirSync(path.join(polyDir, 'lib'), { recursive: true });
  writeFileSync(
    path.join(polyDir, 'lib/specs.json'),
    JSON.stringify([
      { type: 'serverFunction', contextName: functionKey, sourceCode: source },
    ])
  );
  writeFileSync(
    path.join(polyDir, 'lib/.flow-generate.json'),
    JSON.stringify({
      baseUrl: 'https://polyapi.test',
      keyFingerprint: functions.fingerprintApiKey('synthetic-api-key'),
      generatedAt: new Date().toISOString(),
    })
  );
  t.mock.method(functions, 'locatePolyDir', () => polyDir);
  const result = await planPushDynamic(
    { ...f.args, seedFrom: 'specs' },
    f.context,
    { detectOrphans: false }
  );
  if (result.kind !== 'plan') throw new Error('Expected plan');
  assert.deepEqual(result.plan.order, [functionKey]);
  assert.match(
    result.plan.seeds[0].detail,
    /cannot be verified from the specs cache/
  );
  assert.equal(f.calls.length, 0);
});

test('malformed settings fail before HTTP or process execution and previews omit commands', async t => {
  const f = fixture(t);
  assert.deepEqual(getServerFunctionDeploymentPlan(f.file), {
    image: 'db2-runtime:v2',
    postDeployScript: true,
  });
  process.env.POLY_DEPLOY_SERVER_FUNCTION_SCRIPT = 'bad-setting';
  await assert.rejects(
    syncFunctions(f.client, createSummary().functions, [], true),
    /POLY_DEPLOY_SERVER_FUNCTION_SCRIPT/
  );
  await assert.rejects(
    planPushDynamic(f.args, f.context, { detectOrphans: true }),
    /POLY_DEPLOY_SERVER_FUNCTION_SCRIPT/
  );
  assert.equal(f.calls.length, 0);
});
