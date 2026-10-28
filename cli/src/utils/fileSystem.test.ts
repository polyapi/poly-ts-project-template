import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Type } from '@sinclair/typebox';
import {
  isInArtefactDirectory,
  isInNamedDirectory,
  readJsonFile,
} from './fileSystem';

test('recognizes canonical and legacy artefact directory spellings', () => {
  assert.equal(
    isInArtefactDirectory('/workspace/src/example/artefacts/schemas/item.json'),
    true
  );
  assert.equal(
    isInArtefactDirectory('/workspace/src/example/artifacts/schemas/item.json'),
    true
  );
});

test('recognizes artefact and resource directory segments with Windows separators', () => {
  const legacyPath = String.raw`C:\workspace\src\example\artifacts\vari\item.json`;
  const canonicalPath = String.raw`C:\workspace\src\example\artefacts\schemas\item.json`;

  assert.equal(isInArtefactDirectory(legacyPath), true);
  assert.equal(isInArtefactDirectory(canonicalPath), true);
  assert.equal(isInNamedDirectory(legacyPath, 'vari'), true);
  assert.equal(isInNamedDirectory(canonicalPath, 'schemas'), true);
});

test('does not match partial directory names', () => {
  assert.equal(
    isInArtefactDirectory(
      '/workspace/src/example/not-artifacts/schemas/item.json'
    ),
    false
  );
  assert.equal(
    isInNamedDirectory(
      '/workspace/src/example/schemas-old/item.json',
      'schemas'
    ),
    false
  );
});

test('uses the supplied schema for typed environment substitution', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'flow-json-reader-'));
  const filePath = path.join(directory, 'artifact.json');
  const envName = 'FLOW_TEST_JSON_READER_ENABLED';
  const previousValue = process.env[envName];

  t.after(() => {
    if (previousValue === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previousValue;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  process.env[envName] = 'true';
  writeFileSync(filePath, `{"enabled":"{{${envName}}}"}`);

  assert.deepEqual(
    readJsonFile(filePath, {
      schema: Type.Object({ enabled: Type.Boolean() }),
    }),
    { enabled: true }
  );
});
