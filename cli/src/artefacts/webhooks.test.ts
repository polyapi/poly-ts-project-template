import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWebhookArtifact } from '../utils/validation';
import {
  buildRemoteWebhookPayload,
  findDoubleExecutionTriggers,
  resolveWebhookServerFunction,
} from './webhooks';

const functions = [
  { id: 'handler-id', name: 'handleOrder', context: 'example.orders' },
  { id: 'other-id', name: 'other', context: 'example.orders' },
];

const webhook = {
  name: 'orderCreated',
  context: 'example.orders',
  description: 'Order created events.',
  serverFunction: {
    functionName: 'handleOrder',
    functionContext: 'example.orders',
  },
};

test('webhook artefacts accept a serverFunction reference or null', () => {
  assert.equal(validateWebhookArtifact(webhook, 'orderCreated.json'), true);
  assert.equal(
    validateWebhookArtifact(
      { ...webhook, serverFunction: null },
      'orderCreated.json'
    ),
    true
  );
  assert.equal(
    validateWebhookArtifact(
      { ...webhook, serverFunction: { functionName: 'handleOrder' } },
      'orderCreated.json',
      true
    ),
    false
  );
});

test('serverFunction resolves to serverFunctionId', () => {
  const payload: Record<string, unknown> = { ...webhook };
  assert.equal(
    resolveWebhookServerFunction(payload, functions, webhook.name),
    true
  );
  assert.equal(payload.serverFunctionId, 'handler-id');
  assert.equal('serverFunction' in payload, false);
});

test('serverFunction null disconnects; absence leaves it unmanaged', () => {
  const disconnect: Record<string, unknown> = {
    ...webhook,
    serverFunction: null,
  };
  assert.equal(
    resolveWebhookServerFunction(disconnect, functions, webhook.name),
    true
  );
  assert.equal(disconnect.serverFunctionId, null);

  const { serverFunction: _serverFunction, ...unmanaged } = webhook;
  const payload: Record<string, unknown> = { ...unmanaged };
  assert.equal(
    resolveWebhookServerFunction(payload, functions, webhook.name),
    true
  );
  assert.equal('serverFunctionId' in payload, false);
});

test('unknown or ambiguous serverFunction references fail', () => {
  const missing: Record<string, unknown> = {
    ...webhook,
    serverFunction: { functionName: 'nope', functionContext: 'example' },
  };
  assert.equal(
    resolveWebhookServerFunction(missing, functions, webhook.name),
    false
  );

  const ambiguous: Record<string, unknown> = { ...webhook };
  assert.equal(
    resolveWebhookServerFunction(
      ambiguous,
      [
        ...functions,
        { id: 'tenant-id', name: 'handleOrder', context: 'example.orders' },
      ],
      webhook.name
    ),
    false
  );
});

test('serverFunctionId is part of the change comparison', () => {
  const local = { name: webhook.name, serverFunctionId: 'handler-id' };
  const remote = {
    name: webhook.name,
    description: webhook.description,
    context: webhook.context,
    serverFunctionId: 'previous-id',
  };
  assert.equal(
    buildRemoteWebhookPayload(local, remote as any, {} as any).serverFunctionId,
    'previous-id'
  );
  assert.equal(
    buildRemoteWebhookPayload(
      { name: webhook.name, serverFunctionId: null },
      { ...remote, serverFunctionId: undefined } as any,
      {} as any
    ).serverFunctionId,
    null
  );
  assert.equal(
    'serverFunctionId' in
      buildRemoteWebhookPayload(
        { name: webhook.name },
        remote as any,
        {} as any
      ),
    false
  );
});

test('a trigger routing the webhook to the same function is reported', () => {
  const triggers = [
    {
      filePath: 'triggers/sameFunction.json',
      content: {
        source: {
          webhookName: 'orderCreated',
          webhookContext: 'example.orders',
        },
        destination: {
          functionName: 'handleOrder',
          functionContext: 'example.orders',
        },
      },
    },
    {
      filePath: 'triggers/otherFunction.json',
      content: {
        source: {
          webhookName: 'orderCreated',
          webhookContext: 'example.orders',
        },
        destination: {
          functionName: 'other',
          functionContext: 'example.orders',
        },
      },
    },
    {
      filePath: 'triggers/errorHandler.json',
      content: {
        errorHandler: { path: 'example' },
        destination: {
          functionName: 'handleOrder',
          functionContext: 'example.orders',
        },
      },
    },
  ];
  assert.deepEqual(findDoubleExecutionTriggers(webhook, triggers), [
    'triggers/sameFunction.json',
  ]);
  assert.deepEqual(
    findDoubleExecutionTriggers({ ...webhook, serverFunction: null }, triggers),
    []
  );
});
