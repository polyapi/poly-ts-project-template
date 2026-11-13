import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { FunctionArtifactSchema } from '../utils/schemas';
import { findFunctionFiles } from './functions';

test('function metadata resolves boolean environment placeholders', () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'flow-function-boolean-placeholders-')
  );
  const serverDirectory = path.join(directory, 'src', 'example', 'server');
  mkdirSync(serverDirectory, { recursive: true });
  writeFileSync(
    path.join(serverDirectory, 'handler.ts'),
    `export const polyConfig = {
  name: 'handler',
  context: 'example.booleanPlaceholders',
  description: 'Boolean placeholder test.',
  logsEnabled: '{{FUNCTION_LOGS_ENABLED}}',
  cachePolyLibrary: '{{FUNCTION_CACHE_POLY_LIBRARY}}',
};

export function handler(value: unknown): unknown {
  return value;
}
`
  );

  const previousCwd = process.cwd();
  const previousLogs = process.env.FUNCTION_LOGS_ENABLED;
  const previousCache = process.env.FUNCTION_CACHE_POLY_LIBRARY;
  process.env.FUNCTION_LOGS_ENABLED = 'TrUe';
  process.env.FUNCTION_CACHE_POLY_LIBRARY = '0';
  process.chdir(directory);

  try {
    const functions = findFunctionFiles({ respectSkipPaths: false });
    assert.equal(functions.length, 1);
    assert.equal(functions[0].metadata.logsEnabled, true);
    assert.equal(functions[0].metadata.cachePolyLibrary, false);
    assert.equal(
      TypeCompiler.Compile(FunctionArtifactSchema).Check(functions[0].metadata),
      true
    );
  } finally {
    process.chdir(previousCwd);
    if (previousLogs === undefined) delete process.env.FUNCTION_LOGS_ENABLED;
    else process.env.FUNCTION_LOGS_ENABLED = previousLogs;
    if (previousCache === undefined)
      delete process.env.FUNCTION_CACHE_POLY_LIBRARY;
    else process.env.FUNCTION_CACHE_POLY_LIBRARY = previousCache;
    rmSync(directory, { recursive: true, force: true });
  }
});
