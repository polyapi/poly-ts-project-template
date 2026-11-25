/**
 * Table data: rows of a Tabi table kept in Git and synced into the table by
 * key. The `table-data` type runs right after `tables` in push and
 * push-dynamic.
 *
 * A data file lists rows of one table, named by its `context` and `name`.
 * Files directly in a workflow's `artefacts/tabi/data/` sync to every
 * environment. Files in `artefacts/tabi/data/<environment>/` sync only where
 * the selected env file sets POLY_DEPLOY_TABLE_DATA_ENV=<environment>; their
 * rows overlay the shared row with the same key, column by column.
 *
 * Rows are content, so data files are plain JSON: no comments and no
 * {{ENV_NAME}} substitution. Messages name files, rows (by their key) and
 * columns, never other values.
 *
 * Two Tabi behaviours shape the writes (PolyAPI's table query converters):
 * - Equal values in one request share one query parameter, whatever their
 *   column, and PostgreSQL gives a parameter one type. A request in which one
 *   value meets columns of two types fails with 42P08, so writes are split
 *   where that would happen (see BoundParameters).
 * - A multi-row insert lists every column any of its rows sets, and binds the
 *   columns a row leaves out to NULL rather than to the column default. Each
 *   insert request therefore holds rows that set the same columns.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type createClient from 'openapi-fetch';
import type { components, paths } from '../sdk/schema';
import type { TableColumnDef, TableFile } from '../types';
import type { ArtifactSummary } from '../types/summary';
import {
  getRelativePath,
  getSrcPath,
  getTableDataSegments,
  pathMatchesIncludedPaths,
  walkDir,
} from '../utils/fileSystem';
import {
  chalk,
  createHeader,
  createLogger,
  warningColor,
} from '../utils/logger';
import { validateNamespace } from '../utils/namespace';
import { getExistingTables } from './tables';

type Client = ReturnType<typeof createClient<paths>>;
type Row = Record<string, unknown>;
type TableResponseDto = components['schemas']['TableResponseDto'];
type ApiResult = { data?: unknown; error?: unknown; response?: Response };

export type TableDataColumn = Pick<
  TableColumnDef,
  'name' | 'type' | 'required' | 'default'
>;
export type TableDataColumns = Map<string, TableDataColumn>;

/** Where the table data step reports; Flow's logger by default. */
export interface TableDataReporter {
  info(message: string): void;
  warn(message: string): void;
}

const log = createLogger('table-data');

/** Columns Tabi generates: a data file can neither set them nor key on them. */
export const POLY_MANAGED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'updatedAt',
]);
const DOCUMENT_KEYS = new Set([
  'context',
  'name',
  'description',
  'key',
  'rows',
]);
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ENVIRONMENT_NAME_RULE = "lowercase letters, digits, '_' or '-'";
/** Tabi returns at most 1000 rows per select. */
const SELECT_PAGE_SIZE = 1000;
const WRITE_BATCH_ROWS = 100;
/** PolyAPI refuses request bodies over 1 MiB; leave room for the envelope. */
const WRITE_BATCH_BYTES = 768 * 1024;
/** How many row keys a report names per kind of change. */
const REPORT_LIMIT = 10;

/** The PostgreSQL type Tabi gives each column type (PolyAPI's PG_TYPE_MAP). */
const STORAGE_TYPES: Readonly<Record<string, string>> = {
  string: 'text',
  text: 'text',
  varchar: 'text',
  char: 'char',
  uuid: 'uuid',
  number: 'numeric',
  numeric: 'numeric',
  decimal: 'numeric',
  float: 'double precision',
  double: 'double precision',
  float8: 'double precision',
  'double precision': 'double precision',
  int: 'integer',
  integer: 'integer',
  int4: 'integer',
  serial: 'integer',
  bigint: 'bigint',
  int8: 'bigint',
  bigserial: 'bigint',
  boolean: 'boolean',
  bool: 'boolean',
  date: 'date',
  time: 'time',
  timesec: 'time',
  timestamp: 'timestamptz',
  timestamptz: 'timestamptz',
  'timestamp with time zone': 'timestamptz',
  json: 'jsonb',
  jsonb: 'jsonb',
  object: 'jsonb',
};
const NUMERIC_STORAGE = new Set([
  'numeric',
  'double precision',
  'integer',
  'bigint',
]);
const INSTANT_STORAGE = new Set(['timestamptz', 'date']);

/** An invalid data file or row set. */
export class TableDataError extends Error {
  constructor(
    message: string,
    /** The data file the problem is in, when it is known. */
    readonly filePath?: string
  ) {
    super(message);
    this.name = 'TableDataError';
  }
}

export interface TableDataFile {
  filePath: string;
  /** '' for a file directly in data/, otherwise its environment folder. */
  environment: string;
  /** The parsed JSON; undefined when `error` is set. */
  data: unknown;
  /** Why the file cannot be used. */
  error?: string;
}

export interface TableDataDocument {
  context: string;
  name: string;
  key: string[];
  rows: Row[];
}

/** A row after the shared and environment files are merged, with its files. */
export interface MergedRow {
  row: Row;
  files: string[];
}

/** The rows one run syncs into one table. */
export interface TableDataSet {
  context: string;
  name: string;
  key: string[];
  rows: MergedRow[];
  files: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relative(filePath: string): string {
  return getRelativePath(filePath) || filePath;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Prefix a problem with the data file it is in. */
function inFile(filePath: string, error: unknown): TableDataError {
  return new TableDataError(
    `${relative(filePath)}: ${errorMessage(error)}`,
    filePath
  );
}

function tableIdentity(context: string, name: string): string {
  return `${context}\u0000${name}`;
}

export function tableLabel(context: string, name: string): string {
  return context ? `${name} (${context})` : name;
}

// ---------------------------------------------------------------------------
// Discovery and settings
// ---------------------------------------------------------------------------

/**
 * POLY_DEPLOY_TABLE_DATA_ENV: the `data/<environment>/` folder this run
 * syncs besides `data/`, or '' for none.
 */
export function getTableDataEnvironment(): string {
  const environment = process.env.POLY_DEPLOY_TABLE_DATA_ENV?.trim() ?? '';
  if (environment && !ENVIRONMENT_NAME.test(environment)) {
    throw new Error(
      `POLY_DEPLOY_TABLE_DATA_ENV must be ${ENVIRONMENT_NAME_RULE}, such as dev`
    );
  }
  return environment;
}

export function readTableDataFile(filePath: string): TableDataFile {
  const below = getTableDataSegments(filePath) ?? [path.basename(filePath)];
  const environment = below.length > 1 ? below[0] : '';
  const unusable = (error: string): TableDataFile => ({
    filePath,
    environment,
    data: undefined,
    error,
  });
  if (below.length > 2) {
    return unusable(
      'nested too deep: keep table data files in data/ or data/<environment>/'
    );
  }
  if (environment && !ENVIRONMENT_NAME.test(environment)) {
    return unusable(
      `folder '${environment}' is not an environment name: use ${ENVIRONMENT_NAME_RULE}`
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return unusable('could not be read');
  }
  try {
    return {
      filePath,
      environment,
      data: JSON.parse(text.replace(/^﻿/, '')),
    };
  } catch {
    return unusable('not valid JSON');
  }
}

/**
 * Every table data file of the project, in every environment folder. Path
 * filters do not narrow discovery: a run selects whole tables (see
 * collectTableDataSets).
 */
export function findTableDataFiles(): TableDataFile[] {
  const files: TableDataFile[] = [];
  walkDir(getSrcPath(), (fullPath, file) => {
    if (
      file.endsWith('.json') &&
      !file.endsWith('.test.json') &&
      getTableDataSegments(fullPath) !== null
    ) {
      files.push(readTableDataFile(fullPath));
    }
  });
  return files;
}

// ---------------------------------------------------------------------------
// Parsing and validation (pure)
// ---------------------------------------------------------------------------

export function parseTableDataKey(value: unknown): string[] {
  const key = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(key) ||
    key.length === 0 ||
    !key.every(column => typeof column === 'string' && column.trim()) ||
    new Set(key).size !== key.length
  ) {
    throw new TableDataError(
      'key is required: the column, or list of columns, that identifies a row, such as "hotelId"'
    );
  }
  const managed = key.filter(column => POLY_MANAGED_COLUMNS.has(column));
  if (managed.length > 0) {
    throw new TableDataError(
      `key cannot use ${managed.sort().join(', ')}: Tabi generates it, so it differs between environments`
    );
  }
  return key as string[];
}

function isKeyValue(value: unknown): boolean {
  return typeof value === 'string'
    ? value.trim() !== ''
    : typeof value === 'number' && Number.isFinite(value);
}

function rowIdentity(row: Row, key: string[]): string {
  return JSON.stringify(key.map(column => row[column]));
}

export function keyLabel(row: Row, key: string[]): string {
  return key.map(column => String(row[column])).join('/');
}

/** The table a data file fills, by its context and name. */
export function tableDataIdentity(data: unknown): {
  context: string;
  name: string;
} {
  if (!isPlainObject(data)) {
    throw new TableDataError(
      'must be a JSON object with context, name, key and rows'
    );
  }
  if (typeof data.name !== 'string' || !data.name.trim()) {
    throw new TableDataError("name is required: the table's name");
  }
  if (data.context !== undefined && typeof data.context !== 'string') {
    throw new TableDataError("context must be the table's context");
  }
  return { context: (data.context ?? '').trim(), name: data.name.trim() };
}

function hasDefault(column: TableDataColumn | undefined): boolean {
  return column?.default !== undefined && column.default !== null;
}

function isRequiredWithoutDefault(
  column: TableDataColumn | undefined
): boolean {
  return Boolean(column?.required) && !hasDefault(column);
}

/** Why a row does not fit the table's columns, or undefined when it does. */
function columnProblem(
  row: Row,
  columns: TableDataColumns,
  table: string
): string | undefined {
  for (const column of Object.keys(row).sort()) {
    const definition = columns.get(column);
    if (!definition) {
      return `sets '${column}', which is not a column of ${table}`;
    }
    if (row[column] === null && definition.required) {
      return `sets required column '${column}' to null`;
    }
  }
  return undefined;
}

/**
 * Check one data file, against the table's columns when they are known.
 */
export function parseTableDataDocument(
  data: unknown,
  columns: TableDataColumns | null = null
): TableDataDocument {
  const { context, name } = tableDataIdentity(data);
  const document = data as Record<string, unknown>;
  const unknownKey = Object.keys(document)
    .filter(key => !DOCUMENT_KEYS.has(key))
    .sort()[0];
  if (unknownKey !== undefined) {
    throw new TableDataError(
      `unknown key '${unknownKey}'; use context, name, description, key and rows`
    );
  }
  if (
    document.description !== undefined &&
    typeof document.description !== 'string'
  ) {
    throw new TableDataError('description must be text');
  }
  const key = parseTableDataKey(document.key);
  if (!Array.isArray(document.rows)) {
    throw new TableDataError('rows is required: a list of row objects');
  }
  const missingKeyColumn = columns
    ? key.find(column => !columns.has(column))
    : undefined;
  if (missingKeyColumn !== undefined) {
    throw new TableDataError(
      `key column '${missingKeyColumn}' is not a column of the table`
    );
  }
  const seen = new Map<string, number>();
  document.rows.forEach((row: unknown, index: number) => {
    const where = `row ${index + 1}`;
    if (!isPlainObject(row)) {
      throw new TableDataError(`${where} must be an object`);
    }
    const managed = Object.keys(row)
      .filter(column => POLY_MANAGED_COLUMNS.has(column))
      .sort()[0];
    if (managed !== undefined) {
      throw new TableDataError(
        `${where} sets '${managed}', which Tabi generates; remove it`
      );
    }
    for (const column of key) {
      if (!isKeyValue(row[column])) {
        throw new TableDataError(
          `${where} needs a text or number value for key column '${column}'`
        );
      }
    }
    const identity = rowIdentity(row, key);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      throw new TableDataError(
        `${where} repeats the key of row ${previous}; each row needs its own key`
      );
    }
    seen.set(identity, index + 1);
    const problem = columns && columnProblem(row, columns, 'the table');
    if (problem) {
      throw new TableDataError(`${where} ${problem}`);
    }
  });
  return { context, name, key, rows: document.rows as Row[] };
}

/**
 * Merge the files of ONE table for ONE environment: shared rows first, then
 * the environment's rows overlay the shared row with the same key, column by
 * column. A key listed twice at one level (two shared files, or two files of
 * the environment) is an error rather than a silent overlay.
 */
export function mergeTableDataFiles(files: TableDataFile[]): TableDataSet {
  const ordered = [...files].sort(
    (left, right) =>
      Number(left.environment !== '') - Number(right.environment !== '') ||
      compareText(left.filePath, right.filePath)
  );
  let identity: { context: string; name: string } | undefined;
  let key: string[] | undefined;
  const merged = new Map<string, MergedRow>();
  const levels = [new Map<string, string>(), new Map<string, string>()];
  for (const file of ordered) {
    let document: TableDataDocument;
    try {
      if (file.error) {
        throw new TableDataError(file.error);
      }
      document = parseTableDataDocument(file.data);
    } catch (error) {
      throw inFile(file.filePath, error);
    }
    identity ??= { context: document.context, name: document.name };
    if (key && JSON.stringify(key) !== JSON.stringify(document.key)) {
      throw inFile(
        file.filePath,
        'every data file of a table must use the same key'
      );
    }
    key ??= document.key;
    const level = levels[file.environment === '' ? 0 : 1];
    for (const row of document.rows) {
      const id = rowIdentity(row, key);
      const other = level.get(id);
      if (other !== undefined) {
        throw inFile(
          file.filePath,
          `row ${keyLabel(row, key)} is also in ${relative(other)}; keep each row in one file`
        );
      }
      level.set(id, file.filePath);
      const existing = merged.get(id);
      merged.set(
        id,
        existing
          ? {
              row: { ...existing.row, ...row },
              files: [...existing.files, file.filePath],
            }
          : { row: { ...row }, files: [file.filePath] }
      );
    }
  }
  if (!identity || !key) {
    throw new TableDataError('no data file was given');
  }
  return {
    ...identity,
    key,
    rows: [...merged.values()],
    files: ordered.map(file => file.filePath),
  };
}

/**
 * The data files of each table one run syncs: the shared files plus the
 * selected environment's folder. A table is selected when one of those files
 * is under the path filters (every table without filters); all of its files
 * are then used, so a scoped run never mistakes the rows of another file for
 * extra rows. A file whose table cannot be read stops the run's table data:
 * its rows could belong to any table.
 */
export function selectTableDataFiles(
  files: TableDataFile[],
  options: { environment: string; pathFilters: string[] }
): TableDataFile[][] {
  const groups = new Map<string, TableDataFile[]>();
  for (const file of files) {
    if (file.environment !== '' && file.environment !== options.environment) {
      continue;
    }
    let identity: { context: string; name: string };
    try {
      if (file.error) {
        throw new TableDataError(file.error);
      }
      identity = tableDataIdentity(file.data);
    } catch (error) {
      throw inFile(file.filePath, error);
    }
    const id = tableIdentity(identity.context, identity.name);
    groups.set(id, [...(groups.get(id) ?? []), file]);
  }
  return [...groups.values()].filter(
    group =>
      options.pathFilters.length === 0 ||
      group.some(file =>
        pathMatchesIncludedPaths(file.filePath, options.pathFilters)
      )
  );
}

/** The tables one run syncs, merged (see selectTableDataFiles). */
export function collectTableDataSets(
  files: TableDataFile[],
  options: { environment: string; pathFilters: string[] }
): TableDataSet[] {
  return selectTableDataFiles(files, options).map(mergeTableDataFiles);
}

function columnsOf(columns: unknown): TableDataColumns {
  const result: TableDataColumns = new Map();
  if (Array.isArray(columns)) {
    for (const column of columns) {
      if (isPlainObject(column) && typeof column.name === 'string') {
        result.set(column.name, column as unknown as TableDataColumn);
      }
    }
  }
  return result;
}

export interface TableDataValidation {
  /** Data files checked: every file of a selected table, and unusable ones. */
  fileCount: number;
  /** One line per problem, naming its file. */
  problems: string[];
  /**
   * The files with a problem. The sync step skips a table when it would read
   * one of them, so a broken prod file does not stop dev's rows.
   */
  invalidFiles: Set<string>;
}

/**
 * Validate data files offline, before anything is written: every file of the
 * selected tables in every environment folder (so a broken prod file fails a
 * dev run), against the table's local definition when there is one, and then
 * each environment's files of a table together (one key, no row twice at one
 * level). Files that cannot be read are always reported: their table is
 * unknown.
 */
export function validateTableDataFiles(
  files: TableDataFile[],
  tableDefinitions: TableFile[],
  pathFilters: string[] = []
): TableDataValidation {
  const definitions = new Map<string, TableDataColumns>();
  for (const table of tableDefinitions) {
    if (typeof table.content?.name === 'string') {
      definitions.set(
        tableIdentity(table.content.context ?? '', table.content.name),
        columnsOf(table.content.columns)
      );
    }
  }
  const problems = new Set<string>();
  const invalidFiles = new Set<string>();
  const attributed: Array<{ file: TableDataFile; identity: string }> = [];
  for (const file of files) {
    try {
      if (file.error) {
        throw new TableDataError(file.error);
      }
      const { context, name } = tableDataIdentity(file.data);
      attributed.push({ file, identity: tableIdentity(context, name) });
    } catch (error) {
      problems.add(inFile(file.filePath, error).message);
      invalidFiles.add(file.filePath);
    }
  }
  const selected = new Set(
    attributed
      .filter(
        ({ file }) =>
          pathFilters.length === 0 ||
          pathMatchesIncludedPaths(file.filePath, pathFilters)
      )
      .map(({ identity }) => identity)
  );
  const checked = attributed.filter(({ identity }) => selected.has(identity));
  const readable = new Map<string, TableDataFile[]>();
  for (const { file, identity } of checked) {
    try {
      parseTableDataDocument(file.data, definitions.get(identity) ?? null);
      readable.set(identity, [...(readable.get(identity) ?? []), file]);
    } catch (error) {
      problems.add(inFile(file.filePath, error).message);
      invalidFiles.add(file.filePath);
    }
  }
  for (const tableFiles of readable.values()) {
    const shared = tableFiles.filter(file => file.environment === '');
    const environments = [
      ...new Set(tableFiles.map(file => file.environment).filter(Boolean)),
    ].sort();
    const combinations =
      environments.length > 0
        ? environments.map(environment => [
            ...shared,
            ...tableFiles.filter(file => file.environment === environment),
          ])
        : [shared];
    for (const combination of combinations) {
      try {
        mergeTableDataFiles(combination);
      } catch (error) {
        problems.add(errorMessage(error));
        if (error instanceof TableDataError && error.filePath) {
          invalidFiles.add(error.filePath);
        }
      }
    }
  }
  return {
    fileCount: checked.length + (files.length - attributed.length),
    problems: [...problems],
    invalidFiles,
  };
}

// ---------------------------------------------------------------------------
// Comparison (pure)
// ---------------------------------------------------------------------------

/** The PostgreSQL type Tabi stores a column type as. */
export function storageType(type: unknown): string {
  const kind = String(type ?? '')
    .trim()
    .toLowerCase();
  return STORAGE_TYPES[kind] ?? kind;
}

/** JSON with sorted object keys: ignores key order, keeps true and 1 apart. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    isPlainObject(nested)
      ? Object.fromEntries(
          Object.keys(nested)
            .sort()
            .map(key => [key, nested[key]])
        )
      : nested
  );
}

/** An ISO timestamp or date as epoch ms; without an offset it is UTC. */
export function toInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    return null;
  }
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    text = `${text}T00:00:00Z`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) {
    text = `${text.replace(' ', 'T')}Z`;
  }
  const instant = Date.parse(text);
  return Number.isNaN(instant) ? null : instant;
}

function toNumber(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

/** Compare a file value with the stored one as the column's type stores it. */
export function tableValuesEqual(
  type: unknown,
  local: unknown,
  remote: unknown
): boolean {
  if (
    local === null ||
    local === undefined ||
    remote === null ||
    remote === undefined
  ) {
    return (local ?? null) === (remote ?? null);
  }
  const storage = storageType(type);
  if (NUMERIC_STORAGE.has(storage) && typeof local !== 'boolean') {
    const left = toNumber(local);
    const right = toNumber(remote);
    if (left !== null && right !== null) {
      return left === right;
    }
  }
  if (INSTANT_STORAGE.has(storage)) {
    const left = toInstant(local);
    const right = toInstant(remote);
    if (left !== null && right !== null) {
      return left === right;
    }
  }
  if (
    storage === 'uuid' &&
    typeof local === 'string' &&
    typeof remote === 'string'
  ) {
    return local.toLowerCase() === remote.toLowerCase();
  }
  let stored = remote;
  if (
    storage === 'jsonb' &&
    typeof remote === 'string' &&
    typeof local !== 'string'
  ) {
    try {
      stored = JSON.parse(remote);
    } catch {
      return false;
    }
  }
  return canonicalJson(local) === canonicalJson(stored);
}

/** A comparable row key: numbers by value, UUIDs in lower case, text as written. */
export function comparableRowKey(
  row: Row,
  key: string[],
  columns: TableDataColumns
): string {
  return JSON.stringify(
    key.map(column => {
      const value = row[column];
      const storage = storageType(columns.get(column)?.type);
      const number = NUMERIC_STORAGE.has(storage) ? toNumber(value) : null;
      if (number !== null) {
        return String(number);
      }
      if (storage === 'uuid' && typeof value === 'string') {
        return value.toLowerCase();
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    })
  );
}

function namedKeys(labels: string[]): string {
  const shown = labels.slice(0, REPORT_LIMIT).join(', ');
  const more = labels.length - REPORT_LIMIT;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * Required columns without a default that a row to insert leaves empty. Only
 * inserts need them: an update writes just the columns a row lists.
 */
export function missingRequiredColumns(
  row: Row,
  columns: TableDataColumns
): string[] {
  return [...columns.values()]
    .filter(
      column =>
        isRequiredWithoutDefault(column) &&
        !POLY_MANAGED_COLUMNS.has(column.name) &&
        (row[column.name] === undefined || row[column.name] === null)
    )
    .map(column => column.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/**
 * The values one Tabi request binds. Tabi binds equal values to one query
 * parameter whatever their column, and PostgreSQL gives each parameter one
 * type, so a value may meet columns of only one storage type per request;
 * otherwise the request fails with 42P08 ("inconsistent types deduced for
 * parameter"). JSON columns are bound as their JSON text.
 */
class BoundParameters {
  private readonly bound = new Map<
    unknown,
    { storage: string; column: string }
  >();

  constructor(private readonly columns: TableDataColumns) {}

  /**
   * Bind a value unless it already meets a column of another type. Returns
   * that column on a clash, otherwise undefined.
   */
  bind(
    column: string,
    value: unknown,
    storage: string = storageType(this.columns.get(column)?.type)
  ): string | undefined {
    const parameter = storage === 'jsonb' ? JSON.stringify(value) : value;
    const existing = this.bound.get(parameter);
    if (existing) {
      return existing.storage === storage ? undefined : existing.column;
    }
    this.bound.set(parameter, { storage, column });
    return undefined;
  }

  /** Bind every value of a row, or none of them when one would clash. */
  bindRow(row: Row): boolean {
    const trial = new BoundParameters(this.columns);
    for (const [parameter, binding] of this.bound) {
      trial.bound.set(parameter, binding);
    }
    for (const [column, value] of Object.entries(row)) {
      if (trial.bind(column, value) !== undefined) {
        return false;
      }
    }
    for (const [parameter, binding] of trial.bound) {
      this.bound.set(parameter, binding);
    }
    return true;
  }
}

export interface InsertRequest {
  /** The rows of one insert request; they all set the same columns. */
  rows: Row[];
  /**
   * Columns written right after the insert, one update request each. Only a
   * single-row request has them: its row binds one value to columns of two
   * types.
   */
  followUps: Row[];
}

/**
 * Update requests that write `data` to one row, in order: one request unless
 * a value meets columns of two types. `id` is the row the requests select,
 * which binds a parameter too.
 */
export function planUpdateRequests(
  data: Row,
  columns: TableDataColumns,
  id?: string
): Row[] {
  const requests: Array<{ data: Row; parameters: BoundParameters }> = [];
  for (const [column, value] of Object.entries(data)) {
    let request = requests.find(
      candidate => candidate.parameters.bind(column, value) === undefined
    );
    if (!request) {
      const parameters = new BoundParameters(columns);
      if (id !== undefined) {
        parameters.bind('id', id, 'uuid');
      }
      parameters.bind(column, value);
      request = { data: {}, parameters };
      requests.push(request);
    }
    request.data[column] = value;
  }
  return requests.map(request => request.data);
}

/**
 * A new row as Flow inserts it. A null is left out where the column has no
 * default: that stores the same NULL without binding a parameter.
 */
function insertData(row: Row, columns: TableDataColumns): Row {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([column, value]) => value !== null || hasDefault(columns.get(column))
    )
  );
}

/**
 * Insert a row that binds one value to columns of two types: the insert
 * takes the required columns, the key and every column that fits; the rest
 * follow in updates of the new row.
 */
function splitInsert(
  row: Row,
  data: Row,
  key: string[],
  columns: TableDataColumns
): InsertRequest {
  const rank = (column: string): number =>
    isRequiredWithoutDefault(columns.get(column))
      ? 0
      : key.includes(column)
        ? 1
        : 2;
  const parameters = new BoundParameters(columns);
  const inserted: Row = {};
  const rest: Row = {};
  for (const column of Object.keys(data).sort(
    (left, right) => rank(left) - rank(right)
  )) {
    const clash = parameters.bind(column, data[column]);
    if (clash === undefined) {
      inserted[column] = data[column];
    } else if (rank(column) === 0) {
      throw new TableDataError(
        `new row ${keyLabel(row, key)} cannot be inserted: required columns '${clash}' and '${column}' have different types but the same value, which Tabi sends as one query parameter; nothing was written to the table`
      );
    } else {
      rest[column] = data[column];
    }
  }
  return { rows: [inserted], followUps: planUpdateRequests(rest, columns) };
}

/**
 * Group new rows into insert requests: rows that set the same columns, at
 * most WRITE_BATCH_ROWS rows and WRITE_BATCH_BYTES of JSON, and no value
 * bound to columns of two types. A single row over the byte limit gets its
 * own request and is left for PolyAPI to refuse.
 */
export function planInsertRequests(
  rows: Row[],
  key: string[],
  columns: TableDataColumns
): InsertRequest[] {
  const requests: InsertRequest[] = [];
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const data = insertData(row, columns);
    if (!new BoundParameters(columns).bindRow(data)) {
      requests.push(splitInsert(row, data, key, columns));
      continue;
    }
    const columnSet = JSON.stringify(Object.keys(data).sort());
    groups.set(columnSet, [...(groups.get(columnSet) ?? []), data]);
  }
  for (const group of groups.values()) {
    let batch: Row[] = [];
    let bytes = 0;
    let parameters = new BoundParameters(columns);
    for (const data of group) {
      const size = Buffer.byteLength(JSON.stringify(data), 'utf8') + 1;
      const fits =
        batch.length > 0 &&
        batch.length < WRITE_BATCH_ROWS &&
        bytes + size <= WRITE_BATCH_BYTES &&
        parameters.bindRow(data);
      if (!fits) {
        if (batch.length > 0) {
          requests.push({ rows: batch, followUps: [] });
        }
        batch = [];
        bytes = 0;
        parameters = new BoundParameters(columns);
        parameters.bindRow(data);
      }
      batch.push(data);
      bytes += size;
    }
    if (batch.length > 0) {
      requests.push({ rows: batch, followUps: [] });
    }
  }
  return requests;
}

export interface TableDataUpdate {
  row: Row;
  remote: Row;
  /** The listed columns whose values differ. */
  changed: string[];
  /** The update requests, in order; usually one. */
  requests: Row[];
}

export interface TableDataPlan {
  /** New rows, as their files list them. */
  inserts: Row[];
  insertRequests: InsertRequest[];
  updates: TableDataUpdate[];
  /** "<key> (<reason>)" for rows changed in the table after their files. */
  blocked: string[];
  unchanged: number;
  /** Table rows that no data file lists. */
  extras: Row[];
}

function formatInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Decide what to write: insert the rows the table lacks, update the listed
 * columns that differ (stamping updatedAt, which tables created before
 * PolyAPI R24 do not stamp themselves), and block an update when the table
 * row changed (updatedAt) at or after its newest file unless forced. Extras
 * are the table rows no file lists. Throws, before anything is written, for
 * a key the table or the files hold twice and for a new row that cannot be
 * inserted.
 */
export function planTableDataSet(args: {
  set: TableDataSet;
  columns: TableDataColumns;
  remoteRows: Row[];
  force: boolean;
  /** When a data file last changed, in epoch ms. */
  fileTimestamp: (filePath: string) => number;
  /** The time an update stamps into updatedAt. */
  now: Date;
}): TableDataPlan {
  const { set, columns, remoteRows, force, fileTimestamp, now } = args;
  const remoteIndex = new Map<string, Row>();
  for (const row of remoteRows) {
    const identity = comparableRowKey(row, set.key, columns);
    if (remoteIndex.has(identity)) {
      throw new TableDataError(
        `several table rows have key ${keyLabel(row, set.key)}; remove the duplicates first`
      );
    }
    remoteIndex.set(identity, row);
  }
  const plan: TableDataPlan = {
    inserts: [],
    insertRequests: [],
    updates: [],
    blocked: [],
    unchanged: 0,
    extras: [],
  };
  const listed = new Set<string>();
  for (const { row, files } of set.rows) {
    const identity = comparableRowKey(row, set.key, columns);
    if (listed.has(identity)) {
      throw new TableDataError(
        `row ${keyLabel(row, set.key)} is listed twice: its key values match as the table stores them`
      );
    }
    listed.add(identity);
    const remote = remoteIndex.get(identity);
    if (!remote) {
      const missing = missingRequiredColumns(row, columns);
      if (missing.length > 0) {
        throw new TableDataError(
          `new row ${keyLabel(row, set.key)} needs a value for required column '${missing[0]}'; nothing was written to the table`
        );
      }
      plan.inserts.push(row);
      continue;
    }
    const changed = Object.keys(row).filter(
      column =>
        !set.key.includes(column) &&
        !tableValuesEqual(
          columns.get(column)?.type,
          row[column],
          remote[column]
        )
    );
    if (changed.length === 0) {
      plan.unchanged += 1;
      continue;
    }
    const remoteChanged = toInstant(remote.updatedAt);
    const fileChanged = Math.max(...files.map(fileTimestamp));
    if (!force && remoteChanged !== null && remoteChanged >= fileChanged) {
      plan.blocked.push(
        `${keyLabel(row, set.key)} (changed in the table at ${formatInstant(
          remoteChanged
        )}; its file last changed at ${formatInstant(fileChanged)})`
      );
      continue;
    }
    const data: Row = Object.fromEntries(
      changed.map(column => [column, row[column]])
    );
    data.updatedAt = now.toISOString();
    plan.updates.push({
      row,
      remote,
      changed,
      requests: planUpdateRequests(data, columns, String(remote.id)),
    });
  }
  plan.insertRequests = planInsertRequests(plan.inserts, set.key, columns);
  plan.extras = [...remoteIndex.entries()]
    .filter(([identity]) => !listed.has(identity))
    .map(([, row]) => row);
  return plan;
}

// ---------------------------------------------------------------------------
// File timestamps
// ---------------------------------------------------------------------------

const timestampCache = new Map<string, number>();

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * When a data file last changed: its last commit time when it is committed
 * and unmodified, otherwise (local edits, untracked, no Git) its mtime.
 * Checkouts rewrite mtimes, so the commit time is what tells an old file
 * from a new one, in CI as well.
 */
export function getFileTimestamp(filePath: string): number {
  const cached = timestampCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  let timestamp = fs.statSync(filePath).mtimeMs;
  try {
    const cwd = path.dirname(filePath);
    const file = path.basename(filePath);
    if (!git(['status', '--porcelain', '--', file], cwd)) {
      const committed = git(['log', '-1', '--format=%ct', '--', file], cwd);
      if (/^\d+$/.test(committed)) {
        timestamp = Number(committed) * 1000;
      }
    }
  } catch {
    // Not a Git checkout: the mtime stands.
  }
  timestampCache.set(filePath, timestamp);
  return timestamp;
}

// ---------------------------------------------------------------------------
// Sync (imperative shell)
// ---------------------------------------------------------------------------

function apiErrorDetail(error: unknown): string {
  const message = isPlainObject(error) ? error.message : error;
  const text = Array.isArray(message)
    ? message.join('; ')
    : typeof message === 'string'
      ? message
      : '';
  return text ? `: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}` : '';
}

async function send(call: Promise<ApiResult>, what: string): Promise<unknown> {
  const { data, error, response } = await call;
  if (error !== undefined) {
    throw new Error(
      `${what} failed (HTTP ${response?.status ?? 'unknown'})${apiErrorDetail(error)}`
    );
  }
  return data;
}

async function fetchTableColumns(
  client: Client,
  tableId: string
): Promise<TableDataColumns> {
  const data = await send(
    client.GET('/tables/{id}', { params: { path: { id: tableId } } }),
    'Reading the table definition'
  );
  return columnsOf((data as TableResponseDto | undefined)?.columns);
}

async function fetchTableRows(client: Client, tableId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += SELECT_PAGE_SIZE) {
    const data = await send(
      client.POST('/tables/{id}/select', {
        params: { path: { id: tableId } },
        body: {
          orderBy: { id: 'asc' },
          limit: SELECT_PAGE_SIZE,
          offset,
        } as unknown as components['schemas']['TableSelectQueryDto'],
      }),
      'Reading the table rows'
    );
    const page = (data as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(page)) {
      throw new Error('Reading the table rows failed: no row list returned');
    }
    rows.push(...page.filter(isPlainObject));
    if (page.length < SELECT_PAGE_SIZE) {
      return rows;
    }
  }
}

/** Rows written so far, so a failure reports what already changed. */
interface WriteProgress {
  inserted: number;
  updated: number;
  deleted: number;
}

async function applyTableDataPlan(
  client: Client,
  tableId: string,
  plan: TableDataPlan,
  prune: boolean,
  progress: WriteProgress
): Promise<void> {
  const params = { path: { id: tableId } };
  const update = (id: string, data: Row) =>
    send(
      client.POST('/tables/{id}/update', {
        params,
        body: {
          where: { id: { equals: id } },
          data,
        } as unknown as components['schemas']['TableUpdateQueryDto'],
      }),
      'Updating a row'
    );
  for (const request of plan.insertRequests) {
    const inserted = await send(
      client.POST('/tables/{id}/insert', {
        params,
        body: {
          data: request.rows,
        } as unknown as components['schemas']['TableInsertQueryDto'],
      }),
      `Inserting ${request.rows.length} row(s)`
    );
    if (request.followUps.length > 0) {
      const results = (inserted as { results?: unknown } | undefined)?.results;
      const first = Array.isArray(results) ? results[0] : undefined;
      if (!isPlainObject(first) || typeof first.id !== 'string') {
        throw new Error(
          'Inserting a row failed: Tabi did not return the new row'
        );
      }
      for (const data of request.followUps) {
        await update(first.id, data);
      }
    }
    progress.inserted += request.rows.length;
  }
  for (const { remote, requests } of plan.updates) {
    for (const data of requests) {
      await update(String(remote.id), data);
    }
    progress.updated += 1;
  }
  if (prune) {
    const ids = plan.extras
      .map(row => row.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
    for (let start = 0; start < ids.length; start += WRITE_BATCH_ROWS) {
      const batch = ids.slice(start, start + WRITE_BATCH_ROWS);
      await send(
        client.POST('/tables/{id}/delete', {
          params,
          body: {
            where: { id: { in: batch } },
          } as unknown as components['schemas']['TableDeleteQueryDto'],
        }),
        `Deleting ${batch.length} row(s)`
      );
      progress.deleted += batch.length;
    }
  }
}

export interface SyncTableDataOptions {
  dryRun?: boolean;
  /** Overwrite rows changed in their table after their data file. */
  force?: boolean;
  /** Delete table rows that no data file lists (--prune-table-data). */
  prune?: boolean;
  pathFilters?: string[];
  /** The environment folder this run syncs (POLY_DEPLOY_TABLE_DATA_ENV). */
  environment?: string;
  /** The data files to sync; read from the project when omitted. */
  files?: TableDataFile[];
  /**
   * Files that failed local validation (--skip-invalid); a table that would
   * read one is skipped.
   */
  invalidFiles?: ReadonlySet<string>;
  /** When a data file last changed; its last commit time by default. */
  fileTimestamp?: (filePath: string) => number;
  /** The time updates stamp into updatedAt; the current time by default. */
  now?: () => Date;
  reporter?: TableDataReporter;
}

/**
 * Insert and update table rows from data files; delete rows no file lists
 * only with --prune-table-data. Each table is planned in full before anything
 * is written to it, and a failing table does not stop the others.
 */
export async function syncTableData(
  client: Client,
  summary: ArtifactSummary,
  options: SyncTableDataOptions = {}
): Promise<void> {
  const report = options.reporter ?? log;
  report.info(chalk.cyan(createHeader('TABLE DATA')));
  const environment = options.environment ?? '';
  const files = options.files ?? findTableDataFiles();
  const otherFolders = [
    ...new Set(
      files
        .map(file => file.environment)
        .filter(folder => folder && folder !== environment)
    ),
  ].sort();
  if (environment) {
    report.info(
      chalk.gray(
        `Environment folder: data/${environment}/ (POLY_DEPLOY_TABLE_DATA_ENV)`
      )
    );
  }
  if (otherFolders.length > 0) {
    report.info(
      environment
        ? chalk.gray(
            `Other environment folders, not synced: ${otherFolders.join(', ')}`
          )
        : warningColor(
            `Skipping table data folder(s) ${otherFolders.join(', ')}: set POLY_DEPLOY_TABLE_DATA_ENV to this environment's folder in its env file`
          )
    );
  }

  let groups: TableDataFile[][];
  try {
    groups = selectTableDataFiles(files, {
      environment,
      pathFilters: options.pathFilters ?? [],
    });
  } catch (error) {
    report.info(chalk.red(`[FAIL] ${errorMessage(error)}`));
    summary.failed += 1;
    return;
  }
  if (groups.length === 0) {
    report.info(
      chalk.gray(
        files.length === 0
          ? 'No table data files found in src/**/artefacts/tabi/data/'
          : 'No table data files in scope'
      )
    );
    return;
  }

  const tables = new Map(
    (await getExistingTables(client)).map(table => [
      tableIdentity(table.context ?? '', table.name),
      table,
    ])
  );
  for (const group of groups) {
    const { context, name } = tableDataIdentity(group[0].data);
    report.info(chalk.dim(`  → ${tableLabel(context, name)}`));
    const progress: WriteProgress = { inserted: 0, updated: 0, deleted: 0 };
    try {
      if (group.some(file => options.invalidFiles?.has(file.filePath))) {
        throw new TableDataError(
          'skipped: its data files failed local validation'
        );
      }
      const set = mergeTableDataFiles(group);
      report.info(
        chalk.gray(
          `    ${set.rows.length} row(s) from ${set.files.length} file(s), keyed by ${set.key.join(' + ')}`
        )
      );
      validateNamespace(context, 'Table data', name);
      await syncTableDataSet(
        client,
        summary,
        set,
        tables.get(tableIdentity(context, name)),
        options,
        report,
        progress
      );
    } catch (error) {
      const written = progress.inserted + progress.updated + progress.deleted;
      report.info(
        chalk.red(
          `    [FAIL] ${errorMessage(error)}${
            written > 0
              ? ` (after ${progress.inserted} inserted, ${progress.updated} updated, ${progress.deleted} deleted)`
              : ''
          }`
        )
      );
      summary.failed += 1;
    }
    summary.created += progress.inserted;
    summary.updated += progress.updated;
    summary.deleted += progress.deleted;
  }
}

/** Check merged rows against the deployed table's columns. */
function checkRowsAgainstColumns(
  set: TableDataSet,
  columns: TableDataColumns
): void {
  const missingKeyColumn = set.key.find(column => !columns.has(column));
  if (missingKeyColumn !== undefined) {
    throw new TableDataError(
      `key column '${missingKeyColumn}' is not a column of the deployed table`
    );
  }
  for (const { row } of set.rows) {
    const problem = columnProblem(row, columns, 'the deployed table');
    if (problem) {
      throw new TableDataError(`row ${keyLabel(row, set.key)} ${problem}`);
    }
  }
}

function reportPlan(
  plan: TableDataPlan,
  set: TableDataSet,
  options: SyncTableDataOptions,
  report: TableDataReporter
): void {
  const action = (verb: string): string =>
    options.dryRun
      ? `Would ${verb}`
      : `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`;
  const label = (row: Row) => keyLabel(row, set.key);
  if (plan.inserts.length > 0) {
    report.info(
      chalk.gray(
        `    ${action('insert')}: ${namedKeys(plan.inserts.map(label))}`
      )
    );
  }
  for (const { row, changed } of plan.updates.slice(0, REPORT_LIMIT)) {
    report.info(
      chalk.gray(`    ${action('update')} ${label(row)}: ${changed.join(', ')}`)
    );
  }
  if (plan.updates.length > REPORT_LIMIT) {
    report.info(
      chalk.gray(
        `    ${action('update')} ${plan.updates.length - REPORT_LIMIT} more`
      )
    );
  }
  const split =
    plan.insertRequests.filter(request => request.followUps.length > 0).length +
    plan.updates.filter(({ requests }) => requests.length > 1).length;
  if (split > 0) {
    report.info(
      chalk.gray(
        `    ${split} row(s) take several requests: one value in columns of different types cannot share a Tabi request`
      )
    );
  }
  for (const line of plan.blocked.slice(0, REPORT_LIMIT)) {
    report.info(
      warningColor(`    [BLOCKED] Not updated: ${line}; --force overwrites it`)
    );
  }
  if (plan.blocked.length > REPORT_LIMIT) {
    report.info(
      warningColor(`    [BLOCKED] ${plan.blocked.length - REPORT_LIMIT} more`)
    );
  }
  if (plan.extras.length > 0) {
    const labels = namedKeys(plan.extras.map(label));
    report.info(
      options.prune
        ? warningColor(`    ${action('delete')} rows no file lists: ${labels}`)
        : chalk.gray(
            `    Rows no file lists, kept: ${labels} (--prune-table-data deletes them)`
          )
    );
  }
}

async function syncTableDataSet(
  client: Client,
  summary: ArtifactSummary,
  set: TableDataSet,
  table: TableResponseDto | undefined,
  options: SyncTableDataOptions,
  report: TableDataReporter,
  progress: WriteProgress
): Promise<void> {
  if (!table) {
    if (options.dryRun) {
      report.info(
        chalk.blue(
          `    [PLAN] Insert ${set.rows.length} row(s) once the table exists`
        )
      );
      summary.planned += set.rows.length;
      return;
    }
    throw new TableDataError(
      'table not found; deploy its definition first (--types tables)'
    );
  }

  const columns = await fetchTableColumns(client, table.id);
  checkRowsAgainstColumns(set, columns);
  const plan = planTableDataSet({
    set,
    columns,
    remoteRows: await fetchTableRows(client, table.id),
    force: Boolean(options.force),
    fileTimestamp: options.fileTimestamp ?? getFileTimestamp,
    now: options.now?.() ?? new Date(),
  });
  reportPlan(plan, set, options, report);
  summary.skipped += plan.unchanged;
  summary.blocked += plan.blocked.length;

  const deleted = options.prune ? plan.extras.length : 0;
  const outcome = `${plan.inserts.length} inserted, ${plan.updates.length} updated, ${deleted} deleted, ${plan.unchanged} unchanged${
    plan.blocked.length > 0 ? `, ${plan.blocked.length} blocked` : ''
  }`;
  if (options.dryRun) {
    summary.planned += plan.inserts.length + plan.updates.length + deleted;
    report.info(chalk.blue(`    [PLAN] ${outcome}`));
    return;
  }
  await applyTableDataPlan(
    client,
    table.id,
    plan,
    Boolean(options.prune),
    progress
  );
  report.info(
    plan.blocked.length > 0
      ? warningColor(`    [WARN] ${outcome}`)
      : chalk.green(`    [OK] ${outcome}`)
  );
}
