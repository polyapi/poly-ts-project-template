import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import securityFixture from './fixtures/openapi-security.json';
import {
  createMaintenanceRuntime,
  deleteContent,
  formatLogs,
  functionLogs,
  type MaintenanceRuntime,
  parseMaintenanceArgs,
  selectResources,
  trainOpenApi,
  trainSavedModel,
} from './maintenance';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'flow-maintenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = [
    'POLYAPI_NAMESPACE',
    'POLYAPI_NAMESPACES',
    'BASE_URL',
    'API_KEY',
    'OTP_ENABLED',
  ] as const;
  const previous = names.map(name => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.POLYAPI_NAMESPACE = 'demo';
  delete process.env.POLYAPI_NAMESPACES;
  process.env.BASE_URL = 'https://polyapi.test';
  process.env.API_KEY = 'placeholder-api-key';
  process.env.OTP_ENABLED = 'false';
  const output: string[] = [];
  const calls: string[][] = [];
  const removed: string[] = [];
  const trained: Record<
    string,
    { id: string; name: string; context: string }[]
  > = {};
  const runtime: MaintenanceRuntime = {
    workspaceRoot: root,
    invocationDirectory: root,
    prompt: async () => 'DELETE',
    print: message => output.push(message),
    list: async type =>
      trained[type] ?? [
        { id: 'one', context: 'demo.apis', name: 'one' },
        { id: 'two', context: 'demo.apis.child', name: 'two' },
      ],
    remove: async (_type, id) => {
      removed.push(id);
    },
    detail: async () => null,
    upsert: async (type, resource) => {
      trained[type] ??= [];
      trained[type].push({
        ...resource,
        id: `${type}-${trained[type]?.length ?? 0}`,
      });
    },
    logs: async () => '{"logs":[]}',
    runPoly(args) {
      calls.push(args);
      if (args[0] === 'model' && args[1] === 'generate') {
        const context = args[args.indexOf('--context') + 1];
        fs.writeFileSync(
          args[3],
          JSON.stringify({
            functions: [
              {
                name: 'fetch',
                context,
                description: 'Fetch',
                arguments: [],
                source: {
                  auth: { type: 'noauth' },
                  body: { mode: 'empty' },
                  url: '{{hostUrl}}/test',
                  method: 'GET',
                },
              },
            ],
          })
        );
      }
      if (args[0] === 'model' && args[1] === 'train') {
        const model = JSON.parse(fs.readFileSync(args[2], 'utf8'));
        for (const [kind, type] of [
          ['functions', 'api'],
          ['schemas', 'schema'],
          ['webhooks', 'webhook'],
        ]) {
          trained[type] = (model[kind] ?? []).map(
            (resource: { name: string; context: string }, index: number) => ({
              ...resource,
              id: `${type}-${index}`,
            })
          );
        }
      }
    },
    convertSwagger(input, outputFile) {
      assert.equal(JSON.parse(fs.readFileSync(input, 'utf8')).swagger, '2.0');
      fs.writeFileSync(outputFile, '{"openapi":"3.0.0","paths":{}}');
    },
  };
  function spec(name: string, contents = '{"openapi":"3.0.0","paths":{}}') {
    const file = path.join(root, 'designs', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }
  return { root, output, calls, removed, runtime, spec };
}

function args(command: string, ...values: string[]) {
  const result = parseMaintenanceArgs([command, ...values]);
  assert.ok(result);
  return result;
}

for (const disableAi of [true, false])
  for (const literal of [true, false])
    for (const generateOnly of [true, false])
      test(`training restores required API key before saving/upserting: disableAi=${disableAi}, literal=${literal}, generateOnly=${generateOnly}`, async t => {
        const f = fixture(t);
        const model = structuredClone(securityFixture.model);
        const resource = model.functions[0];
        resource.context = 'demo.apis';
        if (literal) {
          Object.assign(resource.source, {
            auth: { type: 'noauth' },
            headers: [{ key: 'Authorization', value: 'JWT {{apiKey}}' }],
          });
        }
        const input = f.spec(
          'secured.json',
          JSON.stringify(securityFixture.spec)
        );
        const upserts: unknown[] = [];
        const originalUpsert = f.runtime.upsert;
        f.runtime.upsert = async (type, item) => {
          upserts.push(structuredClone(item));
          await originalUpsert(type, item);
        };
        f.runtime.runPoly = values => {
          assert.deepEqual(values.slice(0, 2), ['model', 'generate']);
          assert.equal(values.includes('--disable-ai'), disableAi);
          fs.writeFileSync(values[3], JSON.stringify(model));
        };
        await trainOpenApi(
          args(
            'train-openapi',
            input,
            '--context',
            'demo.apis',
            '--skip-generate',
            ...(disableAi ? ['--disable-ai'] : []),
            ...(generateOnly ? ['--generate-only'] : [])
          ),
          f.runtime
        );
        const saved = JSON.parse(
          fs.readFileSync(input.replace('.json', '.poly.json'), 'utf8')
        );
        assert.deepEqual(upserts, generateOnly ? [] : saved.functions);
        assert.ok(
          saved.functions[0].source.headers.some(
            (header: { key: string }) => header.key === 'x-api-key'
          )
        );
        assert.equal(
          saved.functions[0].arguments.find(
            (argument: { name: string }) => argument.name === 'xApiKey'
          ).required,
          true
        );
        assert.deepEqual(saved.functions[0].source.auth, resource.source.auth);
      });

test('ambiguous security stops before model save and training', async t => {
  const f = fixture(t);
  const spec = {
    ...securityFixture.spec,
    paths: {
      ...securityFixture.spec.paths,
      '/members/{other}/': { get: { security: [] } },
    },
  };
  const input = f.spec('ambiguous.json', JSON.stringify(spec));
  const model = structuredClone(securityFixture.model);
  model.functions[0].context = 'demo.apis';
  let writes = 0;
  f.runtime.upsert = async () => {
    writes++;
  };
  f.runtime.runPoly = values => {
    fs.writeFileSync(values[3], JSON.stringify(model));
  };
  await assert.rejects(
    () =>
      trainOpenApi(
        args('train-openapi', input, '--context', 'demo.apis', '--disable-ai'),
        f.runtime
      ),
    /Ambiguous/
  );
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(input.replace('.json', '.poly.json')), false);
});

test('parses utility flags, defaults the log limit to page size, and rejects invalid options', () => {
  assert.equal(args('logs', 'function-id', '--logs-page-size=500').limit, 500);
  assert.equal(
    args('logs', '--logs-page', '2', '--keyword', 'error').logsPage,
    2
  );
  assert.equal(
    args('train:openapi', 'designs', '--context', 'demo.{file}', '--dry-run')
      .dryRun,
    true
  );
  assert.equal(parseMaintenanceArgs(['push']), null);
  for (const value of ['0', '-1', '1.2', 'abc', '9007199254740992']) {
    assert.throws(() => args('logs', `--limit=${value}`), /positive integer/);
  }
  assert.throws(() => args('logs', '--unknown'), /Unknown option/);
  assert.throws(
    () => args('delete:content', 'unexpected'),
    /Unexpected argument/
  );
});

test('selects exact context and descendants, deduplicates, and excludes nested resource values', () => {
  assert.deepEqual(
    selectResources(
      {
        items: [
          {
            id: 'one',
            context: 'demo.api',
            value: { id: 'nested', context: 'demo.api' },
          },
          { id: 'two', context: 'demo.api.child' },
          { id: 'one', context: 'demo.api' },
          { id: 'unrelated', context: 'demo.apis' },
          { id: 'foreign', context: 'other.api' },
        ],
      },
      'demo.api'
    ).map(item => item.id),
    ['one', 'two']
  );
});

test('deletion dry run previews matches without prompting or writing', async t => {
  const f = fixture(t);
  f.runtime.prompt = async () => {
    throw new Error('must not prompt');
  };
  await deleteContent(
    args(
      'delete:content',
      '--type',
      'api',
      '--context',
      'demo.apis',
      '--dry-run'
    ),
    f.runtime
  );
  assert.deepEqual(f.removed, []);
  assert.match(f.output.join('\n'), /1 resource/);
});

test('deletion requires exact DELETE confirmation and rejects foreign scopes before listing', async t => {
  const f = fixture(t);
  f.runtime.prompt = async () => 'yes';
  await deleteContent(
    args(
      'delete:content',
      '--type',
      'apis',
      '--context',
      'demo.apis',
      '--apply',
      '--include-children'
    ),
    f.runtime
  );
  assert.deepEqual(f.removed, []);
  f.runtime.prompt = async () => 'DELETE';
  await deleteContent(
    args(
      'delete:content',
      '--type',
      'api',
      '--context',
      'demo.apis',
      '--apply',
      '--include-children'
    ),
    f.runtime
  );
  assert.deepEqual(f.removed, ['one', 'two']);
  f.runtime.list = async () => {
    throw new Error('must not list');
  };
  await assert.rejects(
    deleteContent(
      args('delete:content', '--type', 'api', '--context', 'external'),
      f.runtime
    ),
    /must start with/
  );
});

test('a failed delete stops further deletion', async t => {
  const f = fixture(t);
  f.runtime.remove = async (_type, id) => {
    f.removed.push(id);
    throw new Error('HTTP 403');
  };
  await assert.rejects(
    deleteContent(
      args(
        'delete:content',
        '--type',
        'api',
        '--context',
        'demo.apis',
        '--apply',
        '--include-children'
      ),
      f.runtime
    ),
    /403/
  );
  assert.deepEqual(f.removed, ['one']);
});

test('log formatting supports nested responses, metadata, strings, empty data and raw text', () => {
  const formatted = formatLogs(
    JSON.stringify({
      data: {
        logs: [
          {
            timestamp: 'now',
            level: 'error',
            message: 'failed',
            correlationId: 'request-1',
          },
          'plain message',
        ],
        page: 2,
      },
    })
  );
  assert.match(formatted, /now \| ERROR \| failed/);
  assert.match(formatted, /correlationId/);
  assert.match(formatted, /"page": 2/);
  assert.match(formatted, /plain message/);
  assert.equal(formatLogs('{"logs":[]}'), 'No logs found.');
  assert.equal(formatLogs('unstructured output'), 'unstructured output');
  assert.equal(formatLogs(''), '');
});

test('log requests preserve pagination and keyword and report HTTP failures without response bodies', async t => {
  const f = fixture(t);
  const requests: Request[] = [];
  let failRequest = false;
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    requests.push(request);
    if (failRequest)
      return new Response('placeholder-private-error', { status: 401 });
    return new Response(' {"logs":["message"]} ', {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const runtime = createMaintenanceRuntime(f.root, f.root);
  runtime.print = message => f.output.push(message);
  await functionLogs(
    args(
      'logs',
      'function id',
      '--logs-page',
      '2',
      '--logs-page-size',
      '25',
      '--keyword',
      'a & b',
      '--raw'
    ),
    runtime
  );
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/functions/server/function%20id/logs');
  assert.equal(url.searchParams.get('logsPage'), '2');
  assert.equal(url.searchParams.get('logsPageSize'), '25');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('keyword'), 'a & b');
  assert.equal(f.output[0], ' {"logs":["message"]} ');
  failRequest = true;
  await assert.rejects(runtime.logs('id', args('logs')), error => {
    assert.match(String(error), /HTTP 401/);
    assert.doesNotMatch(String(error), /placeholder-private-error/);
    return true;
  });
});

test('resource requests use the shared authenticated client and supported deletion endpoints', async t => {
  const f = fixture(t);
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    requests.push(request);
    if (
      request.method === 'GET' &&
      new URL(request.url).pathname.endsWith('/resource%20id')
    )
      return new Response(null, { status: 404 });
    return request.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  });
  const runtime = createMaintenanceRuntime(f.root, f.root);
  for (const [type, endpoint] of [
    ['api', '/functions/api'],
    ['schema', '/schemas'],
    ['variable', '/variables'],
    ['webhook', '/webhooks'],
    ['trigger', '/triggers'],
    ['table', '/tables'],
    ['job', '/jobs'],
  ] as const) {
    await runtime.list(type);
    await runtime.remove(type, 'resource id');
    const [get, remove] = requests.slice(-3);
    assert.equal(get.method, 'GET');
    assert.equal(new URL(get.url).pathname, endpoint);
    assert.equal(remove.method, 'DELETE');
    assert.equal(new URL(remove.url).pathname, `${endpoint}/resource%20id`);
    assert.equal(
      remove.headers.get('Authorization'),
      'Bearer placeholder-api-key'
    );
  }
});

test('training supports JSON and YAML, file contexts, model output, and SDK regeneration', async t => {
  const f = fixture(t);
  f.spec('weather.json');
  f.spec('orders.yaml', 'openapi: 3.0.0\npaths: {}\n');
  f.spec('old.poly-model.json', '{"functions":[]}');
  await trainOpenApi(
    args('train:openapi', 'designs', '--context', 'demo.apis.{file}'),
    f.runtime
  );
  assert.deepEqual(
    f.calls
      .filter(call => call[1] === 'generate')
      .map(call => call[call.indexOf('--context') + 1]),
    ['demo.apis.orders', 'demo.apis.weather']
  );
  assert.deepEqual(f.calls[f.calls.length - 1], ['generate']);
  assert.equal(f.calls.filter(call => call[1] === 'generate').length, 2);
  assert.ok(fs.existsSync(path.join(f.root, 'designs/weather.poly.json')));
  assert.ok(
    !fs
      .readdirSync(path.join(f.root, 'designs'))
      .some(file => file.startsWith('.flow-'))
  );
});

test('Swagger 2 conversion happens before generation and dry run makes no changes', async t => {
  const f = fixture(t);
  const file = f.spec('legacy.yaml', 'swagger: "2.0"\npaths: {}\n');
  const initial = fs.readdirSync(path.dirname(file));
  await trainOpenApi(
    args('train:openapi', file, '--context', 'demo.legacy', '--dry-run'),
    f.runtime
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), initial);
  await trainOpenApi(
    args('train:openapi', file, '--context', 'demo.legacy'),
    f.runtime
  );
  assert.match(f.calls[0][2], /\.oas3\.json$/);
});

test('failed generation preserves prior models, cleans temporary files, and does not train', async t => {
  const f = fixture(t);
  const file = f.spec('weather.json');
  const model = f.spec('weather.poly.json', '{"previous":true}');
  f.runtime.runPoly = call => {
    f.calls.push(call);
    throw new Error('generation failed');
  };
  await assert.rejects(
    trainOpenApi(
      args(
        'train:openapi',
        file,
        '--context',
        'demo.weather',
        '--overwrite-model'
      ),
      f.runtime
    ),
    /generation failed/
  );
  assert.equal(fs.readFileSync(model, 'utf8'), '{"previous":true}');
  assert.equal(f.calls.length, 1);
  assert.ok(
    !fs.readdirSync(path.dirname(file)).some(name => name.startsWith('.flow-'))
  );
});

test('training fails if the SDK exits without generating a model', async t => {
  const f = fixture(t);
  const file = f.spec('weather.json');
  f.runtime.runPoly = call => {
    f.calls.push(call);
  };
  await assert.rejects(
    trainOpenApi(
      args('train:openapi', file, '--context', 'demo.weather'),
      f.runtime
    ),
    /did not generate/
  );
  assert.equal(f.calls.length, 1);
});

test('training rejects a partial SDK failure even when the SDK exits successfully', async t => {
  const f = fixture(t);
  const file = f.spec('weather.json');
  f.runtime.list = async () => [];
  await assert.rejects(
    trainOpenApi(
      args('train:openapi', file, '--context', 'demo.weather'),
      f.runtime
    ),
    /Training incomplete; missing api resources: demo.weather.fetch/
  );
  assert.deepEqual(
    f.calls.map(call => call.slice(0, 2)),
    [['model', 'generate']]
  );
});

test('canonical commands, aliases and repeatable operation/rename options share one parser', () => {
  const parsed = args(
    'train-openapi',
    'spec.json',
    '--operation-id',
    'one',
    '--operation-id',
    'two',
    '--rename',
    'old',
    'new',
    '--rename',
    'before',
    'after',
    '--disable-ai'
  );
  assert.deepEqual(parsed.operationIds, ['one', 'two']);
  assert.deepEqual(parsed.renames, [
    ['old', 'new'],
    ['before', 'after'],
  ]);
  assert.equal(args('train:openapi').command, 'train-openapi');
  assert.equal(args('delete:content').command, 'delete-content');
  assert.equal(args('delete-content').dryRun, true);
  assert.throws(
    () => args('train-openapi', '--rename', 'one'),
    /requires FROM TO/
  );
  assert.throws(
    () => args('delete-content', '--apply', '--dry-run'),
    /cannot be combined/
  );
});

test('deletion defaults to preview and exact context; multiple types require explicit apply', async t => {
  const f = fixture(t);
  f.runtime.prompt = async () => {
    throw Error('must not prompt');
  };
  await deleteContent(
    args(
      'delete-content',
      '--types',
      'api-functions,schemas',
      '--context',
      'demo.apis'
    ),
    f.runtime
  );
  assert.equal(f.removed.length, 0);
  assert.match(
    f.output.join('\n'),
    /2 resource\(s\) selected in exact context/
  );
  f.runtime.prompt = async () => 'DELETE';
  await deleteContent(
    args(
      'delete-content',
      '--types',
      'api-functions,schemas',
      '--context',
      'demo.apis',
      '--apply'
    ),
    f.runtime
  );
  assert.deepEqual(f.removed, ['one', 'one']);
});

test('deletion readback must be 404 and a successful DELETE alone is insufficient', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async (request: Request) =>
    request.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response('{}', { status: 200 })
  );
  await assert.rejects(
    createMaintenanceRuntime(f.root, f.root).remove('api', 'test'),
    /Deletion could not be verified/
  );
});

test('jobs and triggers are scoped by every destination function rather than by their names', async t => {
  const f = fixture(t);
  f.runtime.list = async type =>
    type === 'server'
      ? [
          { id: 'owned', context: 'demo.apis' },
          { id: 'foreign', context: 'other.apis' },
        ]
      : [{ id: 'safe' }, { id: 'shared' }];
  f.runtime.detail = async (_type, id) => ({
    functions: [
      { id: 'owned' },
      ...(id === 'shared' ? [{ id: 'foreign' }] : []),
    ],
  });
  await deleteContent(
    args(
      'delete-content',
      '--types',
      'jobs',
      '--context',
      'demo.apis',
      '--apply'
    ),
    f.runtime
  );
  assert.deepEqual(f.removed, ['safe']);
});

test('generate-only saves a clean model, refuses overwrites and supports saved-model retry without regeneration', async t => {
  const f = fixture(t);
  const file = f.spec('weather.json');
  let writes = 0;
  const upsert = f.runtime.upsert;
  f.runtime.upsert = async (...values) => {
    writes++;
    await upsert(...values);
  };
  await trainOpenApi(
    args(
      'train-openapi',
      file,
      '--context',
      'demo.weather',
      '--generate-only',
      '--disable-ai'
    ),
    f.runtime
  );
  assert.equal(writes, 0);
  assert.ok(f.calls[0].includes('--disable-ai'));
  const model = path.join(f.root, 'designs/weather.poly.json');
  const calls = f.calls.length;
  await assert.rejects(
    trainOpenApi(
      args('train-openapi', file, '--context', 'demo.weather'),
      f.runtime
    ),
    /Model already exists/
  );
  assert.equal(f.calls.length, calls);
  const legacy = path.join(f.root, 'designs/weather.poly-model.json');
  fs.renameSync(model, legacy);
  await trainSavedModel(
    args('train-model', legacy, '--skip-generate'),
    f.runtime
  );
  assert.equal(writes, 1);
  assert.equal(f.calls.length, calls);
});

test('cross-file duplicate identities fail before writes or saved models', async t => {
  const f = fixture(t);
  f.spec('first.json');
  f.spec('nested/second.yaml', 'openapi: 3.0.3\npaths: {}');
  f.runtime.upsert = async () => {
    throw Error('must not write');
  };
  await assert.rejects(
    trainOpenApi(
      args('train-openapi', 'designs', '--context', 'demo.same'),
      f.runtime
    ),
    /Duplicate model identity/
  );
  assert.equal(
    fs.existsSync(path.join(f.root, 'designs/first.poly.json')),
    false
  );
});

test('a failed training write stops later batches and SDK regeneration', async t => {
  const f = fixture(t);
  const file = f.spec('weather.json');
  f.runtime.upsert = async () => {
    throw Error('HTTP 403');
  };
  await assert.rejects(
    trainOpenApi(
      args('train-openapi', file, '--context', 'demo.weather'),
      f.runtime
    ),
    /HTTP 403/
  );
  assert.deepEqual(
    f.calls.map(call => call.slice(0, 2)),
    [['model', 'generate']]
  );
});
