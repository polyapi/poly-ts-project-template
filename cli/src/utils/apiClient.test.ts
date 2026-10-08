import assert from 'node:assert/strict';
import readline from 'node:readline/promises';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';

let restoreTestState: () => void;

beforeEach(() => {
  const names = ['OTP_ENABLED', 'BASE_URL', 'API_KEY'] as const;
  const previousEnv = names.map(name => [name, process.env[name]] as const);
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  restoreTestState = () => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    for (const [stream, descriptor] of [
      [process.stdin, stdinTty],
      [process.stdout, stdoutTty],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(stream, 'isTTY', descriptor);
      } else {
        Reflect.deleteProperty(stream, 'isTTY');
      }
    }
  };

  process.env.BASE_URL = 'https://polyapi.test';
  process.env.API_KEY = 'placeholder-api-key';
  process.env.OTP_ENABLED = 'true';
});

afterEach(() => restoreTestState());

function loadApiClient(): typeof import('./apiClient') {
  // Each test represents a fresh Flow process with its own cached OTP.
  delete require.cache[require.resolve('./apiClient')];
  return require('./apiClient');
}

function setInteractiveTerminal(enabled: boolean): void {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, 'isTTY', {
      configurable: true,
      value: enabled,
    });
  }
}

function captureRequests(t: TestContext): Request[] {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (input: Request) => {
    requests.push(input);
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return requests;
}

test('OTP-disabled writes do not prompt or attach x-otp', async t => {
  process.env.OTP_ENABLED = 'false';
  setInteractiveTerminal(false);
  const requests = captureRequests(t);
  const { createPolyApiClient, getDeleteHeaders } = loadApiClient();
  const client = createPolyApiClient();

  await client.PATCH('/variables/{id}', {
    params: { path: { id: 'example-variable' } },
    body: { description: 'Updated description' },
  });
  await client.DELETE('/variables/{id}', {
    params: { path: { id: 'example-variable' } },
    headers: await getDeleteHeaders(),
  });

  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => !request.headers.has('x-otp')));
});

test('OTP-enabled reads do not require an interactive terminal', async t => {
  setInteractiveTerminal(false);
  const requests = captureRequests(t);
  const { createPolyApiClient } = loadApiClient();

  await createPolyApiClient().GET('/variables', {});

  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.has('x-otp'), false);
});

test('write methods attach x-otp and concurrent writes share one hidden prompt', async t => {
  setInteractiveTerminal(true);
  const requests = captureRequests(t);
  const displayed: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: string) => {
    displayed.push(chunk);
    return true;
  });
  const question = t.mock.fn(async () => ' 000000 ');
  const close = t.mock.fn();
  const createInterface = t.mock.method(readline, 'createInterface', () => ({
    question,
    close,
  }));
  const { createPolyApiClient, getDeleteHeaders, getOtpHeaders } =
    loadApiClient();
  const client = createPolyApiClient();

  await Promise.all([
    client.PATCH('/variables/{id}', {
      params: { path: { id: 'example-variable' } },
      body: { description: 'Updated description' },
    }),
    client.POST('/variables', {
      body: { name: 'example', context: 'example', value: {} },
    }),
  ]);
  await client.PUT('/schemas', {
    body: { name: 'example', context: 'example', definition: {} },
  });
  await client.DELETE('/variables/{id}', {
    params: { path: { id: 'example-variable' } },
    headers: await getDeleteHeaders(),
  });
  assert.deepEqual(await getOtpHeaders('put'), { 'x-otp': '000000' });

  assert.equal(createInterface.mock.callCount(), 1);
  assert.equal(question.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(requests.length, 4);
  assert.ok(
    requests.every(request => request.headers.get('x-otp') === '000000')
  );
  assert.ok(
    requests.every(
      request =>
        request.headers.get('Authorization') === 'Bearer placeholder-api-key'
    )
  );
  assert.ok(displayed.join('').includes('Enter OTP:'));
  assert.equal(displayed.join('').includes('000000'), false);

  await client.GET('/variables', {});
  assert.equal(requests[4].headers.has('x-otp'), false);
});

test('OTP-enabled writes fail before dispatch without an interactive terminal', async t => {
  setInteractiveTerminal(false);
  const requests = captureRequests(t);
  const { createPolyApiClient } = loadApiClient();

  await assert.rejects(
    createPolyApiClient().PATCH('/variables/{id}', {
      params: { path: { id: 'example-variable' } },
      body: { description: 'Updated description' },
    }),
    /no interactive terminal is available/
  );
  assert.equal(requests.length, 0);
});

test('empty OTP input closes the prompt and prevents write dispatch', async t => {
  setInteractiveTerminal(true);
  const requests = captureRequests(t);
  t.mock.method(process.stdout, 'write', () => true);
  const close = t.mock.fn();
  t.mock.method(readline, 'createInterface', () => ({
    question: async () => ' ',
    close,
  }));
  const { createPolyApiClient } = loadApiClient();

  await assert.rejects(
    createPolyApiClient().PATCH('/variables/{id}', {
      params: { path: { id: 'example-variable' } },
      body: { description: 'Updated description' },
    }),
    /OTP is required to modify resources/
  );
  assert.equal(requests.length, 0);
  assert.equal(close.mock.callCount(), 1);
});

test('a failed shared OTP prompt allows a later write to prompt again', async t => {
  setInteractiveTerminal(true);
  const requests = captureRequests(t);
  t.mock.method(process.stdout, 'write', () => true);
  const answers = [' ', '000000'];
  const question = t.mock.fn(async () => answers.shift() ?? '');
  const close = t.mock.fn();
  const createInterface = t.mock.method(readline, 'createInterface', () => ({
    question,
    close,
  }));
  const { createPolyApiClient } = loadApiClient();
  const client = createPolyApiClient();
  const update = () =>
    client.PATCH('/variables/{id}', {
      params: { path: { id: 'example-variable' } },
      body: { description: 'Updated description' },
    });

  await Promise.all([
    assert.rejects(update(), /OTP is required to modify resources/),
    assert.rejects(update(), /OTP is required to modify resources/),
  ]);
  assert.equal(requests.length, 0);
  assert.equal(createInterface.mock.callCount(), 1);

  await Promise.all([update(), update()]);
  assert.equal(createInterface.mock.callCount(), 2);
  assert.equal(question.mock.callCount(), 2);
  assert.equal(close.mock.callCount(), 2);
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(request => request.headers.get('x-otp') === '000000')
  );
});
