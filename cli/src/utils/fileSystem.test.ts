import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTableDataSegments,
  isInArtefactDirectory,
  isInNamedDirectory,
  isTableDataPath,
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

test('finds the segments below artefacts/tabi/data on any platform', () => {
  assert.deepEqual(
    getTableDataSegments('/workspace/src/hotels/artefacts/tabi/data/rows.json'),
    ['rows.json']
  );
  assert.deepEqual(
    getTableDataSegments(
      String.raw`C:\workspace\src\hotels\artifacts\tabi\data\dev\rows.json`
    ),
    ['dev', 'rows.json']
  );
  assert.equal(
    isTableDataPath('/workspace/src/hotels/artefacts/tabi/data/dev/rows.json'),
    true
  );
});

test('table definitions are not table data', () => {
  for (const filePath of [
    '/workspace/src/hotels/artefacts/tabi/hotels.json',
    '/workspace/src/hotels/artefacts/tabi/data.json',
    '/workspace/src/hotels/artefacts/tabi/data',
    '/workspace/src/hotels/tabi/data/rows.json',
  ]) {
    assert.equal(isTableDataPath(filePath), false, filePath);
  }
});
