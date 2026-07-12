import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'ava';

const COMMON_DIR = path.resolve(__dirname);
const DEPLOYABLE_FUNCTIONS = [
  'client/log.ts',
  'client/sendAlert.ts',
  'server/errorAlerts.ts',
];

for (const relativePath of DEPLOYABLE_FUNCTIONS) {
  test(`${relativePath} is a standalone PolyAPI function`, async t => {
    const source = await readFile(path.join(COMMON_DIR, relativePath), 'utf8');

    t.regex(source, /from 'polyapi'/);
    t.notRegex(source, /from ['"]\.\.?\//);
  });
}
