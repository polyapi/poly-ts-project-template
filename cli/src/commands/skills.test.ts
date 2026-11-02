import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  fetchSkills,
  formatSkillsLock,
  parseSkillsArgs,
  readSkillsLock,
  runSkills,
  SKILLS_LOCK_FILE,
  SKILLS_SOURCE,
  type SkillsArgs,
  type SkillsRuntime,
} from './skills';

function skill(name: string, body = name): string {
  return `---\nname: ${name}\ndescription: Use for ${body}.\n---\n\n# ${body}\n`;
}

const UPSTREAM: Record<string, string> = {
  'general/README.md': '# general\n',
  'general/skills/clean-code/SKILL.md': skill('clean-code'),
  'general/skills/markdownlint-compliance/SKILL.md': skill(
    'markdownlint-compliance'
  ),
  'polyapi-common/skills/polyapi-constructs/SKILL.md':
    skill('polyapi-constructs'),
  'polyapi-common/skills/polyapi-constructs/references/REFERENCE.md':
    '# Reference\n',
  'polyapi-common/skills/notes/README.md': 'Not a skill: no SKILL.md.\n',
  'polyapi-typescript/skills/polyapi-sdk/SKILL.md': skill(
    'polyapi-sdk',
    'TypeScript SDK'
  ),
  'polyapi-typescript/skills/polyapi-sdk/scripts/check.sh': '#!/bin/sh\n',
  'polyapi-python/skills/polyapi-sdk/SKILL.md': skill(
    'polyapi-sdk',
    'Python SDK'
  ),
  'mulesoft-to-polyapi/skills/compress-source/SKILL.md':
    skill('compress-source'),
};

function temporary(t: TestContext, prefix: string): string {
  const directory = fs.mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Flow Test',
      '-c',
      'user.email=flow@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A local poly-skills repository; `commit` applies edits (null deletes). */
function skillsRepository(t: TestContext) {
  const root = temporary(t, 'flow-skills-source-');
  git(root, ['init', '--quiet', '--initial-branch=main']);
  const commit = (files: Record<string, string | null>): string => {
    for (const [relative, content] of Object.entries(files)) {
      const filename = path.join(root, relative);
      if (content === null) {
        fs.rmSync(filename, { recursive: true, force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
      if (relative.endsWith('.sh')) fs.chmodSync(filename, 0o755);
    }
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '--message', 'Update skills']);
    return git(root, ['rev-parse', 'HEAD']);
  };
  const head = commit(UPSTREAM);
  return { root, commit, head };
}

function project(t: TestContext): string {
  const root = temporary(t, 'flow-skills-project-');
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    "packages: ['cli']\n"
  );
  fs.mkdirSync(path.join(root, '.agents/skills'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents/skills/README.md'), '# Skills\n');
  return root;
}

function runtime(
  projectRoot: string,
  options: { interactive?: boolean; answers?: string[] } = {}
) {
  const output: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  const value: SkillsRuntime = {
    projectRoot,
    interactive: options.interactive ?? false,
    async prompt(message) {
      prompts.push(message);
      return answers.shift() ?? '';
    },
    print(message) {
      output.push(message);
    },
    fetch: fetchSkills,
  };
  return { runtime: value, output, prompts, text: () => output.join('\n') };
}

function args(source: string, argv: string[]): SkillsArgs {
  const parsed = parseSkillsArgs(['skills', ...argv, '--source', source]);
  assert.ok(parsed);
  return parsed;
}

function read(projectRoot: string, relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8');
}

function installed(projectRoot: string): string[] {
  return fs.readdirSync(path.join(projectRoot, '.agents/skills')).sort();
}

test('parses skills commands and rejects unsupported input', () => {
  assert.equal(parseSkillsArgs(['push']), null);
  assert.equal(parseSkillsArgs(['skills'])?.command, 'help');
  assert.equal(parseSkillsArgs(['skills', 'add', '--help'])?.command, 'help');
  assert.deepEqual(parseSkillsArgs(['skills', 'add', 'python,TypeScript']), {
    command: 'add',
    setups: ['typescript', 'python'],
    dryRun: false,
    yes: false,
    source: SKILLS_SOURCE,
    ref: 'main',
  });
  const update = parseSkillsArgs([
    'skills',
    'update',
    '--',
    '--dry-run',
    '--yes',
    '--ref',
    'release/1.0',
    '--source',
    'git@github.com:example/poly-skills.git',
  ]);
  assert.equal(update?.dryRun, true);
  assert.equal(update?.yes, true);
  assert.equal(update?.ref, 'release/1.0');
  assert.equal(update?.source, 'git@github.com:example/poly-skills.git');
  assert.throws(
    () => parseSkillsArgs(['skills', 'add', 'java']),
    /Unknown skill setup "java"/
  );
  assert.throws(
    () => parseSkillsArgs(['skills', 'update', 'typescript']),
    /refreshes the recorded setups/
  );
  assert.throws(
    () => parseSkillsArgs(['skills', 'remove']),
    /Unknown skills command "remove"/
  );
  assert.throws(
    () => parseSkillsArgs(['skills', 'update', '--ref', 'main..other']),
    /Invalid --ref/
  );
  assert.throws(
    () =>
      parseSkillsArgs([
        'skills',
        'update',
        '--source',
        'https://example.test/skills.git',
      ]),
    /--source must be/
  );
});

test('add installs the packs of the chosen setup and records them', async t => {
  const upstream = skillsRepository(t);
  const root = project(t);
  const run = runtime(root);

  await runSkills(args(upstream.root, ['add', 'typescript']), run.runtime);

  assert.deepEqual(installed(root), [
    'README.md',
    'clean-code',
    'markdownlint-compliance',
    'polyapi-constructs',
    'polyapi-sdk',
  ]);
  assert.equal(read(root, '.agents/skills/README.md'), '# Skills\n');
  assert.match(
    read(root, '.agents/skills/polyapi-sdk/SKILL.md'),
    /TypeScript SDK/
  );
  assert.equal(
    read(root, '.agents/skills/polyapi-constructs/references/REFERENCE.md'),
    '# Reference\n'
  );
  if (process.platform !== 'win32') {
    const mode = fs.statSync(
      path.join(root, '.agents/skills/polyapi-sdk/scripts/check.sh')
    ).mode;
    assert.equal(mode & 0o777, 0o755);
  }
  const lock = readSkillsLock(root);
  assert.ok(lock);
  assert.deepEqual(lock.setups, ['typescript']);
  assert.equal(lock.commit, upstream.head);
  assert.equal(lock.ref, 'main');
  assert.equal(lock.source, undefined, 'local checkouts are not recorded');
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(lock.skills).map(([name, entry]) => [name, entry.source])
    ),
    {
      'clean-code': 'general/skills/clean-code',
      'markdownlint-compliance': 'general/skills/markdownlint-compliance',
      'polyapi-constructs': 'polyapi-common/skills/polyapi-constructs',
      'polyapi-sdk': 'polyapi-typescript/skills/polyapi-sdk',
    }
  );
  const lockText = read(root, SKILLS_LOCK_FILE);
  assert.equal(lockText, formatSkillsLock(lock));
  assert.match(lockText, /^ {2}"setups": \["typescript"\],$/m);
  assert.ok(lockText.endsWith('}\n'));
  assert.match(run.text(), /\+ polyapi-sdk +new/);
  assert.match(run.text(), /Installed 4 skill folder\(s\)/);
});

test('update refreshes unmodified skills and installs skills newly added to a setup', async t => {
  const upstream = skillsRepository(t);
  const root = project(t);
  await runSkills(
    args(upstream.root, ['add', 'typescript']),
    runtime(root).runtime
  );
  const head = upstream.commit({
    'polyapi-typescript/skills/polyapi-sdk/SKILL.md': skill(
      'polyapi-sdk',
      'TypeScript SDK v2'
    ),
    'polyapi-typescript/skills/api-function-training/SKILL.md': skill(
      'api-function-training'
    ),
    'general/skills/clean-code': null,
  });

  const run = runtime(root);
  await runSkills(args(upstream.root, ['update']), run.runtime);

  assert.match(
    read(root, '.agents/skills/polyapi-sdk/SKILL.md'),
    /TypeScript SDK v2/
  );
  assert.match(
    read(root, '.agents/skills/api-function-training/SKILL.md'),
    /api-function-training/
  );
  assert.ok(
    fs.existsSync(path.join(root, '.agents/skills/clean-code/SKILL.md')),
    'skills that leave a setup are left in place'
  );
  assert.match(run.text(), /\+ api-function-training +new/);
  assert.match(run.text(), /~ polyapi-sdk +updated in poly-skills/);
  assert.match(run.text(), /- clean-code +no longer in the selected setups/);
  assert.match(run.text(), /Installed 1, updated 1 skill folder\(s\)/);
  const lock = readSkillsLock(root);
  assert.equal(lock?.commit, head);
  assert.deepEqual(Object.keys(lock?.skills ?? {}), [
    'api-function-training',
    'clean-code',
    'markdownlint-compliance',
    'polyapi-constructs',
    'polyapi-sdk',
  ]);
  assert.equal(
    fs
      .readdirSync(path.join(root, '.agents/skills'))
      .some(name => name.startsWith('.flow-staging-')),
    false
  );

  fs.rmSync(path.join(root, '.agents/skills/clean-code'), { recursive: true });
  const again = runtime(root);
  await runSkills(args(upstream.root, ['update']), again.runtime);
  assert.match(again.text(), /are up to date/);
  assert.equal('clean-code' in (readSkillsLock(root)?.skills ?? {}), false);
});

test('local changes are kept until poly-skills changes the skill and replacement is confirmed', async t => {
  const upstream = skillsRepository(t);
  const root = project(t);
  await runSkills(
    args(upstream.root, ['add', 'typescript']),
    runtime(root).runtime
  );
  const installedDigest = readSkillsLock(root)?.skills['polyapi-sdk'].digest;
  const localEdit = `${skill('polyapi-sdk', 'TypeScript SDK')}\nProject note.\n`;
  const skillFile = path.join(root, '.agents/skills/polyapi-sdk/SKILL.md');
  fs.writeFileSync(skillFile, localEdit);

  const customized = runtime(root, { interactive: true });
  await runSkills(args(upstream.root, ['update']), customized.runtime);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), localEdit);
  assert.match(customized.text(), /\* polyapi-sdk +local changes kept/);
  assert.deepEqual(customized.prompts, [], 'nothing to replace yet');

  upstream.commit({
    'polyapi-typescript/skills/polyapi-sdk/SKILL.md': skill(
      'polyapi-sdk',
      'TypeScript SDK v2'
    ),
  });
  const unattended = runtime(root);
  await runSkills(args(upstream.root, ['update']), unattended.runtime);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), localEdit);
  assert.match(
    unattended.text(),
    /! polyapi-sdk +local changes, and updated in poly-skills/
  );
  assert.match(unattended.text(), /Kept 1 folder\(s\) marked !/);
  assert.equal(
    readSkillsLock(root)?.skills['polyapi-sdk'].digest,
    installedDigest
  );

  const declined = runtime(root, { interactive: true, answers: ['n'] });
  await runSkills(args(upstream.root, ['update']), declined.runtime);
  assert.equal(declined.prompts.length, 1);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), localEdit);

  const accepted = runtime(root, { interactive: true, answers: ['y'] });
  await runSkills(args(upstream.root, ['update']), accepted.runtime);
  assert.match(fs.readFileSync(skillFile, 'utf8'), /TypeScript SDK v2/);
  assert.match(accepted.text(), /Replaced 1 skill folder\(s\)/);
  assert.notEqual(
    readSkillsLock(root)?.skills['polyapi-sdk'].digest,
    installedDigest
  );
});

test('existing folders Flow did not install are adopted when identical and otherwise replaced only on request', async t => {
  const upstream = skillsRepository(t);
  const root = project(t);
  const skillsFolder = path.join(root, '.agents/skills');
  fs.mkdirSync(path.join(skillsFolder, 'clean-code'));
  fs.writeFileSync(
    path.join(skillsFolder, 'clean-code/SKILL.md'),
    UPSTREAM['general/skills/clean-code/SKILL.md']
  );
  fs.mkdirSync(path.join(skillsFolder, 'polyapi-sdk'));
  fs.writeFileSync(
    path.join(skillsFolder, 'polyapi-sdk/SKILL.md'),
    'An older copy.\n'
  );
  fs.writeFileSync(path.join(skillsFolder, 'polyapi-sdk/stray.md'), 'Old.\n');

  const kept = runtime(root);
  await runSkills(args(upstream.root, ['add', 'typescript']), kept.runtime);
  assert.match(
    kept.text(),
    /! polyapi-sdk +existing folder that Flow did not install/
  );
  assert.doesNotMatch(kept.text(), /clean-code/);
  assert.deepEqual(Object.keys(readSkillsLock(root)?.skills ?? {}), [
    'clean-code',
    'markdownlint-compliance',
    'polyapi-constructs',
  ]);
  assert.equal(
    read(root, '.agents/skills/polyapi-sdk/SKILL.md'),
    'An older copy.\n'
  );

  await runSkills(
    args(upstream.root, ['add', 'typescript', '--yes']),
    runtime(root).runtime
  );
  assert.match(
    read(root, '.agents/skills/polyapi-sdk/SKILL.md'),
    /TypeScript SDK/
  );
  assert.equal(
    fs.existsSync(path.join(skillsFolder, 'polyapi-sdk/stray.md')),
    false
  );
  assert.ok(readSkillsLock(root)?.skills['polyapi-sdk']);
});

test('CRLF checkouts and file browser metadata are not local changes', async t => {
  const upstream = skillsRepository(t);
  const root = project(t);
  await runSkills(
    args(upstream.root, ['add', 'typescript']),
    runtime(root).runtime
  );
  const skillFile = path.join(
    root,
    '.agents/skills/polyapi-constructs/SKILL.md'
  );
  fs.writeFileSync(
    skillFile,
    fs.readFileSync(skillFile, 'utf8').replace(/\n/g, '\r\n')
  );
  fs.writeFileSync(
    path.join(root, '.agents/skills/polyapi-constructs/.DS_Store'),
    'metadata'
  );

  const run = runtime(root);
  await runSkills(args(upstream.root, ['update']), run.runtime);
  assert.match(run.text(), /4 unchanged/);
  assert.match(run.text(), /are up to date/);
});

test('update needs a recorded setup, and setups with clashing skill names cannot be combined', async t => {
  const upstream = skillsRepository(t);
  const root = project(t);
  await assert.rejects(
    runSkills(args(upstream.root, ['update']), runtime(root).runtime),
    /No skill setup is recorded/
  );

  await runSkills(
    args(upstream.root, ['add', 'typescript']),
    runtime(root).runtime
  );
  const lockBefore = read(root, SKILLS_LOCK_FILE);
  await assert.rejects(
    runSkills(args(upstream.root, ['add', 'python']), runtime(root).runtime),
    /same folder name: polyapi-sdk \(polyapi-typescript\/skills\/polyapi-sdk for Coding in TypeScript, polyapi-python\/skills\/polyapi-sdk for Coding in Python\)/
  );
  assert.equal(read(root, SKILLS_LOCK_FILE), lockBefore);
  assert.match(
    read(root, '.agents/skills/polyapi-sdk/SKILL.md'),
    /TypeScript SDK/
  );
});

test('add asks what the skills are needed for when no setup is named', async t => {
  const upstream = skillsRepository(t);

  const recommended = project(t);
  const first = runtime(recommended, { interactive: true, answers: [''] });
  await runSkills(args(upstream.root, ['add']), first.runtime);
  assert.match(first.text(), /What do you need agent skills for\?/);
  assert.match(
    first.text(),
    /1\) Coding in TypeScript \(recommended for this project\)/
  );
  assert.match(first.text(), /2\) Coding in Python/);
  assert.deepEqual(first.prompts, [
    'Select one or more, separated by commas [1]: ',
  ]);
  assert.deepEqual(readSkillsLock(recommended)?.setups, ['typescript']);

  const python = project(t);
  const second = runtime(python, { interactive: true, answers: ['3', '2'] });
  await runSkills(args(upstream.root, ['add']), second.runtime);
  assert.match(second.text(), /Unknown skill setup "3"/);
  assert.deepEqual(readSkillsLock(python)?.setups, ['python']);
  assert.match(
    read(python, '.agents/skills/polyapi-sdk/SKILL.md'),
    /Python SDK/
  );

  await assert.rejects(
    runSkills(args(upstream.root, ['add']), runtime(project(t)).runtime),
    /Name the setup to add, for example: flow skills add typescript/
  );
});

test('dry run prints the plan without changing files', async t => {
  const upstream = skillsRepository(t);
  const root = project(t);
  const run = runtime(root);
  await runSkills(
    args(upstream.root, ['add', 'typescript', '--dry-run']),
    run.runtime
  );
  assert.match(run.text(), /\+ polyapi-sdk +new/);
  assert.match(run.text(), /Dry run: no files were changed/);
  assert.deepEqual(installed(root), ['README.md']);
  assert.equal(fs.existsSync(path.join(root, SKILLS_LOCK_FILE)), false);
});

test('fetch refuses links, protected files and missing packs', async t => {
  const linked = skillsRepository(t);
  fs.symlinkSync(
    '../../../general/README.md',
    path.join(linked.root, 'general/skills/clean-code/linked.md')
  );
  linked.commit({});
  assert.throws(
    () => fetchSkills(linked.root, 'main', ['general']),
    /Refusing a link or unsupported entry in poly-skills: general\/skills\/clean-code\/linked\.md/
  );

  const secret = skillsRepository(t);
  secret.commit({ 'general/skills/clean-code/.env': 'TOKEN=placeholder\n' });
  assert.throws(
    () => fetchSkills(secret.root, 'main', ['general']),
    /Refusing a protected or unsafe skill path/
  );

  const missing = skillsRepository(t);
  missing.commit({ 'polyapi-python': null });
  assert.throws(
    () => fetchSkills(missing.root, 'main', ['general', 'polyapi-python']),
    /poly-skills main has no skills in polyapi-python\/skills/
  );
  assert.throws(
    () => fetchSkills(missing.root, 'no-such-branch', ['general']),
    /Fetching no-such-branch from .* failed/
  );
});

test('rejects lock files it cannot trust', t => {
  const root = project(t);
  const lockFile = path.join(root, SKILLS_LOCK_FILE);
  const valid = {
    version: 1,
    setups: ['typescript'],
    ref: 'main',
    commit: 'a'.repeat(40),
    skills: { 'polyapi-sdk': { source: 'x', digest: 'b'.repeat(64) } },
  };
  const attempt = (value: unknown) => {
    fs.writeFileSync(
      lockFile,
      typeof value === 'string' ? value : JSON.stringify(value)
    );
    return () => readSkillsLock(root);
  };
  assert.deepEqual(attempt(valid)(), valid);
  assert.throws(attempt('{'), /is not valid JSON/);
  assert.throws(attempt({ ...valid, version: 2 }), /newer Flow version/);
  assert.throws(
    attempt({ ...valid, setups: ['java'] }),
    /records the "java" setup/
  );
  assert.throws(
    attempt({ ...valid, skills: { '../escape': valid.skills['polyapi-sdk'] } }),
    /invalid entry for "..\/escape"/
  );
  assert.throws(
    attempt({ ...valid, skills: { 'polyapi-sdk': { source: 'x' } } }),
    /invalid entry for "polyapi-sdk"/
  );
});
