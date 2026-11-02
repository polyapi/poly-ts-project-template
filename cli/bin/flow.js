#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

// The version must be available before dependencies or compiled output exist.
if (['--version', '-V'].includes(process.argv[2])) {
  console.log(`Flow CLI ${require('../package.json').version}`);
  process.exit(0);
}

// Updating and recovery must work before TypeScript has been built.
if (process.argv[2] === 'self-update') {
  const update = spawnSync(
    process.execPath,
    [path.join(__dirname, 'self-update.cjs'), ...process.argv.slice(3)],
    { stdio: 'inherit' }
  );
  if (update.error) console.error(update.error.message);
  process.exit(update.status ?? 1);
}

const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

if (!existsSync(cliPath)) {
  console.error('Flow CLI has not been built yet.');
  console.error('Run: pnpm --filter flow-cli run build');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [cliPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
  }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
