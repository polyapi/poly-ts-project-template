import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getServerFunctionDeployment,
  parseDeployedFunctionId,
  readServerFunctionDeploymentConfig,
  runServerFunctionPostDeployScript,
} from './serverFunctionDeployment';

const functionId = '12345678-1234-1234-1234-123456789abc';
const server = {
  type: 'server' as const,
  metadata: { context: 'example.database', name: 'adapter' },
};

test('maps exact function identities and preserves colons in images and commands', () => {
  const config = readServerFunctionDeploymentConfig({
    POLY_DEPLOY_SERVER_FUNCTION_IMAGES:
      ' example.database.adapter:runtime-db2:v2,example.other:other-image ',
    POLY_DEPLOY_SERVER_FUNCTION_SCRIPT:
      'example.database.adapter:SETTING=a:b bash scripts/post.sh <id>',
  });
  assert.deepEqual(getServerFunctionDeployment(server, config), {
    image: 'runtime-db2:v2',
    script: 'SETTING=a:b bash scripts/post.sh <id>',
  });
  assert.deepEqual(
    getServerFunctionDeployment({ ...server, type: 'client' }, config),
    {}
  );
  assert.deepEqual(
    getServerFunctionDeployment(
      { ...server, metadata: { context: 'example.database', name: 'Adapter' } },
      config
    ),
    { image: undefined, script: undefined }
  );
  assert.deepEqual(
    getServerFunctionDeployment(server, readServerFunctionDeploymentConfig({})),
    { image: undefined, script: undefined }
  );
});

test('rejects malformed and duplicate mappings without echoing their values', () => {
  for (const name of [
    'POLY_DEPLOY_SERVER_FUNCTION_IMAGES',
    'POLY_DEPLOY_SERVER_FUNCTION_SCRIPT',
  ]) {
    for (const value of [
      'private-value',
      'adapter:private-value',
      'example..adapter:private-value',
      'example.adapter:',
      'example.adapter:private-value,example.adapter:another-value',
    ]) {
      assert.throws(
        () => readServerFunctionDeploymentConfig({ [name]: value }),
        error =>
          error instanceof Error &&
          error.message.includes(name) &&
          !error.message.includes('private-value')
      );
    }
  }
  for (const image of ['ghcr.io/polyapi/db2:latest', 'two words', '-invalid']) {
    assert.throws(() =>
      readServerFunctionDeploymentConfig({
        POLY_DEPLOY_SERVER_FUNCTION_IMAGES: `example.adapter:${image}`,
      })
    );
  }
});

test('accepts only an unambiguous server function ID from successful CLI output', () => {
  assert.equal(
    parseDeployedFunctionId(
      `\u001b[32mFunction ID: ${functionId}\u001b[0m\r\nGenerated`
    ),
    functionId
  );
  for (const output of [
    '',
    `Client Function ID: ${functionId}`,
    'Function ID: $(touch unexpected)',
    `Function ID: ${functionId}\nFunction ID: 87654321-1234-1234-1234-123456789abc`,
  ]) {
    assert.throws(() => parseDeployedFunctionId(output));
  }
});

test('runs hooks from the workspace with pinned environment, IDs and shell overrides', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'flow-hook-'));
  try {
    writeFileSync(
      path.join(root, 'post deploy.sh'),
      'printf \'%s\\n\' "$PWD" "$FUNCTION_ID" "$SERVICE_NAME" "$1" "$SETTING" "$POLY_API_BASE_URL" "$ENVPATH" > "$HOOK_RESULT_FILE"\n'
    );
    await runServerFunctionPostDeployScript({
      functionKey: 'example.database.adapter',
      command: "SETTING=a:b bash 'post deploy.sh' '<id>'",
      functionId,
      cwd: root,
      env: {
        ...process.env,
        FUNCTION_ID: 'stale-id',
        SERVICE_NAME: 'stale-service',
        POLY_API_BASE_URL: 'https://polyapi.test',
        ENVPATH: '/synthetic/workflows/dev.env',
        HOOK_RESULT_FILE: path.join(root, 'result.txt'),
      },
    });
    assert.deepEqual(
      readFileSync(path.join(root, 'result.txt'), 'utf8').trim().split('\n'),
      [
        realpathSync(root),
        functionId,
        `function-${functionId}`,
        functionId,
        'a:b',
        'https://polyapi.test',
        '/synthetic/workflows/dev.env',
      ]
    );
    await assert.rejects(
      runServerFunctionPostDeployScript({
        functionKey: 'example.database.adapter',
        command: 'exit 7',
        functionId,
        cwd: root,
        env: process.env,
      }),
      /exit code 7/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
