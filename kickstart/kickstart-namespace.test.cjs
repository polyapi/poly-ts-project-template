const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const test = require('node:test');

const templateRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'kickstart-namespace.cjs');
const tsPath = path.join(templateRoot, 'workflows/node_modules/typescript');
const ts = require(tsPath);

function fixture(t, copyTemplate = false) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'poly-kickstart-namespace-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'workflows/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workflows/node_modules'), { recursive: true });
  fs.symlinkSync(
    tsPath,
    path.join(root, 'workflows/node_modules/typescript'),
    'junction'
  );
  if (copyTemplate) {
    // Copy checked-in source formats only, never local env or SDK configuration.
    const copy = (from, to) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const destination = path.join(to, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(destination, { recursive: true });
          copy(path.join(from, entry.name), destination);
        } else if (entry.isFile() && /\.(?:ts|json)$/.test(entry.name)) {
          fs.copyFileSync(path.join(from, entry.name), destination);
        }
      }
    };
    copy(
      path.join(templateRoot, 'workflows/src'),
      path.join(root, 'workflows/src')
    );
  }
  return {
    root,
    writeProject(name, source) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    },
    readProject(name) {
      return fs.readFileSync(path.join(root, name), 'utf8');
    },
    write(name, source) {
      const file = path.join(root, 'workflows/src', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    },
    read(name) {
      return fs.readFileSync(path.join(root, 'workflows/src', name), 'utf8');
    },
    json(name) {
      return JSON.parse(this.read(name));
    },
    run(namespace) {
      return spawnSync(process.execPath, [script, namespace, root], {
        encoding: 'utf8',
        timeout: 10_000,
      });
    },
  };
}

function success(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

function loadTs(source, polyapi, extras = {}) {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(diagnostics, []);
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    Error,
    require(name) {
      assert.equal(name, 'polyapi', `Unexpected runtime dependency: ${name}`);
      return polyapi;
    },
    ...extras,
  });
  return module.exports;
}

function allFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(file) : [file];
  });
}

test('bundled workflows and utilities use the selected root, including security references and error filters', t => {
  const f = fixture(t, true);
  success(f.run('acme.eu'));
  const webhook = f.json('sampleWorkflow/artefacts/webhooks/motdWebhook.json');
  assert.equal(webhook.context, 'acme.eu.sampleWorkflow');
  assert.equal(
    webhook.securityFunctions[0].id,
    '{{acme.eu.sampleWorkflow.validateMotdPayload}}'
  );
  assert.equal(webhook.slug, 'sample-workflow-motd');
  const trigger = f.json(
    'utilities/common/artefacts/triggers/errorEventTrigger.json'
  );
  assert.equal(trigger.errorHandler.path, 'acme.eu');
  assert.equal(
    trigger.destination.functionContext,
    'acme.eu.diagnostics.services'
  );
  assert.equal(
    f.json('sampleWorkflow/artefacts/triggers/motdErrorHandlerTrigger.json')
      .errorHandler.path,
    '/apis/sample-workflow-motd/motd'
  );
  assert.equal(
    f.json('utilities/common/artefacts/vari/logLevel.json').context,
    'acme.eu.configurations.logging'
  );
  assert.match(
    f.read('utilities/common/client/log.ts'),
    /poly\.acme\.eu\.utilities\.slack\.sendAlert/
  );
  assert.match(
    f.read('utilities/common/client/log.ts'),
    /vari\.acme\.eu\.configurations\.logging/
  );
  assert.match(
    f.read('sampleWorkflow/client/motdClient.ts'),
    /poly\.acme\.eu\.sampleWorkflow\.getRandomJoke/
  );
  assert.match(
    f.read('sampleWorkflow/server/motdServer.ts'),
    /poly\.acme\.eu\.sampleWorkflow\.motdClient/
  );
  const ai = f.json('sampleAiFx/artefacts/ai-functions/upliftingWeather.json');
  assert.equal(ai.context, 'acme.eu.sampleAiFx');
  assert.equal(ai.toolFunctions[0].functionContext, 'accuWeather.locations');
  assert.equal(
    ai.toolFunctions[0].argumentConfig.find(arg => arg.key === 'apiKey')
      .variableContext,
    'acme.eu.sampleAiFx'
  );
  assert.match(
    f.read('utilities/common/client/sendAlert.ts'),
    /poly\.OOB\.polyapi\.internal\.alerting/
  );
  for (const file of allFiles(path.join(f.root, 'workflows/src'))) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /(?:poly|vari)\.(?:example|sample)\./, file);
    assert.doesNotMatch(
      text,
      /\b(?:context|functionContext|variableContext|webhookContext)["']?\s*:\s*["']example[."']/,
      file
    );
    if (file.endsWith('.ts')) {
      const parsed = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true
      );
      assert.equal(parsed.parseDiagnostics.length, 0, file);
    } else {
      JSON.parse(text);
    }
  }
  const before = allFiles(path.join(f.root, 'workflows/src')).map(file =>
    fs.readFileSync(file, 'utf8')
  );
  success(f.run('acme.eu'));
  assert.deepEqual(
    allFiles(path.join(f.root, 'workflows/src')).map(file =>
      fs.readFileSync(file, 'utf8')
    ),
    before
  );
});

test('transformed utility executes against the selected SDK namespace without changing external alert routing', async t => {
  const f = fixture(t, true);
  success(f.run('acme.eu-west'));
  const logCalls = [];
  const alerts = [];
  const polyapi = {
    __esModule: true,
    default: {
      acme: {
        'eu-west': { utilities: { log: (...args) => logCalls.push(args) } },
      },
      OOB: {
        polyapi: {
          internal: {
            alerting: { sendAlertToPoly: async args => alerts.push(args) },
          },
        },
      },
    },
    vari: {
      acme: {
        'eu-west': {
          configurations: {
            slack: { channelId: { get: async () => 'C_TEST' } },
          },
        },
      },
    },
    polyCustom: { executionId: 'test-execution' },
  };
  const fn = loadTs(f.read('utilities/common/client/sendAlert.ts'), polyapi);
  assert.match(
    f.read('utilities/common/client/sendAlert.ts'),
    /context: 'acme\.eu-west\.utilities\.slack'/
  );
  await fn.default({ message: 'Synthetic test message' });
  assert.equal(logCalls.length, 2);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].slack.channelId, 'C_TEST');
  assert.equal(alerts[0].slack.type, 'community');
});

test('transformed message-of-the-day server and client resolve both moods through the selected namespace', async t => {
  const f = fixture(t, true);
  success(f.run('acme.eu'));
  const injectedReference = { type: 'PolyVariable', id: 'synthetic-test-id' };
  let jokeStatus = 200;
  const functions = {
    async getRandomJoke(host) {
      assert.equal(host, injectedReference);
      return {
        status: jokeStatus,
        data: { setup: 'Setup', punchline: 'Punchline' },
      };
    },
    async getRandomAdvice(host) {
      assert.equal(host, 'https://advice.test');
      return { status: 200, data: { slip: { advice: 'Synthetic advice' } } };
    },
    async motdErrorHandler(error) {
      assert.equal(error.functionContext, 'acme.eu.sampleWorkflow');
      return { message: error.message };
    },
  };
  const polyapi = {
    __esModule: true,
    default: { acme: { eu: { sampleWorkflow: functions } } },
    vari: {
      acme: {
        eu: {
          sampleWorkflow: {
            jokeApiConfig: {
              inject: key => {
                assert.equal(key, 'hostUrl');
                return injectedReference;
              },
            },
            adviceApiConfig: {
              get: async () => ({ hostUrl: 'https://advice.test' }),
            },
          },
        },
      },
    },
  };
  functions.motdClient = loadTs(
    f.read('sampleWorkflow/client/motdClient.ts'),
    polyapi
  ).motdClient;
  const { motdServer } = loadTs(
    f.read('sampleWorkflow/server/motdServer.ts'),
    polyapi
  );
  assert.equal(
    (await motdServer({ name: 'Ada', mood: 'wise' })).message,
    'Hi Ada! Synthetic advice'
  );
  assert.equal(
    (await motdServer({ name: 'Ada', mood: 'funny' })).message,
    'Hi Ada! Setup ... Punchline'
  );
  jokeStatus = 503;
  const failure = await motdServer({ name: 'Ada', mood: 'funny' });
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.message, 'getRandomJoke failed with status 503');
});

test('rewrites metadata and SDK/mock roots while preserving payload examples, provider URLs, and unrelated prose', t => {
  const f = fixture(t);
  const document = {
    context: 'example.workflow',
    description: 'An example.workflow at https://example.com',
    source: { webhookContext: 'example.workflow' },
    destination: { functionContext: 'example.workflow' },
    functions: [
      {
        context: 'example.workflow',
        name: 'call',
        source: { url: '{{hostUrl}}/example.endpoint' },
      },
    ],
    securityFunctions: [
      { id: '{{example.workflow.validate}}' },
      { id: '{{OOB.shared.validate}}' },
    ],
    toolFunctions: [
      {
        functionContext: 'external.weather',
        toolArguments: { apiKey: { variableContext: 'example.workflow' } },
      },
    ],
    eventPayload: {
      context: 'example.customer',
      functionContext: 'example.data',
      id: '{{example.data.id}}',
    },
    value: { context: 'example.customer', hostUrl: 'https://example.com' },
    schema: {
      properties: { context: { example: 'example.customer' } },
      examples: [{ context: 'example.data' }],
    },
  };
  f.write('artefacts/resource.json', JSON.stringify(document, null, 2));
  f.write(
    'client.ts',
    `export const polyConfig = {context: 'example.workflow'};
const sample = {context: 'example.customer', description: 'example.workflow'};
export const values = [poly.example.workflow, vari['example'].config, tabi.example.rows, schemas.example.Payload];
mockModule('polyapi', {default: {example: {workflow: 1}, OOB: {public: 2}}, vari: {example: {config: 3}}});
`
  );
  success(f.run('acme.eu-west'));
  const rewritten = f.json('artefacts/resource.json');
  assert.equal(rewritten.context, 'acme.eu-west.workflow');
  assert.equal(rewritten.functions[0].context, 'acme.eu-west.workflow');
  assert.equal(
    rewritten.securityFunctions[0].id,
    '{{acme.eu-west.workflow.validate}}'
  );
  assert.equal(
    rewritten.securityFunctions[1].id,
    document.securityFunctions[1].id
  );
  assert.deepEqual(rewritten.eventPayload, document.eventPayload);
  assert.deepEqual(rewritten.value, document.value);
  assert.deepEqual(rewritten.schema, document.schema);
  assert.equal(rewritten.description, document.description);
  assert.equal(
    rewritten.functions[0].source.url,
    document.functions[0].source.url
  );
  const source = f.read('client.ts');
  assert.match(source, /context: 'example.customer'/);
  const mocks = [];
  const module = loadTs(
    source,
    {},
    {
      poly: { acme: { 'eu-west': { workflow: 1 } } },
      vari: { acme: { 'eu-west': { config: 2 } } },
      tabi: { acme: { 'eu-west': { rows: 3 } } },
      schemas: { acme: { 'eu-west': { Payload: 4 } } },
      mockModule: (...args) => mocks.push(args),
    }
  );
  assert.equal(module.polyConfig.context, 'acme.eu-west.workflow');
  assert.deepEqual(Array.from(module.values), [1, 2, 3, 4]);
  assert.equal(mocks[0][1].default.acme['eu-west'].workflow, 1);
  assert.equal(mocks[0][1].default.OOB.public, 2);
  assert.equal(mocks[0][1].vari.acme['eu-west'].config, 3);
});

test('invalid namespace fails without modifying source', t => {
  const f = fixture(t);
  const source = 'export const polyConfig = {context: "example.workflow"};';
  f.write('client.ts', source);
  for (const namespace of ['', '../other', 'acme..eu', 'a;echo bad']) {
    assert.notEqual(f.run(namespace).status, 0);
    assert.equal(f.read('client.ts'), source);
  }
});

test('copied tutorial training and SDK examples use the same namespace as the deployed resources', t => {
  const f = fixture(t, true);
  const guides = [
    'README.md',
    'docs/SETUP.md',
    'docs/CONVENTIONS.md',
    'cli/README.md',
    'workflows/src/sampleWorkflow/README.md',
    'workflows/src/sampleAiFx/OVERVIEW.md',
    'workflows/src/utilities/common/OVERVIEW.md',
  ];
  for (const file of guides)
    f.writeProject(
      file,
      fs.readFileSync(path.join(templateRoot, file), 'utf8')
    );
  success(f.run('acme.eu'));

  const context = f.json(
    'sampleWorkflow/artefacts/webhooks/motdWebhook.json'
  ).context;
  const tutorial = f.read('sampleWorkflow/README.md');
  assert.equal(context, 'acme.eu.sampleWorkflow');
  assert.ok(tutorial.includes(`--context ${context}`));
  assert.ok(tutorial.includes(`poly.${context}.getRandomJoke(hostUrl)`));
  assert.match(tutorial, /POLYAPI_NAMESPACE=acme\.eu/);
  assert.match(tutorial, /https:\/\/official-joke-api\.appspot\.com/);
  assert.match(tutorial, /\/apis\/sample-workflow-motd\/motd/);
  assert.match(
    f.read('sampleAiFx/OVERVIEW.md'),
    /poly\.acme\.eu\.sampleAiFx\.upliftingWeather\(/
  );
  assert.match(
    f.read('sampleAiFx/OVERVIEW.md'),
    /accuWeather\.locations\.search/
  );
  assert.match(
    f.read('utilities/common/OVERVIEW.md'),
    /poly\.acme\.eu\.utilities\.log\(/
  );
  for (const file of guides) {
    const updated = f.readProject(file);
    assert.doesNotMatch(updated, /(?:poly|vari|tabi|schemas)\.example\b/, file);
    assert.doesNotMatch(updated, /--context example\./, file);
  }
  const before = guides.map(file => f.readProject(file));
  success(f.run('acme.eu'));
  assert.deepEqual(
    guides.map(file => f.readProject(file)),
    before
  );
});

test('Markdown personalization respects curated paths, prose, links, URLs, filenames, and valid SDK syntax', t => {
  const f = fixture(t);
  const providerUrl =
    'https://provider.test/?context=example.utilities&call=poly.example.utilities.log&POLYAPI_NAMESPACE=example#example.workflow';
  const markdown = [
    '# Guide',
    '',
    'For example, keep example.context in ordinary prose.',
    'Root `example`; context `example.workflow`; reference `{{example.workflow.check}}`.',
    'SDK `poly.example.workflow`; alternate `vari["example"].config`.',
    '[External](https://example.com/guide) and [file](example.md).',
    '`https://example.com` `https://poly.example.com` `/apis/example.workflow/path` `example.json`.',
    '`designs/example.json` `OOB.polyapi.internal.alerting` `accuWeather.locations`.',
    '`C:\\designs\\example.workflow` `example.workflow/file.json`.',
    `Provider \`${providerUrl}\` beside context \`example.workflow\`.`,
    '',
    '```env',
    'POLYAPI_NAMESPACE=example',
    '```',
    '',
    '```bash',
    'pnpm flow train-openapi designs/example.json --context example.workflow',
    "pnpm flow train-openapi designs/ --context 'example.apis.{file}'",
    `curl '${providerUrl}'`,
    "rg -n '\\bexample\\b' workflows/src",
    '```',
    '',
    '```js',
    `const providerUrl = '${providerUrl}';`,
    'const value = poly.example.workflow(vari["example"].config);',
    '```',
    '',
  ].join('\n');
  const selected = [
    'README.md',
    'docs/SETUP.md',
    'cli/README.md',
    'workflows/src/sample/OVERVIEW.md',
  ];
  const untouched = [
    'AGENTS.md',
    '.agents/skills/demo/SKILL.md',
    'notes/README.md',
    'docs/nested/README.md',
    'workflows/src/sample/NOTES.md',
  ];
  for (const file of [...selected, ...untouched])
    f.writeProject(file, markdown);
  success(f.run('acme.eu-west'));

  for (const file of selected) {
    const updated = f.readProject(file);
    assert.match(updated, /Root `acme\.eu-west`/);
    assert.match(updated, /context `acme\.eu-west\.workflow`/);
    assert.match(updated, /\{\{acme\.eu-west\.workflow\.check\}\}/);
    assert.match(updated, /POLYAPI_NAMESPACE=acme\.eu-west/);
    assert.match(updated, /--context acme\.eu-west\.workflow/);
    assert.match(updated, /--context 'acme\.eu-west\.apis\.\{file\}'/);
    for (const preserved of [
      'For example, keep example.context in ordinary prose.',
      '[External](https://example.com/guide) and [file](example.md).',
      '`https://example.com` `https://poly.example.com` `/apis/example.workflow/path` `example.json`.',
      '`designs/example.json` `OOB.polyapi.internal.alerting` `accuWeather.locations`.',
      '`C:\\designs\\example.workflow` `example.workflow/file.json`.',
      `Provider \`${providerUrl}\` beside context \`acme.eu-west.workflow\`.`,
      `curl '${providerUrl}'`,
      `const providerUrl = '${providerUrl}';`,
      "rg -n '\\bexample\\b' workflows/src",
    ])
      assert.ok(updated.includes(preserved), `${file}: ${preserved}`);
    const javascript = /```js\n([\s\S]*?)```/.exec(updated)[1];
    const actual = vm.runInNewContext(`${javascript}\nvalue;`, {
      poly: { acme: { 'eu-west': { workflow: input => input + 1 } } },
      vari: { acme: { 'eu-west': { config: 4 } } },
    });
    assert.equal(actual, 5);
  }
  for (const file of untouched) assert.equal(f.readProject(file), markdown);
});
