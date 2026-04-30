#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

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
