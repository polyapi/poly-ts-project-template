import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'ava';

// Pin how the webhook reaches motdServer. These checks need no credentials and
// make no PolyAPI requests.

const ARTEFACTS = path.resolve(__dirname, '../artefacts');
const readJson = (file: string) =>
  JSON.parse(readFileSync(path.join(ARTEFACTS, file), 'utf8'));
const WEBHOOK = readJson('webhooks/motdWebhook.json');
const TRIGGERS = readdirSync(path.join(ARTEFACTS, 'triggers'))
  .filter(file => file.endsWith('.json'))
  .map(file => ({ file, content: readJson(`triggers/${file}`) }));

test('the webhook is bound directly to motdServer', t => {
  t.deepEqual(WEBHOOK.serverFunction, {
    functionName: 'motdServer',
    functionContext: WEBHOOK.context,
  });
  t.regex(
    readFileSync(path.resolve(__dirname, 'motdServer.ts'), 'utf8'),
    new RegExp(`context: '${WEBHOOK.context.replace(/\./g, '\\.')}'`)
  );
});

test('no trigger uses the bound webhook as its source', t => {
  // A bound webhook skips its triggers, and Flow rejects the combination.
  t.deepEqual(
    TRIGGERS.filter(
      ({ content }) =>
        content.source?.webhookName === WEBHOOK.name &&
        content.source?.webhookContext === WEBHOOK.context
    ).map(({ file }) => file),
    []
  );
});

test('the platform error trigger still covers the webhook path', t => {
  t.deepEqual(
    TRIGGERS.map(({ file }) => file),
    ['motdErrorHandlerTrigger.json']
  );
  const trigger = TRIGGERS[0].content;
  t.is(trigger.errorHandler.path, `/apis/${WEBHOOK.slug}/${WEBHOOK.subpath}`);
  t.deepEqual(trigger.destination, {
    functionName: 'motdErrorHandler',
    functionContext: WEBHOOK.context,
  });
});
