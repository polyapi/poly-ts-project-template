const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const updater = path.join(__dirname, 'self-update.cjs');
const manifestPlanner = path.join(__dirname, 'bootstrap-manifests.cjs');
const shell = path.join(__dirname, '../upgrade.sh');

function write(root, name, content) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function json(root, name, value) {
  write(root, name, `${JSON.stringify(value, null, 2)}\n`);
}

function read(root, name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function parse(root, name) {
  return JSON.parse(read(root, name));
}

function git(root, ...args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Bootstrap fixture',
      '-c',
      'user.email=bootstrap@example.invalid',
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
  git(root, 'commit', '--quiet', '-m', 'Synthetic bootstrap fixture');
  return git(root, 'rev-parse', 'HEAD');
}

function scaffold(root, incoming) {
  fs.mkdirSync(root, { recursive: true });
  write(root, '.gitignore', 'node_modules/\ndist/\n');
  write(root, 'pnpm-workspace.yaml', "packages:\n  - 'cli'\n  - 'workflows'\n");
  write(
    root,
    'pnpm-lock.yaml',
    "lockfileVersion: '9.0'\n# Preserve the project lockfile.\n"
  );
  json(
    root,
    'package.json',
    incoming
      ? {
          name: 'poly-ts-project-template',
          version: '1.0.0',
          private: true,
          scripts: {
            flow: 'pnpm --filter flow-cli',
            workflows:
              'ENVIRONMENT_SETUP_COMPLETE=true pnpm --filter workflows',
            test: 'template-tests',
          },
          devDependencies: { 'template-only': '9.0.0' },
        }
      : {
          name: 'enterprise-integrations',
          version: '7.4.2',
          private: true,
          scripts: {
            test: 'custom-test-command',
            deploy: 'custom-deploy-command',
          },
          dependencies: { 'customer-library': '2.3.4' },
          pnpm: { overrides: { 'customer-library': '2.3.4' } },
          customerMetadata: { owner: 'integration-team', labels: ['custom'] },
        }
  );
  json(
    root,
    'workflows/package.json',
    incoming
      ? {
          name: 'workflows',
          version: '1.0.0',
          scripts: {
            push: 'pnpm --filter flow-cli run build && node ../cli/dist/cli.js push',
            'push:dry-run':
              'pnpm --filter flow-cli run build && node ../cli/dist/cli.js push --dry-run',
            'train-openapi': 'pnpm --filter flow-cli run train-openapi',
            'train-model': 'pnpm --filter flow-cli run train-model',
            'delete-content': 'pnpm --filter flow-cli run delete-content',
            logs: 'pnpm --filter flow-cli run logs',
            'train:openapi': 'pnpm --filter flow-cli run train:openapi',
            'delete:content': 'pnpm --filter flow-cli run delete:content',
            test: 'template-workflow-tests',
          },
          dependencies: { polyapi: '9.9.9' },
          devDependencies: { 'flow-cli': 'workspace:*' },
          ava: { require: ['template-test-loader'] },
        }
      : {
          name: 'workflows',
          version: '4.3.2',
          scripts: {
            push: 'custom-protected-push-command',
            test: 'custom-workflow-tests',
            'customer-command': 'custom-task',
          },
          dependencies: {
            polyapi: '0.27.4',
            'customer-workflow-library': '3.2.1',
          },
          devDependencies: { 'flow-cli': 'workspace:*' },
          ava: { files: ['custom/**/*.test.ts'], require: ['custom-loader'] },
          customerMetadata: { team: 'customer-integration' },
        }
  );
  write(
    root,
    'workflows/src/customer.ts',
    '// Keep customer workflow source.\n'
  );
  json(root, 'cli/package.json', {
    name: 'flow-cli',
    version: incoming ? '1.1.0' : '1.0.0',
    private: true,
    scripts: incoming
      ? { build: 'tsc', 'self-update': 'node bin/self-update.cjs' }
      : { build: 'tsc' },
    devDependencies: { typescript: '5.8.3' },
  });
  json(root, 'cli/tsconfig.json', {
    compilerOptions: { rootDir: 'src', outDir: 'dist' },
  });
  write(
    root,
    'cli/src/cli.ts',
    incoming ? '// Current Flow CLI.\n' : '// Older customized Flow CLI.\n'
  );
  write(root, 'cli/bin/flow.js', "require('../dist/cli.js');\n");
  if (incoming) {
    fs.chmodSync(path.join(root, 'cli/bin/flow.js'), 0o755);
    write(root, 'cli/bin/self-update.cjs', fs.readFileSync(updater, 'utf8'));
    write(
      root,
      'cli/bin/bootstrap-manifests.cjs',
      fs.readFileSync(manifestPlanner, 'utf8')
    );
    write(root, 'cli/upgrade.sh', fs.readFileSync(shell, 'utf8'));
  }
  git(root, 'init', '--quiet', '-b', 'main');
  return commit(root);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'older project with spaces');
  const source = path.join(root, 'template with spaces');
  const bin = path.join(root, 'bin');
  const trace = path.join(root, 'unexpected-pnpm.txt');
  scaffold(project, false);
  const sourceCommit = scaffold(source, true);
  write(
    project,
    'cli/src/custom-command.ts',
    '// Local custom command, not committed.\n'
  );
  write(
    project,
    'cli/node_modules/installed-marker.txt',
    'existing installation\n'
  );
  write(project, 'cli/dist/cli.js', '// Old generated code.\n');
  write(
    bin,
    'pnpm',
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(97);\n`
  );
  fs.chmodSync(path.join(bin, 'pnpm'), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  for (const name of Object.keys(env)) {
    if (/^(POLY|API_KEY$|BASE_URL$|ENVPATH$)/.test(name)) delete env[name];
  }
  function execute(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      ...options,
    });
    return {
      ...result,
      output: `${result.stdout || ''}${result.stderr || ''}`,
    };
  }
  return {
    root,
    project,
    source,
    sourceCommit,
    trace,
    env,
    run(args = []) {
      return execute(process.execPath, [
        updater,
        '--bootstrap',
        '--project',
        project,
        '--source',
        source,
        ...args,
      ]);
    },
    piped(args = []) {
      return execute(
        'bash',
        ['-s', '--', '--project', project, '--source', source, ...args],
        { input: fs.readFileSync(shell, 'utf8') }
      );
    },
    restore(backup) {
      return execute(process.execPath, [
        path.join(backup, 'restore.cjs'),
        '--yes',
      ]);
    },
  };
}

function backups(project) {
  const directory = path.join(project, '.flow/updates');
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .map(name => path.join(directory, name))
    .filter(
      name =>
        fs.statSync(name).isDirectory() &&
        fs.existsSync(path.join(name, 'manifest.json'))
    )
    .sort();
}

function onlyBackup(project) {
  const directories = backups(project);
  assert.equal(directories.length, 1);
  return directories[0];
}

function snapshot(project) {
  return Object.fromEntries(
    [
      'package.json',
      'workflows/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'cli/src/cli.ts',
      'cli/src/custom-command.ts',
      'workflows/src/customer.ts',
    ].map(name => [name, read(project, name)])
  );
}

function assertUntouched(project, before) {
  for (const [name, content] of Object.entries(before))
    assert.equal(read(project, name), content, name);
}

test('bootstrap preview reports changes and conflicts without modifying the project', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const status = git(f.project, 'status', '--porcelain');
  const result = f.run(['--check']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(f.sourceCommit));
  assert.match(result.output, /Installed Flow version: 1\.0\.0/);
  assert.match(result.output, /Incoming Flow version: 1\.1\.0/);
  assert.match(result.output, /push|conflict/i);
  assertUntouched(f.project, before);
  assert.equal(git(f.project, 'status', '--porcelain'), status);
  assert.equal(backups(f.project).length, 0);
  assert.equal(fs.existsSync(f.trace), false);
});

test('bootstrap requires authorization when no terminal is available', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assertUntouched(f.project, before);
  assert.equal(backups(f.project).length, 0);
});

test('bootstrap replaces old CLI and adds missing launchers while preserving custom manifest values', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const rootBefore = parse(f.project, 'package.json');
  const workflowsBefore = parse(f.project, 'workflows/package.json');
  const result = f.run(['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(
    read(f.project, 'cli/src/cli.ts'),
    read(f.source, 'cli/src/cli.ts')
  );
  assert.ok(fs.existsSync(path.join(f.project, 'cli/bin/self-update.cjs')));
  assert.equal(
    fs.existsSync(path.join(f.project, 'cli/src/custom-command.ts')),
    false
  );
  assert.equal(
    read(f.project, 'cli/node_modules/installed-marker.txt'),
    'existing installation\n'
  );
  const rootAfter = parse(f.project, 'package.json');
  const workflowsAfter = parse(f.project, 'workflows/package.json');
  for (const [key, value] of Object.entries(rootBefore)) {
    if (key !== 'scripts')
      assert.deepEqual(rootAfter[key], value, `root ${key}`);
  }
  for (const [key, value] of Object.entries(workflowsBefore)) {
    if (key !== 'scripts')
      assert.deepEqual(workflowsAfter[key], value, `workflows ${key}`);
  }
  for (const [name, value] of Object.entries(rootBefore.scripts))
    assert.equal(rootAfter.scripts[name], value);
  for (const [name, value] of Object.entries(workflowsBefore.scripts))
    assert.equal(workflowsAfter.scripts[name], value);
  assert.equal(rootAfter.scripts.flow, 'pnpm --filter flow-cli');
  assert.equal(
    rootAfter.scripts.workflows,
    'ENVIRONMENT_SETUP_COMPLETE=true pnpm --filter workflows'
  );
  assert.equal(workflowsAfter.scripts.logs, 'pnpm --filter flow-cli run logs');
  assert.equal(read(f.project, 'pnpm-lock.yaml'), before['pnpm-lock.yaml']);
  assert.equal(
    read(f.project, 'pnpm-workspace.yaml'),
    before['pnpm-workspace.yaml']
  );
  assert.equal(
    read(f.project, 'workflows/src/customer.ts'),
    before['workflows/src/customer.ts']
  );
  const backup = onlyBackup(f.project);
  const manifest = parse(backup, 'manifest.json');
  assert.equal(manifest.previousVersion, '1.0.0');
  assert.equal(manifest.incomingVersion, '1.1.0');
  assert.match(result.output, /Flow CLI updated to version 1\.1\.0/);
  assert.equal(
    read(backup, 'previous/src/custom-command.ts'),
    before['cli/src/custom-command.ts']
  );
  assert.equal(
    read(backup, 'project-before/package.json'),
    before['package.json']
  );
  assert.equal(
    read(backup, 'project-before/workflows/package.json'),
    before['workflows/package.json']
  );
  assert.equal(
    read(backup, 'project-after/package.json'),
    read(f.project, 'package.json')
  );
  assert.equal(
    read(backup, 'project-after/workflows/package.json'),
    read(f.project, 'workflows/package.json')
  );
  assert.match(read(backup, 'agent-prompt.md'), /package|manifest/i);
  assert.match(read(backup, 'report.md'), /push/);
  assert.equal(
    fs.existsSync(f.trace),
    false,
    'Bootstrap must not build or install'
  );
});

test('bootstrap manifest additions are idempotent', t => {
  const f = fixture(t);
  const first = f.run(['--yes']);
  assert.equal(first.status, 0, first.output);
  const root = read(f.project, 'package.json');
  const workflows = read(f.project, 'workflows/package.json');
  const second = f.run(['--yes']);
  assert.equal(second.status, 0, second.output);
  assert.equal(read(f.project, 'package.json'), root);
  assert.equal(read(f.project, 'workflows/package.json'), workflows);
  assert.equal(fs.existsSync(f.trace), false);
});

test('existing custom root Flow alias remains intact and is reported for review', t => {
  const f = fixture(t);
  const pkg = parse(f.project, 'package.json');
  pkg.scripts.flow = 'custom-flow-wrapper';
  json(f.project, 'package.json', pkg);
  const result = f.run(['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(
    parse(f.project, 'package.json').scripts.flow,
    'custom-flow-wrapper'
  );
  assert.match(result.output, /flow/);
  assert.match(read(onlyBackup(f.project), 'report.md'), /flow/);
});

test('CLI dependency changes require explicit approval beyond --yes', t => {
  const f = fixture(t);
  const pkg = parse(f.source, 'cli/package.json');
  pkg.devDependencies.typescript = '5.9.2';
  json(f.source, 'cli/package.json', pkg);
  commit(f.source);
  const before = snapshot(f.project);
  const refused = f.run(['--yes']);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, /dependenc|approval/i);
  assertUntouched(f.project, before);
  assert.equal(backups(f.project).length, 0);
  const approved = f.run(['--yes', '--approve-dependency-changes']);
  assert.equal(approved.status, 0, approved.output);
  assert.equal(
    parse(f.project, 'cli/package.json').devDependencies.typescript,
    '5.9.2'
  );
  assert.equal(
    parse(f.project, 'workflows/package.json').dependencies.polyapi,
    '0.27.4'
  );
  assert.equal(read(f.project, 'pnpm-lock.yaml'), before['pnpm-lock.yaml']);
  assert.equal(fs.existsSync(f.trace), false);
  const restored = f.restore(onlyBackup(f.project));
  assert.equal(restored.status, 0, restored.output);
  assertUntouched(f.project, before);
  assert.equal(
    parse(f.project, 'cli/package.json').devDependencies.typescript,
    '5.8.3'
  );
});

test('independent rollback restores exact original manifest bytes and CLI customizations', t => {
  const f = fixture(t);
  write(
    f.project,
    'package.json',
    `${JSON.stringify(parse(f.project, 'package.json'), null, '\t')}\n\n`
  );
  write(
    f.project,
    'workflows/package.json',
    `${JSON.stringify(parse(f.project, 'workflows/package.json'))}\n`
  );
  const before = snapshot(f.project);
  const updated = f.run(['--yes']);
  assert.equal(updated.status, 0, updated.output);
  const restored = f.restore(onlyBackup(f.project));
  assert.equal(restored.status, 0, restored.output);
  assertUntouched(f.project, before);
  assert.equal(fs.existsSync(f.trace), false);
});

for (const filename of ['package.json', 'workflows/package.json']) {
  test(`rollback refuses to overwrite later edits to ${filename}`, t => {
    const f = fixture(t);
    const updated = f.run(['--yes']);
    assert.equal(updated.status, 0, updated.output);
    const modified = parse(f.project, filename);
    modified.afterUpgrade = 'Keep this later edit';
    json(f.project, filename, modified);
    const before = read(f.project, filename);
    const cli = read(f.project, 'cli/src/cli.ts');
    const result = f.restore(onlyBackup(f.project));
    assert.notEqual(result.status, 0, result.output);
    assert.equal(read(f.project, filename), before);
    assert.equal(read(f.project, 'cli/src/cli.ts'), cli);
  });
}

test('a script piped to bash upgrades a project without a pre-existing self-updater', t => {
  const f = fixture(t);
  assert.equal(
    fs.existsSync(path.join(f.project, 'cli/bin/self-update.cjs')),
    false
  );
  const result = f.piped(['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(
    read(f.project, 'cli/src/cli.ts'),
    read(f.source, 'cli/src/cli.ts')
  );
  assert.equal(
    parse(f.project, 'package.json').scripts.test,
    'custom-test-command'
  );
  assert.ok(
    read(onlyBackup(f.project), 'manifest.json').includes(f.sourceCommit)
  );
  assert.equal(fs.existsSync(f.trace), false);
});

test('piped bootstrap preview requires no terminal and leaves local files unchanged', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const result = f.piped(['--check']);
  assert.equal(result.status, 0, result.output);
  assertUntouched(f.project, before);
  assert.equal(backups(f.project).length, 0);
});

test('bootstrap preserves Git file modes so the installed updater reports no changes', t => {
  const f = fixture(t);
  assert.equal(
    fs.existsSync(path.join(f.project, 'cli/bin/self-update.cjs')),
    false
  );
  const updated = f.piped(['--yes']);
  assert.equal(updated.status, 0, updated.output);
  // upgrade.sh uses umask 077; fetched source must still retain Git's modes.
  assert.equal(
    fs.statSync(path.join(f.project, 'cli/package.json')).mode & 0o777,
    0o644
  );
  assert.equal(
    fs.statSync(path.join(f.project, 'cli/bin/flow.js')).mode & 0o777,
    0o755
  );
  const root = read(f.project, 'package.json');
  const workflows = read(f.project, 'workflows/package.json');
  const cli = read(f.project, 'cli/src/cli.ts');
  const backupDirectories = backups(f.project);
  const preview = spawnSync(
    'bash',
    [
      '-c',
      'umask 022; exec "$@"',
      'flow-update-preview',
      process.execPath,
      path.join(f.project, 'cli/bin/self-update.cjs'),
      '--check',
      '--source',
      f.source,
    ],
    {
      cwd: f.project,
      env: f.env,
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  const output = `${preview.stdout || ''}${preview.stderr || ''}`;
  assert.equal(preview.status, 0, output);
  assert.match(output, new RegExp(f.sourceCommit));
  assert.doesNotMatch(output, /^(ADD|REPLACE|REMOVE) cli\//m);
  assert.equal(read(f.project, 'package.json'), root);
  assert.equal(read(f.project, 'workflows/package.json'), workflows);
  assert.equal(read(f.project, 'cli/src/cli.ts'), cli);
  assert.deepEqual(backups(f.project), backupDirectories);
  assert.equal(fs.existsSync(f.trace), false);
});

test('invalid project manifest is rejected before replacing the CLI', t => {
  const f = fixture(t);
  write(f.project, 'workflows/package.json', '{ invalid fixture JSON\n');
  const before = snapshot(f.project);
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assertUntouched(f.project, before);
  assert.equal(backups(f.project).length, 0);
});

test('a missing upstream ref leaves manifests and CLI source unchanged', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const result = f.piped(['--ref', 'not-a-real-fixture-ref', '--yes']);
  assert.notEqual(result.status, 0, result.output);
  assertUntouched(f.project, before);
  assert.equal(backups(f.project).length, 0);
});

test('bootstrap uses committed source without copying dirty template changes', t => {
  const f = fixture(t);
  write(
    f.source,
    'cli/src/cli.ts',
    '// Uncommitted source must not be installed.\n'
  );
  const pkg = parse(f.source, 'package.json');
  pkg.scripts.flow = 'uncommitted-template-command';
  json(f.source, 'package.json', pkg);
  const result = f.piped(['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(read(f.project, 'cli/src/cli.ts'), '// Current Flow CLI.\n');
  assert.equal(
    parse(f.project, 'package.json').scripts.flow,
    'pnpm --filter flow-cli'
  );
});

test('a partial manifest-write failure restores both manifests and the old CLI', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const preload = path.join(f.root, 'fail-workflow-manifest.cjs');
  write(
    f.root,
    'fail-workflow-manifest.cjs',
    `const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (to === ${JSON.stringify(fs.realpathSync(path.join(f.project, 'workflows/package.json')))} && String(from).includes('.flow-')) {
    throw new Error('Synthetic second-manifest write failure');
  }
  return rename.apply(this, arguments);
};
`
  );
  f.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assertUntouched(f.project, before);
  assert.equal(
    read(f.project, 'cli/node_modules/installed-marker.txt'),
    'existing installation\n'
  );
  assert.equal(fs.existsSync(f.trace), false);
});

test('an edit between manifest writes is preserved while updater changes and CLI replacement are reverted', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const workflows = parse(f.project, 'workflows/package.json');
  workflows.customerMetadata.concurrentEdit = 'Preserve this developer edit';
  const edited = `${JSON.stringify(workflows, null, 2)}\n`;
  const rootManifest = fs.realpathSync(path.join(f.project, 'package.json'));
  const workflowManifest = fs.realpathSync(
    path.join(f.project, 'workflows/package.json')
  );
  const preload = path.join(f.root, 'edit-second-manifest.cjs');
  write(
    f.root,
    'edit-second-manifest.cjs',
    `const fs = require('node:fs');
const rename = fs.renameSync;
let injected = false;
fs.renameSync = function(from, to) {
  const result = rename.apply(this, arguments);
  if (!injected && to === ${JSON.stringify(rootManifest)} && String(from).includes('.flow-')) {
    injected = true;
    fs.writeFileSync(${JSON.stringify(workflowManifest)}, ${JSON.stringify(edited)});
  }
  return result;
};
`
  );
  f.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'workflows/package.json'), edited);
  const { 'workflows/package.json': _workflowsBefore, ...untouched } = before;
  assertUntouched(f.project, untouched);
  assert.equal(
    read(f.project, 'cli/node_modules/installed-marker.txt'),
    'existing installation\n'
  );
  assert.notEqual(
    parse(onlyBackup(f.project), 'manifest.json').status,
    'applied'
  );
  assert.equal(fs.existsSync(f.trace), false);
});

test('interrupted bootstrap restores a mixed pair of manifests with the previous CLI runtime', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const updated = f.run(['--yes']);
  assert.equal(updated.status, 0, updated.output);
  const backup = onlyBackup(f.project);
  fs.cpSync(
    path.join(backup, 'previous'),
    path.join(backup, 'previous-runtime'),
    {
      recursive: true,
    }
  );
  write(f.project, 'package.json', before['package.json']);
  const manifest = parse(backup, 'manifest.json');
  manifest.status = 'applying';
  manifest.transaction = 'update';
  json(backup, 'manifest.json', manifest);
  const recovered = f.restore(backup);
  assert.equal(recovered.status, 0, recovered.output);
  assertUntouched(f.project, before);
  assert.equal(parse(backup, 'manifest.json').status, 'rolled-back');
  assert.equal(
    read(f.project, 'cli/node_modules/installed-marker.txt'),
    'existing installation\n'
  );
});

test('interrupted rollback recovers a consistent installed update before a retry restores the original', t => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const updated = f.run(['--yes']);
  assert.equal(updated.status, 0, updated.output);
  const backup = onlyBackup(f.project);
  const installedRoot = read(f.project, 'package.json');
  const installedWorkflows = read(f.project, 'workflows/package.json');
  const installedCli = read(f.project, 'cli/src/cli.ts');
  fs.renameSync(
    path.join(f.project, 'cli'),
    path.join(backup, 'previous-runtime')
  );
  fs.cpSync(path.join(backup, 'previous'), path.join(f.project, 'cli'), {
    recursive: true,
  });
  fs.renameSync(
    path.join(backup, 'previous-runtime/node_modules'),
    path.join(f.project, 'cli/node_modules')
  );
  write(f.project, 'package.json', before['package.json']);
  const manifest = parse(backup, 'manifest.json');
  manifest.status = 'applying';
  manifest.transaction = 'rollback';
  json(backup, 'manifest.json', manifest);

  const recovered = f.restore(backup);
  assert.equal(recovered.status, 0, recovered.output);
  assert.equal(read(f.project, 'package.json'), installedRoot);
  assert.equal(read(f.project, 'workflows/package.json'), installedWorkflows);
  assert.equal(read(f.project, 'cli/src/cli.ts'), installedCli);
  assert.equal(parse(backup, 'manifest.json').status, 'applied');
  assert.equal(
    read(f.project, 'cli/node_modules/installed-marker.txt'),
    'existing installation\n'
  );

  const retried = f.restore(backup);
  assert.equal(retried.status, 0, retried.output);
  assertUntouched(f.project, before);
});

test('bootstrap rejects a project-manifest symlink without changing its target', t => {
  const f = fixture(t);
  const content = read(f.project, 'workflows/package.json');
  const cli = read(f.project, 'cli/src/cli.ts');
  const outside = path.join(f.root, 'outside-package.json');
  fs.writeFileSync(outside, content);
  fs.unlinkSync(path.join(f.project, 'workflows/package.json'));
  fs.symlinkSync(outside, path.join(f.project, 'workflows/package.json'));
  const result = f.run(['--yes']);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(fs.readFileSync(outside, 'utf8'), content);
  assert.equal(read(f.project, 'cli/src/cli.ts'), cli);
  assert.equal(backups(f.project).length, 0);
});

test('rollback rejects altered manifest backups before touching project files', t => {
  const f = fixture(t);
  const updated = f.run(['--yes']);
  assert.equal(updated.status, 0, updated.output);
  const backup = onlyBackup(f.project);
  const root = read(f.project, 'package.json');
  const workflows = read(f.project, 'workflows/package.json');
  const cli = read(f.project, 'cli/src/cli.ts');
  write(backup, 'project-before/package.json', '{"altered":true}\n');
  const result = f.restore(backup);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(read(f.project, 'package.json'), root);
  assert.equal(read(f.project, 'workflows/package.json'), workflows);
  assert.equal(read(f.project, 'cli/src/cli.ts'), cli);
});
