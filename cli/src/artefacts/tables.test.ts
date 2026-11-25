import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactSummary } from '../types/summary';
import {
  findMisplacedTableDefinitions,
  findTableFiles,
  syncTables,
} from './tables';

const hotels = {
  name: 'hotels',
  context: 'example.hotels',
  columns: [{ name: 'code', type: 'text', required: true }],
};

test('a table definition left in tabi/data fails, and its table is never an orphan', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tables-'));
  const previous = process.cwd();
  const namespace = process.env.POLYAPI_NAMESPACE;
  const namespaces = process.env.POLYAPI_NAMESPACES;
  t.after(() => {
    process.chdir(previous);
    if (namespace === undefined) delete process.env.POLYAPI_NAMESPACE;
    else process.env.POLYAPI_NAMESPACE = namespace;
    if (namespaces === undefined) delete process.env.POLYAPI_NAMESPACES;
    else process.env.POLYAPI_NAMESPACES = namespaces;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.POLYAPI_NAMESPACE = 'example';
  delete process.env.POLYAPI_NAMESPACES;
  const write = (file: string, content: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write('src/hotels/artefacts/tabi/hotels.json', JSON.stringify(hotels));
  // Flow read this folder for definitions before 1.5.0; JSONC still counts.
  write(
    'src/hotels/artefacts/tabi/data/bookings.json',
    `// kept here by an old layout\n${JSON.stringify({ ...hotels, name: 'bookings' })}`
  );
  write(
    'src/hotels/artefacts/tabi/data/rows.json',
    JSON.stringify({ name: 'hotels', key: 'code', rows: [] })
  );
  process.chdir(root);

  assert.deepEqual(
    findTableFiles().map(table => table.fileName),
    ['hotels.json']
  );
  assert.deepEqual(
    findMisplacedTableDefinitions().map(table => table.content.name),
    ['bookings']
  );

  const remote = [
    { id: 'tbl-1', ...hotels },
    { id: 'tbl-2', ...hotels, name: 'bookings' },
  ];
  const deleted: unknown[] = [];
  const client = {
    async GET(route: string, init: { params?: { path?: { id?: string } } }) {
      if (route === '/tables') {
        return { data: { results: remote, pagination: { page: 1, pages: 1 } } };
      }
      const id = init.params?.path?.id;
      return { data: remote.find(table => table.id === id) };
    },
    async DELETE(route: string, init: unknown) {
      deleted.push([route, init]);
      return { response: { status: 204 } };
    },
  };
  const summary = createArtifactSummary();
  await syncTables(client as never, summary, [], true, false, {
    detectOrphans: true,
  });
  assert.deepEqual(deleted, []);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
});
