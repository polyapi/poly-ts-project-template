const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const updater = path.join(__dirname, 'self-update.cjs');

function write(root, relative, contents) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function json(root, relative, value) {
  write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Flow fixture',
      '-c',
      'user.email=flow@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      `core.hooksPath=${path.join(root, '.fixture-no-hooks')}`,
      ...args,
    ],
    { cwd: root, encoding: 'utf8', timeout: 15_000 }
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function commit(root) {
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Synthetic fixture');
  return git(root, 'rev-parse', 'HEAD');
}

function scaffold(root, label) {
  fs.mkdirSync(root, { recursive: true });
  write(root, '.gitignore', 'node_modules/\ndist/\n.flow/updates/\n');
  json(root, 'package.json', {
    name: label,
    private: true,
    scripts: { flow: 'pnpm --filter flow-cli' },
  });
  write(root, 'pnpm-workspace.yaml', "packages:\n  - 'cli'\n  - 'workflows'\n");
  write(
    root,
    'pnpm-lock.yaml',
    `lockfileVersion: '9.0'\n# ${label}: keep this project lockfile\n`
  );
  json(root, 'workflows/package.json', { name: 'workflows', private: true });
  write(
    root,
    'workflows/src/project.ts',
    '// Workflow source must remain untouched.\n'
  );
  json(root, 'cli/package.json', {
    name: 'flow-cli',
    version: '1.0.0',
    private: true,
    bin: { flow: 'bin/flow.js' },
    scripts: { build: 'tsc', 'self-update': 'node bin/self-update.cjs' },
    devDependencies: { typescript: '5.8.3' },
  });
  json(root, 'cli/tsconfig.json', {
    compilerOptions: { rootDir: './src', outDir: './dist' },
    include: ['src/**/*'],
  });
  write(root, 'cli/src/cli.ts', `// ${label} CLI source\n`);
  write(root, 'cli/bin/flow.js', "require('../dist/cli.js');\n");
  write(root, 'cli/bin/self-update.cjs', fs.readFileSync(updater, 'utf8'));
  write(
    root,
    'cli/src/sdk/schema.d.ts',
    `// ${label} checked-in schema declaration\n`
  );
  json(root, 'cli/schemas/openapi/Fixture.schema.json', {
    title: label,
    type: 'object',
  });
  git(root, 'init', '--quiet', '-b', 'main');
  return commit(root);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-self-update-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  const source = path.join(root, 'template');
  const bin = path.join(root, 'fake-bin');
  const trace = path.join(root, 'commands.jsonl');
  scaffold(project, 'local-project');
  const sourceCommit = scaffold(source, 'incoming-template');
  write(
    project,
    'cli/src/custom-command.ts',
    '// Added locally and never committed.\n'
  );
  write(
    project,
    'cli/src/cli.ts',
    '// Customized locally after project creation.\n'
  );
  write(
    project,
    'cli/node_modules/existing-install.txt',
    'keep installed dependencies\n'
  );
  write(project, 'cli/dist/cli.js', "console.log('previous build');\n");
  write(
    bin,
    'pnpm',
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
if (args.includes('install') || args.includes('update') || args.includes('generate')) {
  process.stderr.write('Unexpected dependency or SDK operation');
  process.exit(91);
}
if (!args.includes('tsc')) {
  process.stderr.write('Unexpected pnpm invocation: ' + args.join(' '));
  process.exit(92);
}
let root = process.cwd();
if (path.basename(root) === 'cli') root = path.dirname(root);
const source = fs.readFileSync(path.join(root, 'cli/src/cli.ts'), 'utf8');
if (source.includes('BROKEN_BUILD')) process.exit(23);
if (source.includes('LATE_PREVIOUS_EDIT')) {
  const store = path.join(root, '.flow/updates');
  const recovery = fs.readdirSync(store)
    .map(name => path.join(store, name, 'previous-runtime/src/cli.ts'))
    .find(filename => fs.existsSync(filename));
  if (!recovery) process.exit(93);
  fs.writeFileSync(recovery, '// Late editor save while validation was running.\\n');
}
fs.mkdirSync(path.join(root, 'cli/dist'), {recursive:true});
fs.writeFileSync(path.join(root, 'cli/dist/cli.js'), "console.log('Flow fixture help');\\n");
fs.writeFileSync(path.join(root, 'cli/dist/fixture.test.js'),
  source.includes('BROKEN_TEST')
    ? "require('node:test')('fixture fails', () => { throw new Error('deliberate fixture failure'); });\\n"
    : "require('node:test')('fixture passes', () => {});\\n");
`
  );
  fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  for (const name of Object.keys(env)) {
    if (/^(POLY|API_KEY$|BASE_URL$|ENVPATH$)/.test(name)) delete env[name];
  }
  return {
    root,
    project,
    source,
    sourceCommit,
    trace,
    env,
    run(args = [], options = {}) {
      const result = spawnSync(
        process.execPath,
        [
          options.script || updater,
          '--project',
          project,
          '--source',
          source,
          ...args,
        ],
        {
          cwd: options.cwd || project,
          env,
          encoding: 'utf8',
          input: options.input,
          timeout: 30_000,
        }
      );
      return {
        ...result,
        output: `${result.stdout || ''}${result.stderr || ''}`,
      };
    },
  };
}

function backups(project) {
  const parent = path.join(project, '.flow/updates');
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent)
    .map(name => path.join(parent, name))
    .filter(
      directory =>
        fs.statSync(directory).isDirectory() &&
        fs.existsSync(path.join(directory, 'manifest.json'))
    )
    .sort();
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function onlyBackup(project) {
  const found = backups(project);
  assert.equal(
    found.length,
    1,
    `Expected one recovery backup, found ${found.length}`
  );
  return found[0];
}

test('preview reports the fetched revision without changing project source or creating a backup', t => {
  const f = fixture(t);
  const before = git(f.project, 'status', '--porcelain');
  const result = f.run(['--check']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(f.sourceCommit.slice(0, 7)));
  assert.equal(git(f.project, 'status', '--porcelain'), before);
  assert.equal(backups(f.project).length, 0);
  assert.equal(
    fs.existsSync(f.trace),
    false,
    'Preview must not compile or install'
  );
});

test('noninteractive replacement requires explicit authorization', t => {
  const f = fixture(t);
  const before = read(f.project, 'cli/src/cli.ts');
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.equal(backups(f.project).length, 0);
});

test('replacement saves dirty and added source, retains installed dependencies, and writes an AI handoff', t => {
  const f = fixture(t);
  const originals = Object.fromEntries(
    [
      'package.json',
      'pnpm-lock.yaml',
      'workflows/package.json',
      'workflows/src/project.ts',
    ].map(name => [name, read(f.project, name)])
  );
  const result = f.run(['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(
    read(f.project, 'cli/src/cli.ts'),
    read(f.source, 'cli/src/cli.ts')
  );
  assert.equal(
    fs.existsSync(path.join(f.project, 'cli/src/custom-command.ts')),
    false
  );
  assert.equal(
    read(f.project, 'cli/node_modules/existing-install.txt'),
    'keep installed dependencies\n'
  );
  assert.equal(
    read(f.project, 'cli/src/sdk/schema.d.ts'),
    read(f.source, 'cli/src/sdk/schema.d.ts')
  );
  assert.equal(
    read(f.project, 'cli/schemas/openapi/Fixture.schema.json'),
    read(f.source, 'cli/schemas/openapi/Fixture.schema.json')
  );
  for (const [name, original] of Object.entries(originals))
    assert.equal(read(f.project, name), original);

  const backup = onlyBackup(f.project);
  assert.match(read(backup, 'previous/src/cli.ts'), /Customized locally/);
  assert.match(
    read(backup, 'previous/src/custom-command.ts'),
    /never committed/
  );
  assert.equal(
    read(backup, 'incoming/src/cli.ts'),
    read(f.source, 'cli/src/cli.ts')
  );
  assert.equal(
    fs.existsSync(path.join(backup, 'previous/node_modules')),
    false
  );
  assert.equal(fs.existsSync(path.join(backup, 'previous/dist')), false);
  assert.ok(read(backup, 'manifest.json').includes(f.sourceCommit));
  assert.ok(read(backup, 'agent-prompt.md').includes(f.project));
  assert.ok(read(backup, 'agent-prompt.md').includes(backup));
  assert.match(read(backup, 'agent-prompt.md'), /custom/i);
  assert.match(read(backup, 'agent-prompt.md'), /commit|push/i);
  assert.match(read(backup, 'report.md'), /custom-command/);
  assert.equal(git(f.project, 'check-ignore', backup), backup);
  const commands = read(f.root, 'commands.jsonl')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.ok(commands.some(args => args.includes('tsc')));
  assert.ok(
    commands.every(
      args => !args.includes('install') && !args.includes('generate')
    )
  );
});

test('replacement works when launched from the CLI being replaced', t => {
  const f = fixture(t);
  const result = f.run(['--yes'], {
    cwd: path.join(f.project, 'cli'),
    script: path.join(f.project, 'cli/bin/self-update.cjs'),
  });
  assert.equal(result.status, 0, result.output);
  assert.match(read(f.project, 'cli/src/cli.ts'), /incoming-template/);
  assert.ok(fs.existsSync(path.join(onlyBackup(f.project), 'restore.cjs')));
});

test('dependency changes block replacement even with --yes', t => {
  const f = fixture(t);
  const pkg = JSON.parse(read(f.source, 'cli/package.json'));
  pkg.devDependencies.typescript = '5.9.2';
  json(f.source, 'cli/package.json', pkg);
  commit(f.source);
  const before = read(f.project, 'cli/src/cli.ts');
  const lock = read(f.project, 'pnpm-lock.yaml');
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /typescript|dependenc/i);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.equal(read(f.project, 'pnpm-lock.yaml'), lock);
  assert.equal(fs.existsSync(f.trace), false);
});

for (const marker of ['BROKEN_BUILD', 'BROKEN_TEST']) {
  test(`failed validation (${marker}) restores previous source and reports failure`, t => {
    const f = fixture(t);
    write(f.source, 'cli/src/cli.ts', `// ${marker}\n`);
    commit(f.source);
    const before = read(f.project, 'cli/src/cli.ts');
    const custom = read(f.project, 'cli/src/custom-command.ts');
    const result = f.run(['--yes']);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(read(f.project, 'cli/src/cli.ts'), before);
    assert.equal(read(f.project, 'cli/src/custom-command.ts'), custom);
    assert.equal(
      read(f.project, 'cli/node_modules/existing-install.txt'),
      'keep installed dependencies\n'
    );
    assert.ok(fs.existsSync(path.join(onlyBackup(f.project), 'restore.cjs')));
  });
}

test('standalone restore recovers custom source even after the new updater is broken', t => {
  const f = fixture(t);
  const original = read(f.project, 'cli/src/cli.ts');
  const update = f.run(['--yes']);
  assert.equal(update.status, 0, update.output);
  const backup = onlyBackup(f.project);
  write(
    f.project,
    'cli/bin/self-update.cjs',
    "throw new Error('broken updater');\n"
  );
  const result = spawnSync(
    process.execPath,
    [path.join(backup, 'restore.cjs'), '--yes'],
    {
      cwd: f.root,
      env: f.env,
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(read(f.project, 'cli/src/cli.ts'), original);
  assert.match(read(f.project, 'cli/src/custom-command.ts'), /never committed/);
  assert.equal(
    read(f.project, 'cli/node_modules/existing-install.txt'),
    'keep installed dependencies\n'
  );
});

test('rollback selects the newest applied update and restores the preceding source', t => {
  const f = fixture(t);
  assert.equal(f.run(['--yes']).status, 0);
  const first = read(f.project, 'cli/src/cli.ts');
  write(f.source, 'cli/src/cli.ts', '// second incoming version\n');
  commit(f.source);
  const second = f.run(['--yes']);
  assert.equal(second.status, 0, second.output);
  assert.equal(backups(f.project).length, 2);
  const result = f.run(['--rollback', '--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), first);
});

test('untracked source symlinks block replacement without touching their target', t => {
  const f = fixture(t);
  write(f.root, 'outside.txt', 'outside source stays untouched\n');
  fs.symlinkSync(
    path.join(f.root, 'outside.txt'),
    path.join(f.project, 'cli/src/link.ts')
  );
  const before = read(f.project, 'cli/src/cli.ts');
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.ok(
    fs.lstatSync(path.join(f.project, 'cli/src/link.ts')).isSymbolicLink()
  );
  assert.equal(read(f.root, 'outside.txt'), 'outside source stays untouched\n');
  assert.equal(backups(f.project).length, 0);
});

test('upstream symlinks are rejected before local replacement', t => {
  const f = fixture(t);
  fs.symlinkSync('cli.ts', path.join(f.source, 'cli/src/alias.ts'));
  commit(f.source);
  const before = read(f.project, 'cli/src/cli.ts');
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.equal(backups(f.project).length, 0);
});

test('invalid upstream CLI cannot replace a working local CLI', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.source, 'cli/tsconfig.json'));
  commit(f.source);
  const before = read(f.project, 'cli/src/cli.ts');
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.equal(backups(f.project).length, 0);
});

test('an unavailable ref fails before modifying project source', t => {
  const f = fixture(t);
  const before = read(f.project, 'cli/src/cli.ts');
  const result = f.run(['--ref', 'missing-fixture-ref', '--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.equal(backups(f.project).length, 0);
});

test('local template input uses its committed revision instead of uncommitted edits', t => {
  const f = fixture(t);
  const committed = read(f.source, 'cli/src/cli.ts');
  write(
    f.source,
    'cli/src/cli.ts',
    '// This uncommitted edit must not be installed.\n'
  );
  const result = f.run(['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), committed);
  assert.ok(
    read(onlyBackup(f.project), 'manifest.json').includes(f.sourceCommit)
  );
});

test('a symlinked recovery location cannot redirect backup writes outside the project', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside-recovery');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.project, '.flow'));
  const before = read(f.project, 'cli/src/cli.ts');
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('protected directory names block replacement before their contents are backed up', t => {
  const f = fixture(t);
  // This is a harmless directory-name fixture, not an environment file.
  write(f.project, 'cli/.env/fixture.txt', 'ordinary fixture text\n');
  const before = read(f.project, 'cli/src/cli.ts');
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), before);
  assert.equal(backups(f.project).length, 0);
});

test('a CLI source file named __proto__ is preserved in the recovery inventory', t => {
  const f = fixture(t);
  write(
    f.project,
    'cli/__proto__',
    'custom source with an object-special filename\n'
  );
  const result = f.run(['--yes']);
  assert.equal(result.status, 0, result.output);
  const backup = onlyBackup(f.project);
  assert.equal(
    read(backup, 'previous/__proto__'),
    'custom source with an object-special filename\n'
  );
  const manifest = JSON.parse(read(backup, 'manifest.json'));
  assert.ok(Object.hasOwn(manifest.previous, '__proto__'));
  assert.match(manifest.previous.__proto__.hash, /^[a-f0-9]{64}$/);
});

for (const kind of ['missing', 'malformed']) {
  test(`standalone restore handles a ${kind} CLI manifest and retains current source`, t => {
    const f = fixture(t);
    const original = read(f.project, 'cli/src/cli.ts');
    const update = f.run(['--yes']);
    assert.equal(update.status, 0, update.output);
    const backup = onlyBackup(f.project);
    write(
      f.project,
      'cli/src/post-update-extension.ts',
      '// Keep this later customization in recovery.\n'
    );
    if (kind === 'missing')
      fs.unlinkSync(path.join(f.project, 'cli/package.json'));
    else write(f.project, 'cli/package.json', '{ deliberately invalid JSON\n');
    const result = spawnSync(
      process.execPath,
      [path.join(backup, 'restore.cjs'), '--yes'],
      {
        cwd: f.root,
        env: f.env,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(read(f.project, 'cli/src/cli.ts'), original);
    assert.equal(
      JSON.parse(read(f.project, 'cli/package.json')).name,
      'flow-cli'
    );
    assert.match(
      read(f.project, 'cli/src/custom-command.ts'),
      /never committed/
    );
    assert.equal(
      read(f.project, 'cli/node_modules/existing-install.txt'),
      'keep installed dependencies\n'
    );
    const retained = fs
      .readdirSync(backup)
      .filter(name => name.startsWith('before-rollback-'));
    assert.equal(retained.length, 1);
    assert.match(
      read(path.join(backup, retained[0]), 'src/post-update-extension.ts'),
      /later customization/
    );
    if (kind === 'missing') {
      assert.equal(
        fs.existsSync(path.join(backup, retained[0], 'package.json')),
        false
      );
    } else {
      assert.match(
        read(path.join(backup, retained[0]), 'package.json'),
        /deliberately invalid JSON/
      );
    }
  });
}

test('standalone rollback recovers an interrupted replacement with no live CLI directory', t => {
  const f = fixture(t);
  const original = read(f.project, 'cli/src/cli.ts');
  const update = f.run(['--yes']);
  assert.equal(update.status, 0, update.output);
  const backup = onlyBackup(f.project);
  fs.renameSync(path.join(f.project, 'cli'), path.join(backup, 'candidate'));
  fs.cpSync(
    path.join(backup, 'previous'),
    path.join(backup, 'previous-runtime'),
    { recursive: true }
  );
  const manifest = JSON.parse(read(backup, 'manifest.json'));
  manifest.status = 'applying';
  json(backup, 'manifest.json', manifest);
  const commandsBefore = read(f.root, 'commands.jsonl');
  const result = f.run(['--rollback', path.basename(backup), '--yes'], {
    script: path.join(backup, 'restore.cjs'),
    cwd: f.root,
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), original);
  assert.match(read(f.project, 'cli/src/custom-command.ts'), /never committed/);
  assert.equal(
    read(f.project, 'cli/node_modules/existing-install.txt'),
    'keep installed dependencies\n'
  );
  assert.match(read(backup, 'candidate/src/cli.ts'), /incoming-template/);
  assert.equal(fs.existsSync(path.join(backup, 'previous-runtime')), false);
  assert.equal(JSON.parse(read(backup, 'manifest.json')).status, 'rolled-back');
  assert.equal(
    read(f.root, 'commands.jsonl'),
    commandsBefore,
    'Recovery must not require compilation'
  );
});

test('an edit to the previous runtime during validation is preserved by automatic restoration', t => {
  const f = fixture(t);
  write(f.source, 'cli/src/cli.ts', '// LATE_PREVIOUS_EDIT\n');
  commit(f.source);
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /edited while checks were running/i);
  assert.equal(
    read(f.project, 'cli/src/cli.ts'),
    '// Late editor save while validation was running.\n'
  );
  assert.match(read(f.project, 'cli/src/custom-command.ts'), /never committed/);
  assert.equal(
    read(f.project, 'cli/node_modules/existing-install.txt'),
    'keep installed dependencies\n'
  );
  const backup = onlyBackup(f.project);
  assert.match(read(backup, 'previous/src/cli.ts'), /Customized locally/);
  assert.equal(
    JSON.parse(read(backup, 'manifest.json')).status,
    'failed-restored'
  );
});
