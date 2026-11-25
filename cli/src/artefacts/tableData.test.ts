import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { TableFile } from '../types';
import { createArtifactSummary } from '../types/summary';
import {
  canonicalJson,
  collectTableDataSets,
  comparableRowKey,
  findTableDataFiles,
  getFileTimestamp,
  getTableDataEnvironment,
  mergeTableDataFiles,
  parseTableDataDocument,
  planInsertRequests,
  planTableDataSet,
  planUpdateRequests,
  storageType,
  syncTableData,
  type TableDataColumn,
  type TableDataColumns,
  type TableDataFile,
  type TableDataSet,
  tableValuesEqual,
  toInstant,
  validateTableDataFiles,
} from './tableData';
import { findTableFiles } from './tables';

type Row = Record<string, unknown>;

const CONTEXT = 'example.hotels';
const COLUMN_LIST: TableDataColumn[] = [
  { name: 'id', type: 'uuid', required: true, default: 'gen_random_uuid()' },
  { name: 'createdAt', type: 'timestamptz', required: true, default: 'now()' },
  { name: 'updatedAt', type: 'timestamptz', required: true, default: 'now()' },
  { name: 'hotelId', type: 'text', required: true },
  { name: 'name', type: 'text', required: true },
  { name: 'rooms', type: 'integer' },
  { name: 'rate', type: 'numeric' },
  { name: 'stars', type: 'integer', default: 3 },
  { name: 'enabled', type: 'boolean', required: true, default: true },
  { name: 'openedAt', type: 'timestamptz' },
  { name: 'settings', type: 'jsonb' },
  { name: 'note', type: 'text', default: 'none' },
];
const COLUMNS: TableDataColumns = new Map(
  COLUMN_LIST.map(column => [column.name, column])
);
const OLD = '2020-01-01T00:00:00.000Z';
const FILE_TIME = Date.UTC(2026, 10, 20);
const NOW = new Date(Date.UTC(2026, 10, 25, 12));

const doc = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  context: CONTEXT,
  name: 'hotelMetadata',
  key: 'hotelId',
  rows,
  ...extra,
});

const dataFile = (
  filePath: string,
  data: unknown,
  environment = ''
): TableDataFile => ({ filePath, environment, data });

const brokenFile = (filePath: string, environment = ''): TableDataFile => ({
  filePath,
  environment,
  data: undefined,
  error: 'not valid JSON',
});

function throwsWith(run: () => unknown, text: string): void {
  let message: string | undefined;
  try {
    run();
  } catch (error) {
    message = (error as Error).message;
  }
  assert.ok(message !== undefined, `expected an error containing "${text}"`);
  assert.ok(message.includes(text), `"${message}" does not contain "${text}"`);
}

const originalEnv = new WeakMap<TestContext, Map<string, string | undefined>>();

/** Set environment variables until the test ends. */
function setEnv(t: TestContext, values: Record<string, string | undefined>) {
  let saved = originalEnv.get(t);
  if (!saved) {
    const restore = new Map<string, string | undefined>();
    originalEnv.set(t, restore);
    saved = restore;
    t.after(() => {
      for (const [name, value] of restore) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
  }
  for (const [name, value] of Object.entries(values)) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** A workflows project in a temp folder, as Flow's working directory. */
function useProject(
  t: TestContext
): (file: string, content: unknown) => string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-table-data-'));
  const previous = process.cwd();
  fs.mkdirSync(path.join(root, 'src'));
  process.chdir(root);
  setEnv(t, {
    POLYAPI_NAMESPACE: 'example',
    POLYAPI_NAMESPACES: undefined,
    POLY_DEPLOY_SKIP_PATHS: undefined,
    POLY_DEPLOY_PRIORITY_PATHS: undefined,
    POLY_DEPLOY_TABLE_DATA_ENV: undefined,
  });
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return (file, content) => {
    const target = path.join(fs.realpathSync(root), file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof content === 'string' ? content : JSON.stringify(content)
    );
    return target;
  };
}

const stored = (id: string, hotelId: string, columns: Row = {}): Row => ({
  id,
  createdAt: OLD,
  updatedAt: OLD,
  hotelId,
  name: `Hotel ${hotelId}`,
  rooms: null,
  rate: null,
  stars: 3,
  enabled: true,
  openedAt: null,
  settings: null,
  note: 'none',
  ...columns,
});

/**
 * Flow's API client over one in-memory Tabi table. Like Tabi, it binds equal
 * values to one parameter (refusing a request that gives one two types) and
 * writes NULL into the columns a row of a multi-row insert leaves out.
 */
class FakeTabi {
  calls: Array<{ route: string; body?: any }> = [];
  rows: Row[];
  failOn?: string;
  private nextId = 0;

  constructor(
    rows: Row[] = [],
    private readonly tableExists = true
  ) {
    this.rows = rows.map(row => ({ ...row }));
  }

  async GET(route: string) {
    this.calls.push({ route });
    if (route === '/tables') {
      return {
        data: {
          results: this.tableExists
            ? [{ id: 'tbl-1', name: 'hotelMetadata', context: CONTEXT }]
            : [],
          pagination: { page: 1, pages: 1 },
        },
        response: { status: 200 },
      };
    }
    return {
      data: { id: 'tbl-1', columns: COLUMN_LIST },
      response: { status: 200 },
    };
  }

  async POST(route: string, init: { body: any }) {
    const body = init.body;
    this.calls.push({ route, body });
    if (route === '/tables/{id}/select') {
      const sorted = [...this.rows].sort((a, b) =>
        String(a.id).localeCompare(String(b.id))
      );
      return {
        data: { results: sorted.slice(body.offset, body.offset + body.limit) },
        response: { status: 200 },
      };
    }
    if (this.failOn === route) {
      return { error: { message: 'Tabi is down' }, response: { status: 503 } };
    }
    const bound = new Map<unknown, string>();
    const bind = (column: string, value: unknown): boolean => {
      const storage = storageType(COLUMNS.get(column)?.type);
      const parameter = storage === 'jsonb' ? JSON.stringify(value) : value;
      const known = bound.get(parameter);
      bound.set(parameter, known ?? storage);
      return known === undefined || known === storage;
    };
    const refused = {
      error: { message: 'inconsistent types deduced for parameter $1' },
      response: { status: 500 },
    };
    if (route === '/tables/{id}/insert') {
      const names = [...new Set<string>(body.data.flatMap(Object.keys))];
      for (const row of body.data) {
        for (const column of names) {
          if (!bind(column, row[column])) return refused;
        }
      }
      const created = body.data.map((row: Row) => ({
        id: `new-${++this.nextId}`,
        createdAt: OLD,
        updatedAt: OLD,
        ...Object.fromEntries(
          names.map(column => [column, row[column] ?? null])
        ),
      }));
      this.rows.push(...created);
      return { data: { results: created }, response: { status: 201 } };
    }
    if (route === '/tables/{id}/update') {
      const id = body.where.id.equals;
      if (!bind('id', id)) return refused;
      for (const [column, value] of Object.entries(body.data)) {
        if (!bind(column, value)) return refused;
      }
      const row = this.rows.find(candidate => candidate.id === id);
      Object.assign(row ?? {}, body.data);
      return { data: { results: row ? [row] : [] }, response: { status: 201 } };
    }
    if (route === '/tables/{id}/delete') {
      const before = this.rows.length;
      this.rows = this.rows.filter(row => !body.where.id.in.includes(row.id));
      return {
        data: { deleted: before - this.rows.length },
        response: { status: 201 },
      };
    }
    throw new Error(`Unexpected POST ${route}`);
  }

  writes(kind: 'insert' | 'update' | 'delete'): any[] {
    return this.calls
      .filter(call => call.route === `/tables/{id}/${kind}`)
      .map(call => call.body);
  }

  row(hotelId: string): Row | undefined {
    return this.rows.find(row => row.hotelId === hotelId);
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colours
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

function recorder() {
  const lines: string[] = [];
  const record = (message: string) => {
    lines.push(plain(message));
  };
  return { lines, reporter: { info: record, warn: record } };
}

async function sync(
  tabi: FakeTabi,
  options: Parameters<typeof syncTableData>[2] = {}
) {
  const summary = createArtifactSummary();
  const { lines, reporter } = recorder();
  await syncTableData(tabi as any, summary, {
    reporter,
    fileTimestamp: () => FILE_TIME,
    now: () => NOW,
    ...options,
  });
  return { summary, lines };
}

// --- files and settings ---

test('data files: shared, per environment, and refused when misplaced', t => {
  const write = useProject(t);
  write('src/hotels/artefacts/tabi/hotelMetadata.json', {
    name: 'hotelMetadata',
    context: CONTEXT,
    columns: COLUMN_LIST.slice(3),
  });
  write('src/hotels/artefacts/tabi/data/hotels.json', doc([]));
  write(
    'src/hotels/artefacts/tabi/data/bom.json',
    `﻿${JSON.stringify(doc([]))}`
  );
  write('src/hotels/artefacts/tabi/data/dev/hotels.json', doc([]));
  write('src/hotels/artefacts/tabi/data/dev/old/hotels.json', doc([]));
  write('src/hotels/artefacts/tabi/data/Prod/hotels.json', doc([]));
  write('src/hotels/artefacts/tabi/data/broken.json', '{ "name": ');
  write('src/hotels/artefacts/tabi/data/rows.test.json', doc([]));
  write('src/hotels/artefacts/tabi/data/.keep', '');

  const found = findTableDataFiles()
    .map(file => [
      path.relative('src/hotels/artefacts/tabi/data', file.filePath),
      file.environment,
      file.error ?? 'ok',
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  assert.deepEqual(found, [
    ['bom.json', '', 'ok'],
    ['broken.json', '', 'not valid JSON'],
    ['dev/hotels.json', 'dev', 'ok'],
    [
      'dev/old/hotels.json',
      'dev',
      'nested too deep: keep table data files in data/ or data/<environment>/',
    ],
    ['hotels.json', '', 'ok'],
    [
      'Prod/hotels.json',
      'Prod',
      "folder 'Prod' is not an environment name: use lowercase letters, digits, '_' or '-'",
    ],
  ]);
  // Table definitions never pick up data files.
  assert.deepEqual(
    findTableFiles().map(table => table.fileName),
    ['hotelMetadata.json']
  );
});

test('POLY_DEPLOY_TABLE_DATA_ENV names one lowercase environment folder', t => {
  for (const [value, expected] of [
    [undefined, ''],
    [' dev ', 'dev'],
    ['eu-prod_2', 'eu-prod_2'],
  ]) {
    setEnv(t, { POLY_DEPLOY_TABLE_DATA_ENV: value });
    assert.equal(getTableDataEnvironment(), expected);
  }
  for (const value of ['Prod', '../prod', 'a b', '-x']) {
    setEnv(t, { POLY_DEPLOY_TABLE_DATA_ENV: value });
    throwsWith(getTableDataEnvironment, 'POLY_DEPLOY_TABLE_DATA_ENV must be');
  }
});

// --- parsing and validation ---

test('a data file names its table and key', () => {
  const parsed = parseTableDataDocument(
    doc([{ hotelId: 'PRG', name: 'Prague' }]),
    COLUMNS
  );
  assert.deepEqual(
    [parsed.context, parsed.name, parsed.key],
    [CONTEXT, 'hotelMetadata', ['hotelId']]
  );
  assert.deepEqual(
    parseTableDataDocument({ name: 't', key: ['a', 'b'], rows: [] }).key,
    ['a', 'b']
  );
});

for (const [data, message] of [
  [[], 'must be a JSON object'],
  [{ ...doc([]), extra: 1 }, "unknown key 'extra'"],
  [{ key: 'a', rows: [] }, 'name is required'],
  [{ name: 't', context: 3, key: 'a', rows: [] }, 'context must be'],
  [{ name: 't', description: 1, key: 'a', rows: [] }, 'description must be'],
  [{ name: 't', key: [], rows: [] }, 'key is required'],
  [{ name: 't', key: ['a', 'a'], rows: [] }, 'key is required'],
  [{ name: 't', key: 'updatedAt', rows: [] }, 'key cannot use updatedAt'],
  [{ name: 't', key: 'a', rows: {} }, 'rows is required'],
  [{ name: 't', key: 'a', rows: ['x'] }, 'row 1 must be an object'],
  [{ name: 't', key: 'a', rows: [{ a: '1', id: 'x' }] }, "row 1 sets 'id'"],
  [{ name: 't', key: 'a', rows: [{ a: ' ' }] }, "key column 'a'"],
  [{ name: 't', key: 'a', rows: [{ a: true }] }, "key column 'a'"],
  [{ name: 't', key: 'a', rows: [{ a: null }] }, "key column 'a'"],
  [{ name: 't', key: 'a', rows: [{ a: 'x' }, { a: 'x' }] }, 'row 2 repeats'],
] as const) {
  test(`a data file is refused: ${message}`, () => {
    throwsWith(() => parseTableDataDocument(data), message);
  });
}

test('rows are checked against the columns, and messages carry no values', () => {
  throwsWith(
    () => parseTableDataDocument({ ...doc([]), key: 'slug' }, COLUMNS),
    "key column 'slug' is not a column of the table"
  );
  throwsWith(
    () => parseTableDataDocument(doc([{ hotelId: 'A', nmae: 'x' }]), COLUMNS),
    "row 1 sets 'nmae', which is not a column of the table"
  );
  throwsWith(
    () =>
      parseTableDataDocument(doc([{ hotelId: 'A', enabled: null }]), COLUMNS),
    "row 1 sets required column 'enabled' to null"
  );
  // A row may list just its key and the columns it changes.
  parseTableDataDocument(doc([{ hotelId: 'A', rooms: null }]), COLUMNS);
  assert.throws(
    () =>
      parseTableDataDocument({
        name: 't',
        key: 'a',
        rows: [{ a: 'secret-1' }, { a: 'secret-1' }],
      }),
    { message: 'row 2 repeats the key of row 1; each row needs its own key' }
  );
});

test('environment rows overlay shared rows column by column', () => {
  const shared = '/p/src/h/artefacts/tabi/data/hotels.json';
  const dev = '/p/src/h/artefacts/tabi/data/dev/hotels.json';
  const set = mergeTableDataFiles([
    dataFile(
      dev,
      doc([
        { hotelId: 'A', enabled: true },
        { hotelId: 'D', name: 'Dev only' },
      ]),
      'dev'
    ),
    dataFile(
      shared,
      doc([
        { hotelId: 'A', name: 'Shared A', enabled: false },
        { hotelId: 'B', name: 'Shared B' },
      ])
    ),
  ]);
  assert.deepEqual(set.rows, [
    {
      row: { hotelId: 'A', name: 'Shared A', enabled: true },
      files: [shared, dev],
    },
    { row: { hotelId: 'B', name: 'Shared B' }, files: [shared] },
    { row: { hotelId: 'D', name: 'Dev only' }, files: [dev] },
  ]);
  assert.deepEqual(set.files, [shared, dev]);
});

test('a row in two files of one level, or two keys for one table, is refused', () => {
  throwsWith(
    () =>
      mergeTableDataFiles([
        dataFile('/p/a.json', doc([{ hotelId: 'A' }])),
        dataFile('/p/b.json', doc([{ hotelId: 'A' }])),
      ]),
    'b.json: row A is also in'
  );
  throwsWith(
    () =>
      mergeTableDataFiles([
        dataFile('/p/a.json', doc([])),
        dataFile('/p/dev/a.json', doc([], { key: 'name' }), 'dev'),
      ]),
    'every data file of a table must use the same key'
  );
  throwsWith(
    () => mergeTableDataFiles([brokenFile('/p/x.json')]),
    'x.json: not valid JSON'
  );
});

test('a run syncs data/ and its own environment folder, and selects whole tables', () => {
  const folder = '/p/src/h/artefacts/tabi/data';
  const files = [
    dataFile(`${folder}/a.json`, doc([{ hotelId: 'A', name: 'A' }])),
    dataFile(`${folder}/dev/a.json`, doc([{ hotelId: 'D', name: 'D' }]), 'dev'),
    dataFile(
      `${folder}/prod/a.json`,
      doc([{ hotelId: 'P', name: 'P' }]),
      'prod'
    ),
    dataFile('/p/src/o/artefacts/tabi/data/b.json', {
      context: 'example.other',
      name: 'other',
      key: 'k',
      rows: [],
    }),
  ];
  const scoped = collectTableDataSets(files, {
    environment: 'dev',
    pathFilters: [`${folder}/dev`],
  });
  assert.deepEqual(
    scoped.map(set => [set.name, set.rows.map(({ row }) => row.hotelId)]),
    [['hotelMetadata', ['A', 'D']]]
  );
  assert.deepEqual(
    collectTableDataSets(files, { environment: '', pathFilters: [] }).map(
      set => [set.name, set.rows.length]
    ),
    [
      ['hotelMetadata', 1],
      ['other', 0],
    ]
  );
  // A broken file of another environment does not matter to this run; one
  // this run reads stops it, since its rows could belong to any table.
  assert.equal(
    collectTableDataSets(
      [...files, brokenFile(`${folder}/prod/x.json`, 'prod')],
      {
        environment: 'dev',
        pathFilters: [],
      }
    ).length,
    2
  );
  throwsWith(
    () =>
      collectTableDataSets(
        [...files, brokenFile(`${folder}/dev/x.json`, 'dev')],
        {
          environment: 'dev',
          pathFilters: [`${folder}/a.json`],
        }
      ),
    'x.json: not valid JSON'
  );
});

test('validation checks every environment folder of the selected tables', () => {
  const folder = '/p/src/h/artefacts/tabi/data';
  const definition: TableFile = {
    filePath: '/p/src/h/artefacts/tabi/hotelMetadata.json',
    fileName: 'hotelMetadata.json',
    content: { name: 'hotelMetadata', context: CONTEXT, columns: COLUMN_LIST },
  };
  const files = [
    dataFile(`${folder}/a.json`, doc([{ hotelId: 'A', name: 'A' }])),
    dataFile(`${folder}/dev/a.json`, doc([{ hotelId: 'A', rooms: 3 }]), 'dev'),
    dataFile(
      `${folder}/prod/a.json`,
      doc([{ hotelId: 'A', colour: 'red' }]),
      'prod'
    ),
    dataFile(
      `${folder}/prod/b.json`,
      doc([{ hotelId: 'B', name: 'B' }]),
      'prod'
    ),
    dataFile(
      `${folder}/prod/c.json`,
      doc([{ hotelId: 'B', name: 'B' }]),
      'prod'
    ),
    brokenFile('/p/src/o/artefacts/tabi/data/broken.json'),
  ];
  const result = validateTableDataFiles(files, [definition]);
  assert.equal(result.fileCount, 6);
  assert.deepEqual(
    [...result.invalidFiles].map(file => path.relative(folder, file)).sort(),
    [
      '../../../../o/artefacts/tabi/data/broken.json',
      'prod/a.json',
      'prod/c.json',
    ]
  );
  assert.equal(result.problems.length, 3);
  assert.ok(result.problems[0].endsWith('broken.json: not valid JSON'));
  assert.ok(
    result.problems[1].endsWith(
      "prod/a.json: row 1 sets 'colour', which is not a column of the table"
    )
  );
  assert.match(result.problems[2], /prod\/c\.json: row B is also in .*b\.json/);

  // A scoped run checks the tables it selects, and every unreadable file.
  const scoped = validateTableDataFiles(files, [definition], ['/p/src/o']);
  assert.deepEqual(
    [scoped.fileCount, scoped.problems.length, scoped.invalidFiles.size],
    [1, 1, 1]
  );
  assert.deepEqual(
    validateTableDataFiles(files.slice(0, 2), [definition]).problems,
    []
  );
});

// --- comparing values ---

for (const [type, local, remote, equal] of [
  ['numeric', 10.5, '10.50', true],
  ['number', '7', 7, true],
  ['integer', 3, 4, false],
  ['integer', true, 1, false],
  ['bigint', 3, '3', true],
  ['double', 0.5, '0.5', true],
  ['date', '2026-11-01', '2026-11-01T00:00:00.000Z', true],
  [
    'timestamptz',
    '2026-11-01T10:00:00+01:00',
    '2026-11-01T09:00:00.000Z',
    true,
  ],
  ['timestamp', '2026-11-01 10:00:00', '2026-11-01T10:00:00.000Z', true],
  ['timestamptz', '2026-11-01T10:00:00Z', '2026-11-01T10:00:01.000Z', false],
  ['timestamptz', 'soon', 'soon', true],
  ['uuid', 'ABC-1', 'abc-1', true],
  ['jsonb', { a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }, true],
  ['jsonb', { a: 1 }, '{"a": 1}', true],
  ['object', { a: true }, { a: 1 }, false],
  ['text', 'x', 'X', false],
  ['text', null, null, true],
  ['text', '', null, false],
  ['boolean', false, null, false],
] as const) {
  test(`${type}: ${JSON.stringify(local)} vs ${JSON.stringify(remote)} is ${equal ? 'equal' : 'a change'}`, () => {
    assert.equal(tableValuesEqual(type, local, remote), equal);
  });
}

test('instants, keys and JSON compare as the table stores them', () => {
  assert.equal(toInstant('2026-11-23'), Date.UTC(2026, 10, 23));
  assert.equal(toInstant('2026-11-23 10:30'), Date.UTC(2026, 10, 23, 10, 30));
  assert.equal(toInstant('1'), null);
  assert.equal(
    comparableRowKey({ rooms: '07', id: 'ABC' }, ['rooms', 'id'], COLUMNS),
    comparableRowKey({ rooms: 7, id: 'abc' }, ['rooms', 'id'], COLUMNS)
  );
  assert.equal(
    canonicalJson({ b: 1, a: { d: 1, c: 2 } }),
    '{"a":{"c":2,"d":1},"b":1}'
  );
  assert.deepEqual(
    ['string', 'Number', 'int4', 'serial', 'object', 'custom'].map(storageType),
    ['text', 'numeric', 'integer', 'integer', 'jsonb', 'custom']
  );
});

// --- planning ---

const setOf = (rows: Row[], files = ['/p/f.json']): TableDataSet => ({
  context: CONTEXT,
  name: 'hotelMetadata',
  key: ['hotelId'],
  rows: rows.map(row => ({ row, files })),
  files,
});

const plan = (local: Row[], remoteRows: Row[], force = false) =>
  planTableDataSet({
    set: setOf(local),
    columns: COLUMNS,
    remoteRows,
    force,
    fileTimestamp: () => FILE_TIME,
    now: NOW,
  });

test('a plan inserts, updates the listed columns that differ, and finds extras', () => {
  const result = plan(
    [
      { hotelId: 'NEW', name: 'New', rooms: 12 },
      { hotelId: 'SAME', name: 'Hotel SAME', rate: 10.5 },
      { hotelId: 'EDIT', name: 'Renamed', settings: { floor: 2 } },
      { hotelId: 'PART', enabled: false },
    ],
    [
      stored('r1', 'SAME', { rate: '10.50', settings: { kept: true } }),
      stored('r2', 'EDIT', { settings: { floor: 1 } }),
      stored('r3', 'PART'),
      stored('r4', 'EXTRA'),
    ]
  );
  assert.deepEqual(
    result.inserts.map(row => row.hotelId),
    ['NEW']
  );
  assert.deepEqual(
    result.updates.map(({ row, changed, requests }) => [
      row.hotelId,
      changed,
      requests,
    ]),
    [
      [
        'EDIT',
        ['name', 'settings'],
        [
          {
            name: 'Renamed',
            settings: { floor: 2 },
            updatedAt: NOW.toISOString(),
          },
        ],
      ],
      ['PART', ['enabled'], [{ enabled: false, updatedAt: NOW.toISOString() }]],
    ]
  );
  assert.equal(result.unchanged, 1);
  assert.deepEqual(
    result.extras.map(row => row.hotelId),
    ['EXTRA']
  );
  assert.deepEqual(result.blocked, []);
});

test('a row changed in the table at or after its newest file is blocked unless forced', () => {
  const local = [{ hotelId: 'A', name: 'From file' }];
  const later = [
    stored('r1', 'A', { name: 'From app', updatedAt: '2026-11-22T08:00:00Z' }),
  ];
  const blocked = plan(local, later);
  assert.deepEqual(blocked.updates, []);
  assert.deepEqual(blocked.blocked, [
    'A (changed in the table at 2026-11-22T08:00:00Z; its file last changed at 2026-11-20T00:00:00Z)',
  ]);
  assert.equal(plan(local, later, true).updates.length, 1);
  const sameTime = [
    stored('r1', 'A', { updatedAt: new Date(FILE_TIME).toISOString() }),
  ];
  assert.equal(plan(local, sameTime).blocked.length, 1);

  const merged: TableDataSet = {
    ...setOf([]),
    rows: [{ row: local[0], files: ['/old.json', '/new.json'] }],
  };
  const newest = planTableDataSet({
    set: merged,
    columns: COLUMNS,
    remoteRows: [stored('r1', 'A', { updatedAt: '2026-11-21T00:00:00Z' })],
    force: false,
    fileTimestamp: file =>
      file === '/new.json' ? Date.UTC(2026, 10, 22) : Date.UTC(2026, 0, 1),
    now: NOW,
  });
  assert.equal(newest.updates.length, 1);
});

test('a plan refuses duplicate keys and new rows missing a required value', () => {
  throwsWith(
    () => plan([], [stored('r1', 'A'), stored('r2', 'A')]),
    'several table rows have key A'
  );
  const numeric = new Map(COLUMNS);
  numeric.set('hotelId', { name: 'hotelId', type: 'integer', required: true });
  throwsWith(
    () =>
      planTableDataSet({
        set: setOf([
          { hotelId: 7, name: 'a' },
          { hotelId: '07', name: 'b' },
        ]),
        columns: numeric,
        remoteRows: [],
        force: false,
        fileTimestamp: () => FILE_TIME,
        now: NOW,
      }),
    'row 07 is listed twice'
  );
  throwsWith(
    () => plan([{ hotelId: 'N' }], []),
    "new row N needs a value for required column 'name'; nothing was written"
  );
});

test('inserts group rows that set the same columns, leaving out needless nulls', () => {
  assert.deepEqual(
    planInsertRequests(
      [
        { hotelId: 'A', name: 'A', rooms: null },
        { hotelId: 'B', name: 'B', rooms: 3 },
        { hotelId: 'C', name: 'C' },
        { hotelId: 'D', name: 'D', note: null },
      ],
      ['hotelId'],
      COLUMNS
    ),
    [
      {
        rows: [
          { hotelId: 'A', name: 'A' },
          { hotelId: 'C', name: 'C' },
        ],
        followUps: [],
      },
      { rows: [{ hotelId: 'B', name: 'B', rooms: 3 }], followUps: [] },
      // note has a default, so its null must be written.
      { rows: [{ hotelId: 'D', name: 'D', note: null }], followUps: [] },
    ]
  );
});

test('inserts stay within 100 rows and 768 KiB per request', () => {
  const sizes = (rows: Row[]) =>
    planInsertRequests(rows, ['hotelId'], COLUMNS).map(
      request => request.rows.length
    );
  assert.deepEqual(
    sizes(
      Array.from({ length: 250 }, (_, i) => ({ hotelId: `H${i}`, name: 'n' }))
    ),
    [100, 100, 50]
  );
  assert.deepEqual(
    sizes(
      Array.from({ length: 5 }, (_, i) => ({
        hotelId: `H${i}`,
        name: 'x'.repeat(300 * 1024),
      }))
    ),
    [2, 2, 1]
  );
  assert.deepEqual(
    sizes([{ hotelId: 'A', name: 'x'.repeat(2 * 1024 * 1024) }]),
    [1]
  );
});

test('one value never meets columns of two types in one request', () => {
  // rate 2 (numeric) would share a parameter with rooms 2 (integer).
  assert.deepEqual(
    planInsertRequests(
      [
        { hotelId: 'A', name: 'A', rooms: 2, rate: 1.5 },
        { hotelId: 'B', name: 'B', rooms: 3, rate: 2 },
      ],
      ['hotelId'],
      COLUMNS
    ).map(request => request.rows.map(row => row.hotelId)),
    [['A'], ['B']]
  );
  // Within one row: insert what fits, then update the rest.
  assert.deepEqual(
    planInsertRequests(
      [{ hotelId: 'A', name: 'A', rooms: 2, rate: 2, stars: null, note: null }],
      ['hotelId'],
      COLUMNS
    ),
    [
      {
        rows: [{ hotelId: 'A', name: 'A', rooms: 2, stars: null }],
        followUps: [{ rate: 2, note: null }],
      },
    ]
  );
  const strict = new Map(COLUMNS);
  strict.set('code', { name: 'code', type: 'integer', required: true });
  strict.set('floors', { name: 'floors', type: 'numeric', required: true });
  throwsWith(
    () =>
      planInsertRequests(
        [{ hotelId: 'A', name: 'A', code: 7, floors: 7 }],
        ['hotelId'],
        strict
      ),
    "new row A cannot be inserted: required columns 'code' and 'floors' have different types"
  );
  assert.deepEqual(
    planUpdateRequests(
      { rooms: null, settings: null, openedAt: null, rate: 2, updatedAt: 'T' },
      COLUMNS,
      'r1'
    ),
    [
      { rooms: null, settings: null, rate: 2, updatedAt: 'T' },
      { openedAt: null },
    ]
  );
});

// --- sync ---

const HOTELS = 'src/hotels/artefacts/tabi/data/hotels.json';

test('a dry run plans the changes without writing', async t => {
  const write = useProject(t);
  write(
    HOTELS,
    doc([
      { hotelId: 'A', name: 'Renamed A' },
      { hotelId: 'B', name: 'Hotel B' },
      { hotelId: 'C', name: 'Hotel C', rooms: null },
    ])
  );
  const tabi = new FakeTabi([
    stored('r1', 'A'),
    stored('r2', 'B'),
    stored('r9', 'Z'),
  ]);
  const { summary, lines } = await sync(tabi, { dryRun: true, prune: true });
  assert.deepEqual(
    tabi.calls.map(call => call.route),
    ['/tables', '/tables/{id}', '/tables/{id}/select']
  );
  assert.deepEqual(
    [summary.planned, summary.skipped, summary.created, summary.failed],
    [3, 1, 0, 0]
  );
  for (const line of [
    '  → hotelMetadata (example.hotels)',
    '    3 row(s) from 1 file(s), keyed by hotelId',
    '    Would insert: C',
    '    Would update A: name',
    '    Would delete rows no file lists: Z',
    '    [PLAN] 1 inserted, 1 updated, 1 deleted, 1 unchanged',
  ]) {
    assert.ok(
      lines.includes(line),
      `missing "${line}" in\n${lines.join('\n')}`
    );
  }
});

test('a push inserts, updates, prunes on request, and a second push changes nothing', async t => {
  const write = useProject(t);
  write(
    HOTELS,
    doc([
      { hotelId: 'A', name: 'Hotel A', rate: 10.5 },
      { hotelId: 'B', name: 'Renamed B', settings: { floor: 2 } },
      { hotelId: 'C', name: 'Hotel C', rooms: 12, openedAt: null },
      { hotelId: 'D', name: 'Hotel D' },
    ])
  );
  const tabi = new FakeTabi([
    stored('r1', 'A', { rate: '10.50', settings: { kept: true } }),
    stored('r2', 'B', { settings: { floor: 1 } }),
    stored('r3', 'X'),
  ]);
  const first = await sync(tabi);
  assert.deepEqual(tabi.writes('insert'), [
    { data: [{ hotelId: 'C', name: 'Hotel C', rooms: 12 }] },
    { data: [{ hotelId: 'D', name: 'Hotel D' }] },
  ]);
  assert.deepEqual(tabi.writes('update'), [
    {
      where: { id: { equals: 'r2' } },
      data: {
        name: 'Renamed B',
        settings: { floor: 2 },
        updatedAt: NOW.toISOString(),
      },
    },
  ]);
  assert.deepEqual(tabi.writes('delete'), []);
  // Columns a file leaves out keep their values; defaults apply to new rows.
  assert.deepEqual(tabi.row('A')?.settings, { kept: true });
  assert.ok(
    first.lines.includes(
      '    Rows no file lists, kept: X (--prune-table-data deletes them)'
    )
  );
  assert.ok(
    first.lines.includes(
      '    [OK] 2 inserted, 1 updated, 0 deleted, 1 unchanged'
    )
  );
  assert.deepEqual(
    [first.summary.created, first.summary.updated, first.summary.skipped],
    [2, 1, 1]
  );

  tabi.calls = [];
  const second = await sync(tabi, { prune: true });
  assert.deepEqual(tabi.writes('delete'), [{ where: { id: { in: ['r3'] } } }]);
  assert.deepEqual(
    [second.summary.created, second.summary.updated, second.summary.deleted],
    [0, 0, 1]
  );
  assert.equal(second.summary.skipped, 4);

  tabi.calls = [];
  const third = await sync(tabi, { prune: true });
  assert.deepEqual(
    tabi.calls.map(call => call.route),
    ['/tables', '/tables/{id}', '/tables/{id}/select']
  );
  assert.equal(third.summary.skipped, 4);
});

test('rows changed in the table after their file are blocked unless forced', async t => {
  const write = useProject(t);
  write(HOTELS, doc([{ hotelId: 'A', name: 'From file' }]));
  const tabi = new FakeTabi([
    stored('r1', 'A', { name: 'From app', updatedAt: '2026-11-21T00:00:00Z' }),
  ]);
  const blocked = await sync(tabi);
  assert.deepEqual(tabi.writes('update'), []);
  assert.equal(blocked.summary.blocked, 1);
  assert.ok(
    blocked.lines.includes(
      '    [BLOCKED] Not updated: A (changed in the table at 2026-11-21T00:00:00Z; its file last changed at 2026-11-20T00:00:00Z); --force overwrites it'
    )
  );
  const forced = await sync(tabi, { force: true });
  assert.equal(forced.summary.updated, 1);
  assert.equal(tabi.row('A')?.name, 'From file');
});

test('a value meeting columns of two types takes several requests that Tabi accepts', async t => {
  const write = useProject(t);
  write(
    HOTELS,
    doc([
      { hotelId: 'A', name: 'A', rooms: 2, rate: 2 },
      { hotelId: 'B', name: 'B', rooms: null, openedAt: null },
    ])
  );
  const tabi = new FakeTabi([
    stored('r1', 'B', { rooms: 5, openedAt: '2026-01-01T00:00:00.000Z' }),
  ]);
  const { summary, lines } = await sync(tabi);
  assert.equal(summary.failed, 0, lines.join('\n'));
  assert.deepEqual([summary.created, summary.updated], [1, 1]);
  assert.deepEqual([tabi.row('A')?.rooms, tabi.row('A')?.rate], [2, 2]);
  assert.deepEqual(
    [tabi.row('B')?.rooms, tabi.row('B')?.openedAt],
    [null, null]
  );
  assert.equal(tabi.writes('update').length, 3);
  assert.ok(
    lines.includes(
      '    2 row(s) take several requests: one value in columns of different types cannot share a Tabi request'
    )
  );
});

test('a table is not written when its files are invalid, outside the namespace, or not deployed', async t => {
  const write = useProject(t);
  const hotels = write(HOTELS, doc([{ hotelId: 'A', name: 'A' }]));
  const tabi = new FakeTabi();
  const invalid = await sync(tabi, { invalidFiles: new Set([hotels]) });
  assert.equal(invalid.summary.failed, 1);
  assert.ok(
    invalid.lines.includes(
      '    [FAIL] skipped: its data files failed local validation'
    )
  );
  // A problem in another environment's folder does not stop this one.
  const prod = write(
    'src/hotels/artefacts/tabi/data/prod/hotels.json',
    doc([])
  );
  const dev = await sync(tabi, {
    dryRun: true,
    environment: 'dev',
    invalidFiles: new Set([prod]),
  });
  assert.deepEqual([dev.summary.failed, dev.summary.planned], [0, 1]);

  setEnv(t, { POLYAPI_NAMESPACE: 'other' });
  const foreign = await sync(tabi);
  assert.equal(foreign.summary.failed, 1);
  setEnv(t, { POLYAPI_NAMESPACE: 'example' });
  assert.deepEqual(tabi.writes('insert'), []);

  const missing = new FakeTabi([], false);
  const planned = await sync(missing, { dryRun: true });
  assert.equal(planned.summary.planned, 1);
  assert.ok(
    planned.lines.includes('    [PLAN] Insert 1 row(s) once the table exists')
  );
  const failed = await sync(missing);
  assert.equal(failed.summary.failed, 1);
  assert.ok(
    failed.lines.includes(
      '    [FAIL] table not found; deploy its definition first (--types tables)'
    )
  );
});

test('a table with a broken data file fails alone; the others still sync', async t => {
  const write = useProject(t);
  write(HOTELS, doc([{ hotelId: 'A', name: 'A' }]));
  write('src/brands/artefacts/tabi/data/brands.json', {
    context: 'example.brands',
    name: 'brands',
    key: 'code',
    rows: {},
  });
  const tabi = new FakeTabi();
  const { summary, lines } = await sync(tabi);
  assert.deepEqual([summary.failed, summary.created], [1, 1]);
  assert.ok(
    lines.includes(
      '    [FAIL] src/brands/artefacts/tabi/data/brands.json: rows is required: a list of row objects'
    ),
    lines.join('\n')
  );
  assert.deepEqual(
    tabi.rows.map(row => row.hotelId),
    ['A']
  );
});

test('rows are checked against the deployed table before anything is written', async t => {
  const write = useProject(t);
  write(
    HOTELS,
    doc([{ hotelId: 'A', name: 'A', colour: 'red' }, { hotelId: 'N' }])
  );
  const tabi = new FakeTabi();
  const { summary, lines } = await sync(tabi);
  assert.equal(summary.failed, 1);
  assert.ok(
    lines.includes(
      "    [FAIL] row A sets 'colour', which is not a column of the deployed table"
    )
  );
  write(HOTELS, doc([{ hotelId: 'A', name: 'A' }, { hotelId: 'N' }]));
  const missingName = await sync(tabi);
  assert.ok(
    missingName.lines.includes(
      "    [FAIL] new row N needs a value for required column 'name'; nothing was written to the table"
    )
  );
  assert.deepEqual(tabi.writes('insert'), []);
});

test('a failed write reports what was already written', async t => {
  const write = useProject(t);
  write(
    HOTELS,
    doc([
      { hotelId: 'N', name: 'New' },
      { hotelId: 'A', name: 'Renamed' },
    ])
  );
  const tabi = new FakeTabi([stored('r1', 'A')]);
  tabi.failOn = '/tables/{id}/update';
  const { summary, lines } = await sync(tabi);
  assert.deepEqual(
    [summary.created, summary.updated, summary.failed],
    [1, 0, 1]
  );
  assert.ok(
    lines.includes(
      '    [FAIL] Updating a row failed (HTTP 503): Tabi is down (after 1 inserted, 0 updated, 0 deleted)'
    )
  );
});

test('only the selected environment folder syncs; the others are reported', async t => {
  const write = useProject(t);
  write(HOTELS, doc([{ hotelId: 'A', name: 'Shared' }]));
  write(
    'src/hotels/artefacts/tabi/data/dev/hotels.json',
    doc([{ hotelId: 'A', name: 'Dev' }])
  );
  write(
    'src/hotels/artefacts/tabi/data/prod/hotels.json',
    doc([{ hotelId: 'P', name: 'Prod only' }])
  );
  const unset = await sync(new FakeTabi(), { dryRun: true });
  assert.ok(
    unset.lines.includes(
      "Skipping table data folder(s) dev, prod: set POLY_DEPLOY_TABLE_DATA_ENV to this environment's folder in its env file"
    )
  );
  assert.ok(unset.lines.includes('    Would insert: A'));

  const tabi = new FakeTabi();
  const dev = await sync(tabi, { environment: 'dev' });
  assert.ok(
    dev.lines.includes(
      'Environment folder: data/dev/ (POLY_DEPLOY_TABLE_DATA_ENV)'
    )
  );
  assert.ok(dev.lines.includes('Other environment folders, not synced: prod'));
  assert.deepEqual(
    tabi.rows.map(row => [row.hotelId, row.name]),
    [['A', 'Dev']]
  );
});

test('a data file changed last when it was committed, or when it was edited since', t => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'flow-table-data-git-'))
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...env,
        GIT_AUTHOR_NAME: 'Flow',
        GIT_AUTHOR_EMAIL: 'flow@example.test',
        GIT_COMMITTER_NAME: 'Flow',
        GIT_COMMITTER_EMAIL: 'flow@example.test',
        GIT_AUTHOR_DATE: '2020-01-02T03:04:05Z',
        GIT_COMMITTER_DATE: '2020-01-02T03:04:05Z',
      },
    });
  const write = (name: string, mtime: number) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, '{}');
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  };
  const later = Date.UTC(2024, 0, 1);
  git('init', '--quiet');
  const committed = write('committed.json', later);
  const edited = write('edited.json', later);
  git('add', '.');
  git('commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', 'rows');
  fs.writeFileSync(edited, '{"edited":true}');
  fs.utimesSync(edited, later / 1000, later / 1000);
  const untracked = write('untracked.json', later);

  assert.equal(getFileTimestamp(committed), Date.UTC(2020, 0, 2, 3, 4, 5));
  assert.equal(getFileTimestamp(edited), later);
  assert.equal(getFileTimestamp(untracked), later);
});
