const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const toolchain = path.join(__dirname, 'toolchain.sh');
const SYSTEM_TOOLS = [
  'bash',
  'cat',
  'chmod',
  'env',
  'grep',
  'mkdir',
  'mktemp',
  'rm',
  'sh',
  'tr',
  'uname',
];

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// A stub pnpm records its calls and installs a stub Node.js 24 for `env use`.
// KICKSTART_TEST_NODE_FAILS makes the LTS (`lts`) or every version (`always`)
// fail to start the way official builds do without libatomic.
const PNPM_STUB = `
echo "pnpm $*" >> "$KICKSTART_TEST_LOG"
case "$1" in
  --version) echo 10.0.0 ;;
  env)
    case "$4:\${KICKSTART_TEST_NODE_FAILS:-}" in
      lts:lts | *:always)
        cat > "$PNPM_HOME/node" <<'NODE'
#!/bin/sh
echo 'node: error while loading shared libraries: libatomic.so.1: cannot open shared object file' >&2
exit 127
NODE
        ;;
      *)
        cat > "$PNPM_HOME/node" <<'NODE'
#!/bin/sh
echo 24
NODE
        ;;
    esac
    chmod +x "$PNPM_HOME/node" ;;
esac`;

/**
 * Run toolchain.sh with only stub tools and a minimal set of system tools on
 * PATH, so a real Node.js or pnpm on the machine cannot affect the result.
 */
function fixture(t, { node, pnpm }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kickstart-toolchain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(log, '');
  for (const tool of SYSTEM_TOOLS) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], {
      encoding: 'utf8',
    }).stdout.trim();
    assert.ok(found, `missing system tool: ${tool}`);
    fs.symlinkSync(found, path.join(bin, tool));
  }
  if (node) executable(path.join(bin, 'node'), `echo ${node}`);
  if (pnpm) executable(path.join(bin, 'pnpm'), PNPM_STUB);
  // The stub installer creates pnpm where the real installer would.
  executable(
    path.join(bin, 'curl'),
    `echo "curl $*" >> "$KICKSTART_TEST_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then out="$2"; fi
  shift
done
cat > "$out" <<'INSTALLER'
echo "installer PNPM_VERSION=$PNPM_VERSION" >> "$KICKSTART_TEST_LOG"
mkdir -p "$XDG_DATA_HOME/pnpm"
cat > "$XDG_DATA_HOME/pnpm/pnpm" <<'PNPM'
#!/bin/sh${PNPM_STUB}
PNPM
chmod +x "$XDG_DATA_HOME/pnpm/pnpm"
INSTALLER`
  );

  return {
    log: () => fs.readFileSync(log, 'utf8'),
    run(answer = '', extraEnv = {}) {
      return spawnSync(
        path.join(bin, 'bash'),
        [
          '-c',
          `set -euo pipefail
source "$TOOLCHAIN"
exec 3<<<"$KICKSTART_TEST_ANSWER"
ensure_toolchain
echo "installed=$toolchain_installed"
echo "node=$(node -p 'process.versions.node.split(".")[0]')"`,
        ],
        {
          encoding: 'utf8',
          env: {
            HOME: root,
            PATH: bin,
            TMPDIR: root,
            XDG_DATA_HOME: path.join(root, 'data'),
            TOOLCHAIN: toolchain,
            KICKSTART_TEST_LOG: log,
            KICKSTART_TEST_ANSWER: answer,
            ...extraEnv,
          },
          timeout: 10_000,
        }
      );
    },
  };
}

test('a supported Node.js and pnpm are left untouched', t => {
  const f = fixture(t, { node: '24', pnpm: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed=false\nnode=24/);
  assert.doesNotMatch(f.log(), /curl|installer|env use/);
});

test('missing pnpm and Node.js are installed per user with the pinned pnpm', t => {
  const f = fixture(t, { node: null, pnpm: false });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed=true\nnode=24/);
  const log = f.log();
  assert.match(log, /curl .*--proto =https https:\/\/get\.pnpm\.io\/install\.sh/);
  assert.match(log, /installer PNPM_VERSION=10\.0\.0/);
  assert.match(log, /pnpm env use --global lts/);
  assert.doesNotMatch(log, /pnpm setup/);
});

test('an unsupported Node.js is replaced only after an explicit yes', t => {
  const declined = fixture(t, { node: '20', pnpm: true });
  const refused = declined.run('');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Node\.js 20 is older|Install the current Node\.js LTS now\? \[y\/N\]/);
  assert.match(refused.stderr, /Node\.js 22 or newer is required/);
  assert.doesNotMatch(declined.log(), /env use/);

  const accepted = fixture(t, { node: '20', pnpm: true });
  const result = accepted.run('maybe\ny');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Answer y or n\./);
  assert.match(result.stdout, /installed=true\nnode=24/);
  // A pnpm from npm or Homebrew gets a global directory before `pnpm env`.
  assert.match(accepted.log(), /pnpm setup\npnpm env use --global lts/);
});

test('declining to replace an old Node.js installs nothing, not even pnpm', t => {
  const declined = fixture(t, { node: '20', pnpm: false });
  const refused = declined.run('n');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Node\.js 22 or newer is required/);
  assert.equal(declined.log(), '');

  const accepted = fixture(t, { node: '20', pnpm: false });
  const result = accepted.run('y');
  assert.equal(result.status, 0, result.stderr);
  // One question covers both installs.
  assert.equal(result.stderr.match(/\[y\/N\]/g)?.length, 1);
  assert.match(accepted.log(), /installer PNPM_VERSION=10\.0\.0[\s\S]*pnpm env use --global lts/);
});

test('an LTS that needs the missing libatomic falls back to Node.js 24', t => {
  const f = fixture(t, { node: null, pnpm: false });
  const result = f.run('', { KICKSTART_TEST_NODE_FAILS: 'lts' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /needs the system library libatomic/);
  assert.match(result.stdout, /pnpm env use --global lts`\.\ninstalled=true\nnode=24/);
  assert.match(f.log(), /pnpm env use --global lts\npnpm env use --global 24/);
});

test('a Node.js that cannot start reports its own error', t => {
  const f = fixture(t, { node: null, pnpm: false });
  const result = f.run('', { KICKSTART_TEST_NODE_FAILS: 'always' });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /the installed Node\.js cannot start: node: error while loading shared libraries: libatomic\.so\.1/
  );
  assert.doesNotMatch(result.stdout, /To use the current LTS later/);
});
