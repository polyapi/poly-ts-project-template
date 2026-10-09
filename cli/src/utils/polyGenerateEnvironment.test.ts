import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getPolyGenerateEnvironment } from './polyGenerateEnvironment';

test('preserves SDK configuration and leaves the parent environment unchanged', () => {
  const environment = {
    PATH: '/example/bin',
    API_KEY: 'placeholder-api-key',
    BASE_URL: 'https://polyapi.example.test',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_recursive: 'true',
    NPM_CONFIG_RECURSIVE: 'true',
    Npm_Config_Recursive: 'false',
  };
  const original = { ...environment };

  assert.deepEqual(getPolyGenerateEnvironment(environment), {
    PATH: environment.PATH,
    API_KEY: environment.API_KEY,
    BASE_URL: environment.BASE_URL,
    npm_config_registry: environment.npm_config_registry,
  });
  assert.deepEqual(environment, original);
});

test('npm no longer warns about the recursive setting during SDK generation', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'flow-sdk-npm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const userConfig = path.join(directory, 'user.npmrc');
  const globalConfig = path.join(directory, 'global.npmrc');
  writeFileSync(userConfig, '');
  writeFileSync(globalConfig, '');
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    npm_config_recursive: 'true',
  };
  const args = [
    'config',
    'get',
    'recursive',
    '--userconfig',
    userConfig,
    '--globalconfig',
    globalConfig,
  ];
  const options = {
    cwd: directory,
    encoding: 'utf8' as const,
    shell: process.platform === 'win32',
  };

  const inherited = spawnSync('npm', args, { ...options, env: environment });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.stdout.trim(), 'true');

  const filtered = spawnSync('npm', args, {
    ...options,
    env: getPolyGenerateEnvironment(environment),
  });
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.equal(filtered.stdout.trim(), 'undefined');
  assert.doesNotMatch(filtered.stderr, /Unknown env config ["']recursive["']/);
});
