const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const typescript = path.join(root, 'workflows/node_modules/typescript');
const ts = require(typescript);
const realGit = process.env.PATH.split(path.delimiter)
  .map(directory => path.join(directory, 'git'))
  .find(file => fs.existsSync(file));
const launcher = fs
  .readFileSync(path.join(root, 'README.md'), 'utf8')
  .match(/```zsh\n(newpolyts\(\)[\s\S]*?)\n```/)[1];
const source = `
// Keep example.documentation and external SDK references unchanged.
const config = { context: 'example.utilities', functionContext: 'example.linked' };
const description = 'example.description';
let poly, vari;
function mockModule(name, mock) { poly = mock.default; vari = mock.vari; }
mockModule('polyapi', {
  default: { example: { utilities: { value: 5 } }, OOB: { value: 1 } },
  vari: { example: { settings: { value: 7 } } }
});
globalThis.result = poly.example.utilities.value + vari.example.settings.value;
`;

function write(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode ? { mode } : undefined);
}

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'poly-kickstart-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const template = path.join(temp, 'fixtures/template');
  const skills = path.join(temp, 'fixtures/skills');
  write(
    path.join(template, 'package.json'),
    '{"name":"poly-ts-project-template"}\n'
  );
  write(
    path.join(template, 'kickstart.sh'),
    `#!/usr/bin/env bash
set -eu
read -r answer
[[ "$answer" == continue ]]
printf 'launched\n' >> "$TEST_TRACE"
exit "\${TEST_BOOTSTRAP_EXIT:-0}"
`
  );
  write(path.join(template, '.gitignore'), '*.env\nnode_modules\n');
  write(
    path.join(template, 'workflows/src/config.json'),
    JSON.stringify(
      {
        context: 'example.utilities',
        nested: {
          webhookContext: 'example.webhook',
          variableContext: 'example.variable',
        },
        description: 'example.description',
        path: 'example',
        externalContext: 'polyapi.public',
      },
      null,
      2
    )
  );
  write(path.join(template, 'workflows/src/main.ts'), source);
  write(
    path.join(template, 'scripts/kickstart-namespace.cjs'),
    fs.readFileSync(path.join(root, 'scripts/kickstart-namespace.cjs'))
  );
  for (const category of ['general', 'polyapi-common', 'polyapi-typescript']) {
    write(
      path.join(skills, category, `skills/${category}/SKILL.md`),
      `# ${category}\n`
    );
  }
  for (const [name, directory] of [
    ['template', template],
    ['skills', skills],
  ]) {
    const result = spawnSync(
      'tar',
      [
        '-czf',
        path.join(temp, `${name}.tgz`),
        '-C',
        path.dirname(directory),
        path.basename(directory),
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
  }
  const bin = path.join(temp, 'bin');
  write(
    path.join(bin, 'curl'),
    `#!/usr/bin/env bash
set -eu
destination=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output|-o) destination="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
[[ -z "\${TEST_FAIL_DOWNLOAD:-}" ]] || exit 22
case "$url" in
  https://raw.githubusercontent.com/polyapi/poly-ts-project-template/main/kickstart.sh)
    cp "$TEST_ROOT/fixtures/template/kickstart.sh" "$destination" ;;
  https://codeload.github.com/polyapi/poly-ts-project-template/tar.gz/refs/heads/main)
    cp "$TEST_ROOT/template.tgz" "$destination" ;;
  https://codeload.github.com/polyapi/poly-skills/tar.gz/refs/heads/main)
    cp "$TEST_ROOT/skills.tgz" "$destination" ;;
  *) exit 23 ;;
esac
`,
    0o755
  );
  write(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env bash
set -eu
if [[ "$*" == install ]]; then
  printf 'install\n' >> "$TEST_TRACE"
  if [[ "\${TEST_FAIL_STEP:-}" == interrupt ]]; then
    kill -TERM "$PPID"
    exit 1
  fi
  [[ "\${TEST_FAIL_STEP:-}" != install ]] || exit 1
  mkdir -p workflows/node_modules
  ln -s "$TEST_TYPESCRIPT" workflows/node_modules/typescript
elif [[ "$1 $2 $3" == '--filter workflows add' ]]; then
  [[ "$4" == "polyapi@$TEST_TAG" ]] || exit 24
  printf 'sdk\n' >> "$TEST_TRACE"
  [[ "\${TEST_FAIL_STEP:-}" != sdk ]] || exit 1
elif [[ "$1 $2 $3 $4 $5" == '--silent workflows exec poly setup' ]]; then
  [[ "$6" == "https://$TEST_ENV.polyapi.io" && "$7" == placeholder-test-key ]] || exit 25
  [[ "$POLY_API_BASE_URL" == "$6" && "$POLY_API_KEY" == "$7" ]] || exit 26
  printf 'setup\n' >> "$TEST_TRACE"
  [[ "\${TEST_FAIL_STEP:-}" != setup ]] || exit 1
elif [[ "$*" == '--silent workflows exec poly generate' ]]; then
  [[ "$POLY_API_BASE_URL" == "https://$TEST_ENV.polyapi.io" && "$POLY_API_KEY" == placeholder-test-key ]] || exit 27
  printf 'generate\n' >> "$TEST_TRACE"
  [[ "\${TEST_FAIL_STEP:-}" != generate ]] || exit 1
else
  exit 28
fi
`,
    0o755
  );
  write(
    path.join(bin, 'code'),
    `#!/usr/bin/env bash
set -eu
[[ "$1" == . && "$(git branch --show-current)" == develop ]]
[[ -z "\${POLY_API_KEY:-}" ]]
printf 'code\n' >> "$TEST_TRACE"
`,
    0o755
  );
  fs.mkdirSync(path.join(temp, 'downloads'));
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: path.join(temp, 'home'),
    TMPDIR: path.join(temp, 'downloads'),
    POLY_API_KEY: '',
    POLY_API_BASE_URL: '',
    TEST_ROOT: temp,
    TEST_TRACE: path.join(temp, 'trace'),
    TEST_TYPESCRIPT: typescript,
    TEST_REAL_GIT: realGit,
    TEST_ENV: 'eu1',
    TEST_TAG: 'eu1',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Kickstart Test',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'kickstart@example.invalid',
    GIT_CONFIG_KEY_2: 'commit.gpgsign',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'core.hooksPath',
    GIT_CONFIG_VALUE_3: path.join(temp, 'no-hooks'),
  };
  function run(inputs, overrides = {}, useLauncher = false) {
    const executable = useLauncher ? '/bin/zsh' : '/bin/bash';
    const args = useLauncher
      ? ['-f', '-c', `${launcher}\nnewpolyts`]
      : [path.join(root, 'kickstart.sh')];
    const result = spawnSync(executable, args, {
      cwd: temp,
      env: { ...env, ...overrides },
      input: inputs,
      encoding: 'utf8',
    });
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes('placeholder-test-key')
    );
    assert.deepEqual(fs.readdirSync(path.join(temp, 'downloads')), []);
    return result;
  }
  function git(project, ...args) {
    const result = spawnSync('git', args, {
      cwd: project,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  return { temp, env, run, git };
}

function mockSshClone(f) {
  write(
    path.join(f.temp, 'bin/git'),
    `#!/usr/bin/env bash
set -eu
if [[ "$1" == clone ]]; then
  for argument in "$@"; do
    case "$argument" in
      git@github.com:polyapi/poly-ts-project-template.git) repo=template ;;
      git@github.com:polyapi/poly-skills.git) repo=skills ;;
    esac
  done
  destination="\${!#}"
  mkdir -p "$destination/.git"
  cp -R "$TEST_ROOT/fixtures/$repo/." "$destination/"
else
  exec "$TEST_REAL_GIT" "$@"
fi
`,
    0o755
  );
}

test('default destination and namespace, exact env, skills, Git branches, and cleanup', t => {
  const f = fixture(t);
  const result = f.run('demo-project\n\n\nplaceholder-test-key\neu1\n');
  assert.equal(result.status, 0, result.stderr);
  const project = path.join(f.env.HOME, 'Code/poly/demo-project');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).name,
    'demo-project'
  );
  const envFile = path.join(project, 'workflows/dev.env');
  assert.equal(
    fs.readFileSync(envFile, 'utf8'),
    'POLYAPI_NAMESPACE=demo\nBASE_URL=https://eu1.polyapi.io\nAPI_KEY=placeholder-test-key\n# POLYPROD_EXEC_KEY\n\nLOG_LEVEL=debug\nSLACK_CHANNEL_ID=alerts-demos\n\n# Optional Flow CLI settings\nGIT_PROD_BRANCH=main:prod.env\nGIT_PROD_SKIP_BRANCHES=develop:dev.env\n'
  );
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  for (const category of ['general', 'polyapi-common', 'polyapi-typescript']) {
    assert.ok(
      fs.existsSync(path.join(project, '.agents/skills', category, 'SKILL.md'))
    );
  }
  assert.equal(f.git(project, 'branch', '--show-current'), 'develop');
  assert.equal(
    f.git(project, 'rev-parse', 'main'),
    f.git(project, 'rev-parse', 'develop')
  );
  assert.equal(f.git(project, 'log', '-1', '--format=%s'), 'Initial commit');
  assert.equal(f.git(project, 'status', '--porcelain'), '');
  assert.equal(f.git(project, 'ls-files', 'workflows/dev.env'), '');
  assert.equal(
    fs.readFileSync(f.env.TEST_TRACE, 'utf8'),
    'install\nsdk\nsetup\ngenerate\ncode\n'
  );
});

test('custom destination, dotted/hyphenated namespace, linked contexts and working SDK mocks', t => {
  const f = fixture(t);
  const parent = path.join(f.temp, 'projects with spaces');
  const result = f.run(
    `custom\n${parent}\ncustomer.demo-app\nplaceholder-test-key\ndev\n`,
    {
      TEST_ENV: 'dev',
      TEST_TAG: 'develop',
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const project = path.join(parent, 'custom');
  const config = JSON.parse(
    fs.readFileSync(path.join(project, 'workflows/src/config.json'))
  );
  assert.equal(config.context, 'customer.demo-app.utilities');
  assert.equal(config.nested.webhookContext, 'customer.demo-app.webhook');
  assert.equal(config.nested.variableContext, 'customer.demo-app.variable');
  assert.equal(config.description, 'example.description');
  assert.equal(config.path, 'example');
  assert.equal(config.externalContext, 'polyapi.public');
  const renamed = fs.readFileSync(
    path.join(project, 'workflows/src/main.ts'),
    'utf8'
  );
  assert.ok(renamed.includes('example.documentation'));
  const sandbox = {};
  vm.runInNewContext(
    ts.transpileModule(renamed, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    sandbox
  );
  assert.equal(sandbox.result, 12);
});

test('input validation reprompts without overwriting an existing project', t => {
  const f = fixture(t);
  const occupied = path.join(f.temp, 'occupied');
  write(path.join(occupied, 'demo/sentinel'), 'keep');
  const result = f.run(
    `../invalid\ndemo\n${occupied}\nrelative\nbad..namespace\n\n\nplaceholder-test-key\ninvalid-env\nna2\n`,
    {
      TEST_ENV: 'na2',
      TEST_TAG: 'na2',
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(occupied, 'demo/sentinel'), 'utf8'),
    'keep'
  );
  assert.ok(fs.existsSync(path.join(f.temp, 'relative/demo/.git')));
});

for (const step of ['install', 'sdk', 'setup', 'generate', 'interrupt']) {
  test(`${step} failure stops Git and VS Code, preserves project, and removes downloads`, t => {
    const f = fixture(t);
    const result = f.run('failed\n\n\nplaceholder-test-key\neu1\n', {
      TEST_FAIL_STEP: step,
    });
    assert.notEqual(result.status, 0);
    const project = path.join(f.env.HOME, 'Code/poly/failed');
    assert.ok(fs.existsSync(path.join(project, 'package.json')));
    assert.ok(!fs.existsSync(path.join(project, '.git')));
    assert.ok(!fs.readFileSync(f.env.TEST_TRACE, 'utf8').includes('code'));
    assert.match(result.stderr, /Project retained/);
  });
}

test('failed HTTPS and SSH downloads stop before creating the project and clean temporary files', t => {
  const f = fixture(t);
  write(path.join(f.temp, 'bin/git'), '#!/usr/bin/env bash\nexit 1\n', 0o755);
  const result = f.run('failed\n\n\nplaceholder-test-key\neu1\n', {
    TEST_FAIL_DOWNLOAD: '1',
  });
  assert.notEqual(result.status, 0);
  assert.ok(!fs.existsSync(path.join(f.env.HOME, 'Code/poly/failed')));
  assert.ok(!fs.existsSync(f.env.TEST_TRACE));
});

test('SSH fallback creates a fresh project without retaining downloaded Git history', t => {
  const f = fixture(t);
  mockSshClone(f);
  const result = f.run('private\n\n\nplaceholder-test-key\nna1\n', {
    TEST_FAIL_DOWNLOAD: '1',
    TEST_ENV: 'na1',
    TEST_TAG: 'na1',
  });
  assert.equal(result.status, 0, result.stderr);
  const project = path.join(f.env.HOME, 'Code/poly/private');
  assert.equal(f.git(project, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(f.git(project, 'branch', '--show-current'), 'develop');
});

for (const [name, overrides] of [
  ['HTTPS', {}],
  ['SSH fallback', { TEST_FAIL_DOWNLOAD: '1' }],
  ['failed bootstrap', { TEST_BOOTSTRAP_EXIT: '17' }],
]) {
  test(`small launcher preserves interactive input and cleans up: ${name}`, t => {
    const f = fixture(t);
    mockSshClone(f);
    const result = f.run('continue\n', overrides, true);
    assert.equal(
      result.status,
      Number(overrides.TEST_BOOTSTRAP_EXIT || 0),
      result.stderr
    );
    assert.equal(fs.readFileSync(f.env.TEST_TRACE, 'utf8'), 'launched\n');
  });
}
