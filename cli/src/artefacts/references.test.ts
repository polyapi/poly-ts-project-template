import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getReferenceableFunctions,
  getReferenceableServerFunctions,
  getReferenceableWebhooks,
} from './references';

function createClient(responses: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async GET(path: string) {
        calls.push(path);
        return { data: responses[path] ?? [] };
      },
    },
  };
}

test('discovers environment, tenant, and public functions without namespace filtering', async () => {
  const { client, calls } = createClient({
    '/functions/api': [
      { id: 'environment-api', name: 'localApi', context: 'example.api' },
    ],
    '/functions/api/public': [
      {
        id: 'public-api',
        name: 'search',
        context: 'accuWeather.locations',
        visibility: 'PUBLIC',
      },
    ],
    '/functions/server/tenant': [
      { id: 'tenant-server', name: 'sharedServer', context: 'shared.server' },
    ],
    '/functions/client/public': [
      { id: 'public-client', name: 'sharedClient', context: 'shared.client' },
    ],
  });

  const functions = await getReferenceableFunctions(client as never);

  assert.equal(calls.length, 9);
  assert.deepEqual(
    functions.map(item => ({
      id: item.id,
      functionType: item.functionType,
      referenceScope: item.referenceScope,
    })),
    [
      {
        id: 'environment-api',
        functionType: 'api',
        referenceScope: 'environment',
      },
      {
        id: 'public-api',
        functionType: 'api',
        referenceScope: 'public',
      },
      {
        id: 'tenant-server',
        functionType: 'server',
        referenceScope: 'tenant',
      },
      {
        id: 'public-client',
        functionType: 'client',
        referenceScope: 'public',
      },
    ]
  );
});

test('server-only discovery does not fetch API or client function endpoints', async () => {
  const { client, calls } = createClient({
    '/functions/server/public': [
      { id: 'public-server', name: 'handler', context: 'shared.server' },
    ],
  });

  const functions = await getReferenceableServerFunctions(client as never);

  assert.equal(functions.length, 1);
  assert.deepEqual(calls.sort(), [
    '/functions/server',
    '/functions/server/public',
    '/functions/server/tenant',
  ]);
});

test('prefers the environment copy when the same function is also listed publicly', async () => {
  const duplicate = {
    id: 'shared-id',
    name: 'search',
    context: 'accuWeather.locations',
  };
  const { client } = createClient({
    '/functions/api': [duplicate],
    '/functions/api/public': [duplicate],
  });

  const functions = await getReferenceableFunctions(client as never, ['api']);

  assert.equal(functions.length, 1);
  assert.equal(functions[0].referenceScope, 'environment');
});

test('discovers accessible webhooks without namespace filtering', async () => {
  const { client, calls } = createClient({
    '/webhooks/public': [
      { id: 'public-webhook', name: 'events', context: 'shared.webhooks' },
    ],
  });

  const webhooks = await getReferenceableWebhooks(client as never);

  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].context, 'shared.webhooks');
  assert.deepEqual(calls.sort(), [
    '/webhooks',
    '/webhooks/public',
    '/webhooks/tenant',
  ]);
});
