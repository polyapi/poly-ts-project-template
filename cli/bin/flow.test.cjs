const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('version flags work without dependencies or a build and follow the package version', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(path.join(__dirname, 'flow.js'), path.join(root, 'bin/flow.js'));
  const pkg = path.join(root, 'package.json');
  for (const version of ['1.1.0', '1.2.3']) {
    fs.writeFileSync(pkg, JSON.stringify({ version }));
    for (const flag of ['--version', '-V']) {
      const result = spawnSync(process.execPath, [path.join(root, 'bin/flow.js'), flag], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), `Flow CLI ${version}`);
      assert.equal(result.stderr, '');
    }
  }
});
