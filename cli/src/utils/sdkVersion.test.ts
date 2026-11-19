import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  getPolyapiVersionWarning,
  readInstalledPolyapiVersion,
} from './sdkVersion';

test('compares SDK versions numerically', () => {
  assert.ok(compareVersions('0.28.1', '0.28.1') === 0);
  assert.ok(compareVersions('0.28.10', '0.28.9') > 0);
  assert.ok(compareVersions('0.27.8', '0.28.1') < 0);
  assert.ok(compareVersions('1.0.0-beta.1', '0.28.1') > 0);
});

test('warns only for SDKs older than 0.28.1', () => {
  assert.match(
    getPolyapiVersionWarning('0.27.8') ?? '',
    /polyapi 0\.27\.8.*0\.28\.1 or later/
  );
  assert.equal(getPolyapiVersionWarning('0.28.1'), null);
  assert.equal(getPolyapiVersionWarning('0.28.6'), null);
  assert.equal(getPolyapiVersionWarning(null), null);
});

test('reads the installed workflow SDK version', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'flow-sdk-version-'));
  try {
    const packageDir = path.join(root, 'node_modules', 'polyapi');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'polyapi', version: '0.27.8' })
    );
    assert.equal(readInstalledPolyapiVersion([root]), '0.27.8');
    writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'polyapi' })
    );
    assert.equal(readInstalledPolyapiVersion([root]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
