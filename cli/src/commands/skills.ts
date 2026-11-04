/**
 * `flow skills add|update`: install and refresh PolyAPI agent skills from the
 * poly-skills repository into `.agents/skills/`.
 *
 * A setup (what the skills are needed for) selects whole poly-skills packs, so
 * a skill added to one of those packs upstream is installed by the next update.
 * The selected setups, the fetched revision and a content digest per installed
 * skill are recorded in `.agents/flow-skills.json`. The digests separate
 * unmodified Flow-installed folders, which are refreshed, from local edits and
 * folders Flow did not install, which are replaced only after confirmation.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

/** poly-skills is public: its archive downloads over HTTPS without Git or SSH. */
export const SKILLS_SOURCE = 'https://github.com/polyapi/poly-skills';
export const SKILLS_REF = 'main';
export const SKILLS_DIRECTORY = '.agents/skills';
export const SKILLS_LOCK_FILE = '.agents/flow-skills.json';
const LOCK_VERSION = 1;

export interface SkillSetup {
  id: string;
  label: string;
  /** poly-skills packs whose `skills/` folders make up this setup. */
  packs: string[];
}

export const SKILL_SETUPS: readonly SkillSetup[] = [
  {
    id: 'typescript',
    label: 'Coding in TypeScript',
    packs: ['general', 'polyapi-common', 'polyapi-typescript'],
  },
  {
    id: 'python',
    label: 'Coding in Python',
    packs: ['general', 'polyapi-common', 'polyapi-python'],
  },
];

/** The default answer to the setup prompt in this TypeScript template. */
export const RECOMMENDED_SETUP = 'typescript';

export interface SkillsArgs {
  command: 'add' | 'update' | 'help';
  setups: string[];
  dryRun: boolean;
  yes: boolean;
  source: string;
  ref: string;
}

export interface SkillFile {
  /** POSIX path relative to the skill folder. */
  path: string;
  content: Buffer;
  executable: boolean;
}

export interface UpstreamSkill {
  name: string;
  /** Folder in poly-skills, for example `polyapi-typescript/skills/polyapi-sdk`. */
  source: string;
  files: SkillFile[];
  digest: string;
}

export interface SkillsSnapshot {
  commit: string;
  skills: UpstreamSkill[];
}

export interface SkillsLockEntry {
  source: string;
  digest: string;
}

export interface SkillsLock {
  version: number;
  setups: string[];
  /**
   * Recorded for remote sources other than the default only; local checkouts
   * and archives are not portable.
   */
  source?: string;
  ref: string;
  commit: string;
  skills: Record<string, SkillsLockEntry>;
}

export interface SkillsRuntime {
  projectRoot: string;
  interactive: boolean;
  prompt(message: string): Promise<string>;
  print(message: string): void;
  fetch(
    source: string,
    ref: string,
    packs: string[]
  ): SkillsSnapshot | Promise<SkillsSnapshot>;
}

type PlanKind =
  | 'install'
  | 'update'
  | 'unchanged'
  /** Edited locally; poly-skills has nothing newer, so it is kept as is. */
  | 'customized'
  /** Edited locally and changed upstream: replaced only when confirmed. */
  | 'modified'
  /** Present but not installed by Flow: replaced only when confirmed. */
  | 'unmanaged';

interface PlannedSkill {
  kind: PlanKind;
  skill: UpstreamSkill;
  recorded?: SkillsLockEntry;
}

export interface SkillsPlan {
  skills: PlannedSkill[];
  /** Flow-installed folders that are no longer part of the selected setups. */
  retired: [string, SkillsLockEntry][];
}

const HTTPS_SOURCE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const SSH_SOURCE =
  /^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const ARCHIVE_FILE = /\.(?:tar\.gz|tgz)$/i;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Far above any skills snapshot; a larger archive is refused, not read. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Regular file types in a tar archive; links and devices are refused. */
const TAR_FILE_TYPES = new Set(['0', '7']);
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** Created by file browsers; they do not make a skill locally modified. */
const IGNORED_LOCAL_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const CONFLICTS: PlanKind[] = ['modified', 'unmanaged'];
const MARKERS: Record<PlanKind, string> = {
  install: '+',
  update: '~',
  unchanged: '=',
  customized: '*',
  modified: '!',
  unmanaged: '!',
};

function setupById(id: string): SkillSetup {
  const setup = SKILL_SETUPS.find(candidate => candidate.id === id);
  if (!setup) throw new Error(`Unknown skill setup "${id}".`);
  return setup;
}

function setupChoices(): string {
  return SKILL_SETUPS.map(setup => `${setup.id} (${setup.label})`).join(', ');
}

/** Returns known setup IDs in catalogue order, without duplicates. */
function normalizeSetups(names: string[]): string[] {
  const requested = names
    .flatMap(name => name.split(','))
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
  for (const name of requested) {
    if (!SKILL_SETUPS.some(setup => setup.id === name))
      throw new Error(
        `Unknown skill setup "${name}". Choose ${setupChoices()}.`
      );
  }
  return SKILL_SETUPS.map(setup => setup.id).filter(id =>
    requested.includes(id)
  );
}

function httpsRepository(source: string): [string, string] | null {
  const match = HTTPS_SOURCE.exec(source);
  if (!match || [match[1], match[2]].some(part => /^\.+$/.test(part)))
    return null;
  return [match[1], match[2]];
}

function isRemoteSource(source: string): boolean {
  return httpsRepository(source) !== null || SSH_SOURCE.test(source);
}

function resolveSource(value: string | undefined): string {
  if (value === undefined) return SKILLS_SOURCE;
  const repository = httpsRepository(value);
  if (repository) return `https://github.com/${repository.join('/')}`;
  if (SSH_SOURCE.test(value)) return value;
  const absolute = path.resolve(value);
  const info = fs.statSync(absolute, { throwIfNoEntry: false });
  if (info?.isDirectory() || (info?.isFile() && ARCHIVE_FILE.test(absolute)))
    return fs.realpathSync(absolute);
  throw new Error(
    '--source must be https://github.com/owner/repository, git@github.com:owner/repository.git, a local Git repository, or a .tar.gz archive downloaded from GitHub.'
  );
}

export function parseSkillsArgs(argv: string[]): SkillsArgs | null {
  const [command, ...rest] = argv.filter(argument => argument !== '--');
  if (command !== 'skills') return null;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      help: { type: 'boolean', short: 'h' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      source: { type: 'string' },
      ref: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [subcommand, ...names] = positionals;
  const base = {
    setups: [],
    dryRun: values['dry-run'] === true,
    yes: values.yes === true,
    source: SKILLS_SOURCE,
    ref: SKILLS_REF,
  };
  if (values.help || subcommand === undefined)
    return { ...base, command: 'help' };
  if (subcommand !== 'add' && subcommand !== 'update')
    throw new Error(
      `Unknown skills command "${subcommand}". Use flow skills add or flow skills update.`
    );
  if (subcommand === 'update' && names.length)
    throw new Error(
      'flow skills update refreshes the recorded setups. Use flow skills add <setup> to add one.'
    );
  const ref = values.ref ?? SKILLS_REF;
  if (!REF.test(ref) || ref.includes('..'))
    throw new Error('Invalid --ref. Use a branch, tag, or commit ID.');
  return {
    ...base,
    command: subcommand,
    setups: normalizeSetups(names),
    source: resolveSource(values.source),
    ref,
  };
}

export function skillsHelp(): string {
  const setups = SKILL_SETUPS.map(
    setup =>
      `  ${setup.id.padEnd(11)} ${setup.label}: ${setup.packs.join(', ')} packs`
  ).join('\n');
  return `Install and update PolyAPI agent skills from poly-skills.

Usage:
  flow skills add [setup ...] [--dry-run] [--yes]
  flow skills update [--dry-run] [--yes]

Setups (what the skills are needed for):
${setups}

add     Asks what the skills are needed for when no setup is named, installs
        each skill folder into ${SKILLS_DIRECTORY}/ and records the setup in
        ${SKILLS_LOCK_FILE}. Setups already recorded are kept, and all skills
        are refreshed to the same poly-skills revision.
update  Refreshes the skills of the recorded setups and installs skills that
        poly-skills has since added to them.

Options:
  --dry-run        Show the plan without changing files
  --yes            Without asking, replace folders that have local changes or
                   were not installed by Flow when poly-skills differs
  --source SOURCE  https://github.com/owner/repository (public; no Git needed),
                   git@github.com:owner/repository.git, a local Git repository
                   (committed files only), or a .tar.gz archive downloaded
                   from GitHub (default: ${SKILLS_SOURCE})
  --ref REF        Branch, tag, or commit to fetch (default: ${SKILLS_REF});
                   for an archive file, the ref it was downloaded from
  -h, --help       Show this help

Local edits are kept until poly-skills changes that skill. Delete a skill
folder and run update to reinstall it. Skills that leave a setup are reported
and left in place. No PolyAPI connection or environment file is used.`;
}

function protectedName(name: string): boolean {
  return (
    /(^\.env($|\.)|\.env($|\.)|\.(key|pem|p12|pfx|crt)$)/i.test(name) ||
    /^(\.git|\.poly|\.ssh|\.aws|\.azure|\.config|\.netrc|\.npmrc|\.pypirc|env|credentials(?:\.json)?|secrets(?:\.json)?|id_rsa|id_ed25519)$/i.test(
      name
    )
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Digest of a skill folder's paths and contents. CRLF is read as LF so a
 * Windows checkout of committed skills is not reported as modified.
 */
export function digestFiles(
  files: { path: string; content: Buffer }[]
): string {
  const digest = createHash('sha256');
  for (const file of [...files].sort((left, right) =>
    compareText(left.path, right.path)
  )) {
    const content = Buffer.from(
      file.content.toString('latin1').replace(/\r\n/g, '\n'),
      'latin1'
    );
    const contentDigest = createHash('sha256').update(content).digest('hex');
    digest.update(`${file.path}\0${contentDigest}\n`);
  }
  return digest.digest('hex');
}

/** A file or other entry of a poly-skills snapshot, relative to its root. */
interface SnapshotEntry {
  filename: string;
  /** Only regular files are installed; links and other entries are refused. */
  regular: boolean;
  executable: boolean;
  read(): Buffer;
}

/** Validates the entries under the packs' `skills/` folders and groups them. */
function collectSkills(
  entries: SnapshotEntry[],
  commit: string,
  ref: string,
  packs: string[]
): SkillsSnapshot {
  const folders = new Map<string, { name: string; files: SkillFile[] }>();
  for (const entry of entries) {
    const { filename } = entry;
    const [pack, skillsFolder, name, ...rest] = filename.split('/');
    if (!packs.includes(pack) || skillsFolder !== 'skills')
      throw new Error(`Unexpected poly-skills path: ${filename}`);
    // Files directly under <pack>/skills/, such as a README, are not skills.
    if (!rest.length) continue;
    if (!SKILL_NAME.test(name))
      throw new Error(
        `Refusing a skill folder with an unsupported name: ${pack}/skills/${name}`
      );
    if (
      rest.some(
        part => !part || part === '.' || part === '..' || protectedName(part)
      ) ||
      filename.includes('\\')
    )
      throw new Error(`Refusing a protected or unsafe skill path: ${filename}`);
    if (!entry.regular)
      throw new Error(
        `Refusing a link or unsupported entry in poly-skills: ${filename}`
      );
    const key = `${pack}/skills/${name}`;
    const folder = folders.get(key) ?? { name, files: [] };
    folder.files.push({
      path: rest.join('/'),
      content: entry.read(),
      executable: entry.executable,
    });
    folders.set(key, folder);
  }
  const skills = [...folders.entries()]
    .filter(([, folder]) => folder.files.some(file => file.path === 'SKILL.md'))
    .map(([folderSource, folder]) => ({
      name: folder.name,
      source: folderSource,
      files: folder.files,
      digest: digestFiles(folder.files),
    }));
  for (const pack of packs) {
    if (!skills.some(skill => skill.source.startsWith(`${pack}/skills/`)))
      throw new Error(`poly-skills ${ref} has no skills in ${pack}/skills.`);
  }
  return { commit, skills };
}

/**
 * Git's repository-local variables (`git rev-parse --local-env-vars`). Inherited
 * from a hook or wrapper, they would send the temporary shallow fetch into that
 * repository and truncate its history, so Flow clears them as Git does for
 * submodules. Credential and SSH settings such as GIT_SSH_COMMAND are kept.
 */
const LOCAL_GIT_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

/** Fetches committed skill folders with Git, without a checkout. */
function fetchGitSkills(
  source: string,
  ref: string,
  packs: string[]
): SkillsSnapshot {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !LOCAL_GIT_ENV.has(key))
  );
  const repository = fs.mkdtempSync(path.join(tmpdir(), 'flow-skills-'));
  const git = (args: string[], label: string): Buffer => {
    const result = spawnSync('git', ['-C', repository, ...args], {
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    });
    if (result.error || result.status !== 0) {
      const detail = result.stderr
        ?.toString('utf8')
        .trim()
        .split('\n')
        .slice(-2)
        .join(' ');
      throw new Error(
        `${label} failed${result.signal ? ` (${result.signal})` : ''}${detail ? `: ${detail}` : '.'}`
      );
    }
    return result.stdout;
  };
  try {
    git(['init', '--quiet'], 'Git init');
    git(
      ['fetch', '--quiet', '--depth=1', '--no-tags', '--', source, ref],
      `Fetching ${ref} from ${source} (check repository access and --ref)`
    );
    const commit = git(
      ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
      'Resolving the fetched commit'
    )
      .toString('utf8')
      .trim();
    const listing = git(
      [
        'ls-tree',
        '-r',
        '-z',
        commit,
        '--',
        ...packs.map(pack => `${pack}/skills`),
      ],
      'Listing poly-skills'
    ).toString('utf8');
    const entries = listing
      .split('\0')
      .filter(Boolean)
      .map((entry): SnapshotEntry => {
        const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
        if (!match)
          throw new Error('Unexpected Git tree entry in poly-skills.');
        const [, mode, type, object, filename] = match;
        return {
          filename,
          regular: type === 'blob' && (mode === '100644' || mode === '100755'),
          executable: mode === '100755',
          read: () => git(['cat-file', 'blob', object], `Reading ${filename}`),
        };
      });
    return collectSkills(entries, commit, ref, packs);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}

function invalidArchive(): Error {
  return new Error('The skills archive is not a valid .tar.gz file.');
}

function tarText(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function tarNumber(block: Buffer, start: number, length: number): number {
  const text = tarText(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw invalidArchive();
  return text ? Number.parseInt(text, 8) : 0;
}

/** Parses pax records: `<length> <key>=<value>\n`, the length counting all. */
function paxRecords(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = Number(body.subarray(offset, space).toString('latin1'));
    if (
      space === -1 ||
      !Number.isInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > body.length
    )
      throw invalidArchive();
    const record = body
      .subarray(space + 1, offset + length - 1)
      .toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

interface TarEntry {
  name: string;
  type: string;
  mode: number;
  content: Buffer;
}

/**
 * Reads a tar stream as `git archive` and GitHub write it: POSIX ustar entries
 * with pax headers, whose global `comment` record holds the commit ID.
 */
function readTar(tar: Buffer): { comment?: string; entries: TarEntry[] } {
  const entries: TarEntry[] = [];
  let comment: string | undefined;
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < 512; index += 1)
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    if (checksum !== tarNumber(header, 148, 8)) throw invalidArchive();
    const size = tarNumber(header, 124, 12);
    const start = offset + 512;
    const content = tar.subarray(start, start + size);
    if (content.length !== size) throw invalidArchive();
    offset = start + Math.ceil(size / 512) * 512;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (type === 'g') {
      comment = paxRecords(content).comment ?? comment;
      continue;
    }
    if (type === 'x') {
      pax = paxRecords(content);
      continue;
    }
    if (type === 'L') {
      longName = tarText(content, 0, content.length);
      continue;
    }
    // Only POSIX ustar headers have a name prefix; GNU headers use it for times.
    const posix = header.subarray(257, 265).equals(Buffer.from('ustar\x0000'));
    const prefix = posix ? tarText(header, 345, 155) : '';
    const shortName = tarText(header, 0, 100);
    entries.push({
      name:
        pax.path ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName),
      type,
      mode: tarNumber(header, 100, 8),
      content,
    });
    pax = {};
    longName = undefined;
  }
  return { comment, entries };
}

/** Reads the skills of the given packs from a `.tar.gz` archive of poly-skills. */
export function readSkillsArchive(
  archive: Buffer,
  ref: string,
  packs: string[]
): SkillsSnapshot {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch {
    throw invalidArchive();
  }
  const { comment, entries } = readTar(tar);
  if (!comment || !COMMIT.test(comment))
    throw new Error(
      'The skills archive does not record its commit. Use an archive downloaded from GitHub.'
    );
  const prefixes = packs.map(pack => `${pack}/skills/`);
  const selected: SnapshotEntry[] = [];
  for (const entry of entries) {
    // GitHub archives hold one root folder, such as poly-skills-main/.
    const filename = entry.name.split('/').slice(1).join('/');
    if (entry.type === '5' || !prefixes.some(p => filename.startsWith(p)))
      continue;
    selected.push({
      filename,
      regular: TAR_FILE_TYPES.has(entry.type),
      executable: (entry.mode & 0o111) !== 0,
      read: () => entry.content,
    });
  }
  return collectSkills(selected, comment, ref, packs);
}

/** Downloads a public GitHub repository's archive; no Git or sign-in needed. */
async function downloadArchive(source: string, ref: string): Promise<Buffer> {
  const repository = httpsRepository(source);
  if (!repository) throw new Error(`Unsupported skills source: ${source}`);
  const archiveRef = ref.split('/').map(encodeURIComponent).join('/');
  const url = `https://codeload.github.com/${repository.join('/')}/tar.gz/${archiveRef}`;
  const failed = `Downloading ${ref} from ${source} failed`;
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } })?.cause?.message;
    throw new Error(
      `${failed}: ${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ''}`
    );
  }
  if (!response.ok)
    throw new Error(
      `${failed} (HTTP ${response.status}). Check the repository and --ref; for a private repository, use --source git@github.com:${repository.join('/')}.git.`
    );
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES)
    throw new Error(`${failed}: the archive is too large.`);
  return archive;
}

/**
 * Fetches the skill folders of the given packs: from a public GitHub archive
 * over HTTPS, a downloaded archive file, or with Git from an SSH repository or
 * local checkout.
 */
export async function fetchSkills(
  source: string,
  ref: string,
  packs: string[]
): Promise<SkillsSnapshot> {
  if (httpsRepository(source))
    return readSkillsArchive(await downloadArchive(source, ref), ref, packs);
  if (
    !SSH_SOURCE.test(source) &&
    ARCHIVE_FILE.test(source) &&
    fs.statSync(source, { throwIfNoEntry: false })?.isFile()
  )
    return readSkillsArchive(fs.readFileSync(source), ref, packs);
  return fetchGitSkills(source, ref, packs);
}

/** Selects the skills of the setups, rejecting two skills with one name. */
export function resolveSetupSkills(
  snapshot: SkillsSnapshot,
  setups: string[]
): UpstreamSkill[] {
  const selected = new Map<string, { skill: UpstreamSkill; setup: string }>();
  const collisions: string[] = [];
  for (const id of setups) {
    const setup = setupById(id);
    for (const pack of setup.packs) {
      for (const skill of snapshot.skills) {
        if (!skill.source.startsWith(`${pack}/skills/`)) continue;
        const existing = selected.get(skill.name);
        if (!existing) selected.set(skill.name, { skill, setup: setup.label });
        else if (existing.skill.source !== skill.source)
          collisions.push(
            `${skill.name} (${existing.skill.source} for ${existing.setup}, ${skill.source} for ${setup.label})`
          );
      }
    }
  }
  if (collisions.length)
    throw new Error(
      `These setups install different skills with the same folder name: ${collisions.join('; ')}. A project can use only one of them.`
    );
  return [...selected.values()]
    .map(({ skill }) => skill)
    .sort((left, right) => compareText(left.name, right.name));
}

function lstat(filename: string): fs.Stats | undefined {
  return fs.lstatSync(filename, { throwIfNoEntry: false });
}

/** Digest of an installed skill folder, or null when it does not exist. */
function localDigest(folder: string): string | null {
  const info = lstat(folder);
  if (!info) return null;
  // Never equal to a real digest, so a link or file in its place is replaced
  // only with confirmation, and links are not followed.
  if (!info.isDirectory()) return 'not-a-folder';
  const files: { path: string; content: Buffer }[] = [];
  const marker = Buffer.from('\0not-a-regular-file');
  const visit = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory)) {
      if (IGNORED_LOCAL_FILES.has(name)) continue;
      const filename = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const entry = fs.lstatSync(filename);
      // Protected entries are not read; poly-skills never contains them.
      if (protectedName(name)) files.push({ path: relative, content: marker });
      else if (entry.isDirectory()) visit(filename, relative);
      else if (entry.isFile())
        files.push({ path: relative, content: fs.readFileSync(filename) });
      else files.push({ path: relative, content: marker });
    }
  };
  visit(folder, '');
  return digestFiles(files);
}

function recordedEntry(
  lock: SkillsLock | null,
  name: string
): SkillsLockEntry | undefined {
  // Own entries only: a skill named like an Object member, such as
  // `constructor`, must not resolve through the prototype.
  return Object.entries(lock?.skills ?? {}).find(([key]) => key === name)?.[1];
}

export function planSkills(
  projectRoot: string,
  desired: UpstreamSkill[],
  lock: SkillsLock | null
): SkillsPlan {
  const directory = path.join(projectRoot, SKILLS_DIRECTORY);
  const skills = desired.map((skill): PlannedSkill => {
    const local = localDigest(path.join(directory, skill.name));
    const recorded = recordedEntry(lock, skill.name);
    let kind: PlanKind;
    if (local === null) kind = 'install';
    else if (local === skill.digest) kind = 'unchanged';
    else if (!recorded) kind = 'unmanaged';
    else if (local === recorded.digest) kind = 'update';
    else if (skill.digest === recorded.digest) kind = 'customized';
    else kind = 'modified';
    return { kind, skill, recorded };
  });
  const names = new Set(desired.map(skill => skill.name));
  const retired = Object.entries(lock?.skills ?? {}).filter(
    ([name]) => !names.has(name) && lstat(path.join(directory, name))
  );
  return { skills, retired };
}

/** Swaps the new skill folders into place, restoring the old ones on failure. */
function applySkillWrites(projectRoot: string, writes: UpstreamSkill[]): void {
  if (!writes.length) return;
  const directory = path.join(projectRoot, SKILLS_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  // Staging inside the skills folder keeps every rename on one file system.
  const staging = path.join(directory, `.flow-staging-${randomUUID()}`);
  const incoming = path.join(staging, 'incoming');
  const previous = path.join(staging, 'previous');
  fs.mkdirSync(previous, { recursive: true });
  const swapped: { target: string; backup?: string }[] = [];
  let keepStaging = false;
  try {
    for (const skill of writes) {
      for (const file of skill.files) {
        const target = path.join(incoming, skill.name, ...file.path.split('/'));
        const mode = file.executable ? 0o755 : 0o644;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, { mode });
        fs.chmodSync(target, mode);
      }
    }
    for (const skill of writes) {
      const target = path.join(directory, skill.name);
      const backup = lstat(target)
        ? path.join(previous, skill.name)
        : undefined;
      if (backup) fs.renameSync(target, backup);
      swapped.push({ target, backup });
      fs.renameSync(path.join(incoming, skill.name), target);
    }
  } catch (error) {
    const unrestored: string[] = [];
    for (const { target, backup } of swapped.reverse()) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        if (backup) fs.renameSync(backup, target);
      } catch {
        unrestored.push(path.basename(target));
      }
    }
    if (unrestored.length) {
      keepStaging = true;
      throw new Error(
        `Installing skills failed and ${unrestored.join(', ')} could not be restored; the previous folders are in ${previous}. Cause: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  } finally {
    if (!keepStaging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function readSkillsLock(projectRoot: string): SkillsLock | null {
  const filename = path.join(projectRoot, SKILLS_LOCK_FILE);
  if (!lstat(filename)) return null;
  const invalid = (detail: string) =>
    new Error(
      `${SKILLS_LOCK_FILE} ${detail}. Restore it from Git, or delete it and run flow skills add.`
    );
  let value: any;
  try {
    value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    throw invalid('is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw invalid('is not a JSON object');
  if (typeof value.version === 'number' && value.version > LOCK_VERSION)
    throw new Error(
      `${SKILLS_LOCK_FILE} was written by a newer Flow version. Update Flow with pnpm flow run self-update.`
    );
  if (value.version !== LOCK_VERSION)
    throw invalid('has an unsupported version');
  if (
    !Array.isArray(value.setups) ||
    value.setups.some((id: unknown) => typeof id !== 'string')
  )
    throw invalid('has an invalid setups list');
  for (const id of value.setups) {
    if (!SKILL_SETUPS.some(setup => setup.id === id))
      throw new Error(
        `${SKILLS_LOCK_FILE} records the "${id}" setup, which this Flow version does not provide. Update Flow with pnpm flow run self-update.`
      );
  }
  if (typeof value.ref !== 'string' || typeof value.commit !== 'string')
    throw invalid('is missing its ref or commit');
  if (value.source !== undefined && typeof value.source !== 'string')
    throw invalid('has an invalid source');
  if (
    typeof value.skills !== 'object' ||
    value.skills === null ||
    Array.isArray(value.skills)
  )
    throw invalid('has an invalid skills list');
  for (const [name, entry] of Object.entries<any>(value.skills)) {
    if (
      !SKILL_NAME.test(name) ||
      typeof entry?.source !== 'string' ||
      typeof entry?.digest !== 'string' ||
      !DIGEST.test(entry.digest)
    )
      throw invalid(`has an invalid entry for "${name}"`);
  }
  return value as SkillsLock;
}

/** Serializes the lock as Biome formats JSON, so `pnpm check` accepts it. */
export function formatSkillsLock(lock: SkillsLock): string {
  const text = JSON.stringify(lock, null, 2);
  const inline = `"setups": [${lock.setups.map(id => JSON.stringify(id)).join(', ')}]`;
  // Biome keeps an array on one line when it fits within the 80-column width.
  const fits = `  ${inline},`.length <= 80;
  return `${fits ? text.replace(/"setups": \[[^\]]*\]/, inline) : text}\n`;
}

function writeSkillsLock(projectRoot: string, lock: SkillsLock): void {
  const filename = path.join(projectRoot, SKILLS_LOCK_FILE);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, formatSkillsLock(lock));
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function buildLock(
  args: SkillsArgs,
  setups: string[],
  commit: string,
  plan: SkillsPlan,
  replaceConflicts: boolean
): SkillsLock {
  const entries: [string, SkillsLockEntry][] = [];
  for (const { kind, skill, recorded } of plan.skills) {
    const kept =
      kind === 'customized' || (CONFLICTS.includes(kind) && !replaceConflicts);
    if (!kept)
      entries.push([
        skill.name,
        { source: skill.source, digest: skill.digest },
      ]);
    // A kept folder keeps the baseline Flow installed, if there is one.
    else if (recorded) entries.push([skill.name, recorded]);
  }
  entries.push(...plan.retired);
  entries.sort(([left], [right]) => compareText(left, right));
  return {
    version: LOCK_VERSION,
    setups,
    ...(args.source !== SKILLS_SOURCE && isRemoteSource(args.source)
      ? { source: args.source }
      : {}),
    ref: args.ref,
    commit,
    skills: Object.fromEntries(entries),
  };
}

async function chooseSetups(
  runtime: SkillsRuntime,
  recorded: string[]
): Promise<string[]> {
  const defaults = recorded.length ? recorded : [RECOMMENDED_SETUP];
  runtime.print('What do you need agent skills for?');
  SKILL_SETUPS.forEach((setup, index) => {
    const note = recorded.includes(setup.id)
      ? ' (installed)'
      : !recorded.length && setup.id === RECOMMENDED_SETUP
        ? ' (recommended for this project)'
        : '';
    runtime.print(`  ${index + 1}) ${setup.label}${note}`);
  });
  const defaultAnswer = defaults
    .map(id => SKILL_SETUPS.findIndex(setup => setup.id === id) + 1)
    .join(',');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (
      await runtime.prompt(
        `Select one or more, separated by commas [${defaultAnswer}]: `
      )
    ).trim();
    if (!answer) return defaults;
    const names = answer.split(',').map(part => {
      const index = Number(part.trim());
      return Number.isInteger(index) &&
        index >= 1 &&
        index <= SKILL_SETUPS.length
        ? SKILL_SETUPS[index - 1].id
        : part;
    });
    try {
      const setups = normalizeSetups(names);
      if (setups.length) return setups;
    } catch (error) {
      runtime.print(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error('No skill setup was selected.');
}

function describe(item: PlannedSkill): string {
  switch (item.kind) {
    case 'install':
      return item.recorded ? 'missing; reinstalling' : 'new';
    case 'update':
      return 'updated in poly-skills';
    case 'customized':
      return 'local changes kept; no poly-skills update';
    case 'modified':
      return 'local changes, and updated in poly-skills';
    case 'unmanaged':
      return 'existing folder that Flow did not install';
    case 'unchanged':
      return 'unchanged';
  }
}

export async function runSkills(
  args: SkillsArgs,
  runtime: SkillsRuntime
): Promise<void> {
  if (args.command === 'help') {
    runtime.print(skillsHelp());
    return;
  }
  const lock = readSkillsLock(runtime.projectRoot);
  const recorded = lock?.setups ?? [];
  let setups: string[];
  if (args.command === 'update') {
    if (!recorded.length)
      throw new Error(
        `No skill setup is recorded in ${SKILLS_LOCK_FILE}. Run flow skills add to choose one.`
      );
    setups = recorded;
  } else {
    if (!args.setups.length && !runtime.interactive)
      throw new Error(
        `Name the setup to add, for example: flow skills add ${RECOMMENDED_SETUP}. Choose ${setupChoices()}.`
      );
    const chosen = args.setups.length
      ? args.setups
      : await chooseSetups(runtime, recorded);
    setups = normalizeSetups([...recorded, ...chosen]);
  }

  const packs = [...new Set(setups.flatMap(id => setupById(id).packs))];
  runtime.print(`Fetching poly-skills ${args.ref}...`);
  const snapshot = await runtime.fetch(args.source, args.ref, packs);
  const desired = resolveSetupSkills(snapshot, setups);
  const plan = planSkills(runtime.projectRoot, desired, lock);

  const labels = setups.map(id => setupById(id).label).join(', ');
  runtime.print(
    `Skills for ${labels} from poly-skills ${args.ref} (${snapshot.commit.slice(0, 7)}):`
  );
  const width = Math.max(...desired.map(skill => skill.name.length), 0);
  for (const item of plan.skills) {
    if (item.kind !== 'unchanged')
      runtime.print(
        `  ${MARKERS[item.kind]} ${item.skill.name.padEnd(width)}  ${describe(item)}`
      );
  }
  for (const [name] of plan.retired)
    runtime.print(
      `  - ${name.padEnd(width)}  no longer in the selected setups; left in place`
    );
  const unchanged = plan.skills.filter(item => item.kind === 'unchanged');
  if (unchanged.length) runtime.print(`  ${unchanged.length} unchanged`);

  if (args.dryRun) {
    runtime.print('Dry run: no files were changed.');
    return;
  }

  const conflicts = plan.skills.filter(item => CONFLICTS.includes(item.kind));
  let replaceConflicts = args.yes;
  if (conflicts.length && !replaceConflicts && runtime.interactive) {
    const answer = await runtime.prompt(
      `Replace the ${conflicts.length} folder(s) marked ! with the poly-skills version? Answer no to keep them and continue. [y/N] `
    );
    replaceConflicts = /^y(es)?$/i.test(answer.trim());
  }
  const writes = plan.skills.filter(
    item =>
      item.kind === 'install' ||
      item.kind === 'update' ||
      (replaceConflicts && CONFLICTS.includes(item.kind))
  );
  applySkillWrites(
    runtime.projectRoot,
    writes.map(item => item.skill)
  );
  writeSkillsLock(
    runtime.projectRoot,
    buildLock(args, setups, snapshot.commit, plan, replaceConflicts)
  );

  const count = (kinds: PlanKind[]) =>
    writes.filter(item => kinds.includes(item.kind)).length;
  const changes = (
    [
      ['installed', count(['install'])],
      ['updated', count(['update'])],
      ['replaced', count(CONFLICTS)],
    ] as const
  )
    .filter(([, total]) => total)
    .map(([verb, total]) => `${verb} ${total}`);
  if (changes.length)
    changes[0] = `${changes[0][0].toUpperCase()}${changes[0].slice(1)}`;
  runtime.print(
    changes.length
      ? `${changes.join(', ')} skill folder(s) in ${SKILLS_DIRECTORY}; ${unchanged.length} unchanged.`
      : `Skills in ${SKILLS_DIRECTORY} are up to date.`
  );
  if (conflicts.length && !replaceConflicts)
    runtime.print(
      `Kept ${conflicts.length} folder(s) marked !. Rerun with --yes to replace them with the poly-skills version.`
    );
  if (args.command === 'add')
    runtime.print(
      `Recorded ${labels} in ${SKILLS_LOCK_FILE}. Commit it with ${SKILLS_DIRECTORY}/, and run flow skills update to refresh the skills.`
    );
}

export function createSkillsRuntime(projectRoot: string): SkillsRuntime {
  return {
    projectRoot,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async prompt(message) {
      const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await readline.question(message);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError')
          throw new Error('Prompt cancelled');
        throw error;
      } finally {
        readline.close();
      }
    },
    print(message) {
      process.stdout.write(`${message}\n`);
    },
    fetch: fetchSkills,
  };
}
