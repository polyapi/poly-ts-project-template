import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dist = path.resolve(__dirname, '../dist');

// Exercise the real entrypoint and HTTP guard with synthetic configuration.
// Loading operator env files, querying Git history, and HTTP are replaced.
function runIsolated(args: string[], pin: string | undefined) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'flow-target-'));
  try {
    fs.mkdirSync(path.join(root, 'workflows/src/demo'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages: [workflows]\n'
    );
    fs.writeFileSync(
      path.join(root, 'spec.json'),
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Synthetic API', version: '1' },
        paths: {
          '/example': {
            get: {
              operationId: 'getExample',
              responses: { 200: { description: 'OK' } },
            },
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(root, 'model.json'),
      JSON.stringify({
        functions: [],
        schemas: [
          {
            name: 'Example',
            context: 'demo.api',
            definition: { type: 'string' },
          },
        ],
        webhooks: [],
      })
    );
    const trace = path.join(root, 'requests.jsonl');
    const generationTrace = path.join(root, 'generation.jsonl');
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(
      preload,
      `
      const fs = require('node:fs');
      const api = require(${JSON.stringify(path.join(dist, 'utils/apiClient.js'))});
      api.loadEnv = () => ({ displayPath: 'workflows/dev.env', resolvedPath: '/synthetic/dev.env', exists: true, fromEnvPath: true, declaredTargetEnvId: ${JSON.stringify(pin) ?? 'undefined'} });
      const deployment = require(${JSON.stringify(path.join(dist, 'utils/deploymentConfig.js'))});
      deployment.buildDeploymentPreflight = (_, envFile) => ({ envFile, productionBranch: 'main', currentBranch: 'develop', productionSensitive: false });
      const variables = require(${JSON.stringify(path.join(dist, 'artefacts/variables.js'))});
      variables.syncVariables = async () => [];
      require('node:child_process').execFileSync = (command, args, options) => {
        if (command !== 'pnpm' || args.join(' ') !== 'workflows exec poly generate') {
          throw new Error('Unexpected subprocess in isolated test');
        }
        fs.appendFileSync(${JSON.stringify(generationTrace)}, JSON.stringify({
          command, args,
          baseUrl: options.env.POLY_API_BASE_URL,
          keyMatchesTarget: options.env.POLY_API_KEY === options.env.API_KEY,
          configPriority: options.env.CONFIG_ENV_PATH_PRIORITY ?? null,
          recursive: options.env.npm_config_recursive ?? null,
        }) + '\\n');
      };
      const maintenance = require(${JSON.stringify(path.join(dist, 'commands/maintenance.js'))});
      const createRuntime = maintenance.createMaintenanceRuntime;
      maintenance.createMaintenanceRuntime = (...args) => ({
        ...createRuntime(...args),
        runPoly() { throw new Error('Unexpected SDK invocation in isolated test'); },
        convertSwagger() { throw new Error('Unexpected SDK conversion in isolated test'); },
      });
      global.fetch = async request => {
        fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ method: request.method, path: new URL(request.url).pathname }) + '\\n');
        if (request.method !== 'GET' || new URL(request.url).pathname !== '/whoami') throw new Error('Unexpected remote operation');
        return Response.json({ environmentId: 'production-target' });
      };
    `
    );
    const result = spawnSync(
      process.execPath,
      ['--require', preload, path.join(dist, 'cli.js'), ...args],
      {
        cwd: args[0] === 'push' ? path.join(root, 'workflows') : root,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          BASE_URL: 'https://polyapi.test',
          API_KEY: 'placeholder-test-key',
          POLY_API_KEY: 'placeholder-test-key',
          POLYAPI_API_KEY: 'placeholder-test-key',
          POLY_API_BASE_URL: 'https://polyapi.test',
          POLYAPI_BASE_URL: 'https://polyapi.test',
          POLYAPI_NAMESPACE: 'demo',
          TARGET_ENV_ID: 'shell-target',
          OTP_ENABLED: 'false',
          CONFIG_ENV_PATH_PRIORITY: 'true',
          npm_config_recursive: 'true',
        },
      }
    );
    assert.equal(result.error, undefined);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      generation: fs.existsSync(generationTrace)
        ? fs
            .readFileSync(generationTrace, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line))
        : [],
      requests: fs.existsSync(trace)
        ? fs
            .readFileSync(trace, 'utf8')
            .trim()
            .split('\n')
            .map(line => JSON.parse(line))
        : [],
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const commands = [
  [
    'push',
    '--dry-run',
    '--types',
    'variables',
    '--skip-validation',
    'I know what am doing',
  ],
  ['train-openapi', 'spec.json', '--context', 'demo.api'],
  ['train-openapi', 'spec.json', '--context', 'demo.api', '--generate-only'],
  ['train-model', 'model.json'],
  ['delete-content', '--context', 'demo.api', '--types', 'api'],
  ['delete-content', '--context', 'demo.api', '--types', 'api', '--apply'],
  ['logs', 'synthetic-function'],
];

const variablePush = [
  'push',
  '--types',
  'variables',
  '--paths',
  'src/demo',
  '--skip-validation',
  'I know what am doing',
];

test('a variables-only push regenerates the SDK against the verified target', () => {
  const result = runIsolated(variablePush, 'production-target');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.generation, [
    {
      command: 'pnpm',
      args: ['workflows', 'exec', 'poly', 'generate'],
      baseUrl: 'https://polyapi.test',
      keyMatchesTarget: true,
      configPriority: null,
      recursive: null,
    },
  ]);
});

for (const flag of ['--dry-run', '--skip-generate']) {
  test(`a variables-only push does not regenerate with ${flag}`, () => {
    const result = runIsolated([...variablePush, flag], 'production-target');
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.generation, []);
  });
}

test('a target mismatch blocks SDK generation after a variables-only push', () => {
  const result = runIsolated(variablePush, 'development-target');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(result.generation, []);
  assert.deepEqual(result.requests, [{ method: 'GET', path: '/whoami' }]);
});

for (const args of commands) {
  test(`target mismatch blocks ${args.join(' ')} before resource requests`, () => {
    const result = runIsolated(args, 'development-target');
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /pinned to TARGET_ENV_ID=development-target.*production-target/
    );
    assert.deepEqual(result.requests, [{ method: 'GET', path: '/whoami' }]);
  });
}

test('shell-only target pin cannot authorize a command', () => {
  const result = runIsolated(['logs', 'synthetic-function'], undefined);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Exporting it in your shell does not count/);
  assert.deepEqual(result.requests, []);
});

test('target lookup prints the authenticated ID without needing or rewriting a pin', () => {
  const result = runIsolated(['target-env'], undefined);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /TARGET_ENV_ID=production-target/);
  assert.deepEqual(result.requests, [{ method: 'GET', path: '/whoami' }]);
});

for (const args of [
  ['train-openapi', 'spec.json', '--context', 'demo.api', '--dry-run'],
  ['train-model', 'model.json', '--dry-run'],
  ['logs', '--help'],
  ['target-env', '--help'],
  ['push', '--show-config'],
]) {
  test(`local command needs no pin or target request: ${args.join(' ')}`, () => {
    const result = runIsolated(args, undefined);
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.requests, []);
  });
}
