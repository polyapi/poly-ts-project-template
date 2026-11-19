import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWebhookArtifact } from '../utils/validation';
import {
  assertNoWebhookBindingConflicts,
  buildRemoteWebhookPayload,
  findWebhookBindingConflicts,
  formatWebhookBindingConflicts,
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

const sourcedTrigger = (
  filePath: string,
  functionName: string,
  webhookName = 'orderCreated'
) => ({
  filePath,
  content: {
    source: { webhookName, webhookContext: 'example.orders' },
    destination: { functionName, functionContext: 'example.orders' },
  },
});

test('every trigger sourced from a bound webhook conflicts, whatever its destination', () => {
  const triggers = [
    sourcedTrigger('triggers/sameFunction.json', 'handleOrder'),
    sourcedTrigger('triggers/otherFunction.json', 'other'),
    sourcedTrigger('triggers/otherWebhook.json', 'handleOrder', 'orderPaid'),
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
  assert.deepEqual(
    findWebhookBindingConflicts(
      [{ filePath: 'webhooks/orderCreated.json', content: webhook }],
      triggers
    ),
    [
      {
        webhook: 'example.orders.orderCreated',
        webhookFile: 'webhooks/orderCreated.json',
        serverFunction: 'example.orders.handleOrder',
        triggerFiles: [
          'triggers/otherFunction.json',
          'triggers/sameFunction.json',
        ],
      },
    ]
  );
});

test('webhooks without a binding keep their triggers', () => {
  const triggers = [
    sourcedTrigger('triggers/sameFunction.json', 'handleOrder'),
  ];
  const { serverFunction: _serverFunction, ...unmanaged } = webhook;
  assert.deepEqual(
    findWebhookBindingConflicts(
      [
        { filePath: 'a.json', content: { ...webhook, serverFunction: null } },
        { filePath: 'b.json', content: unmanaged },
      ],
      triggers
    ),
    []
  );
});

test('the conflict error names the webhook and trigger files and both fixes', () => {
  const message = formatWebhookBindingConflicts(
    [
      {
        webhook: 'example.orders.orderCreated',
        webhookFile: '/project/workflows/src/orders/artefacts/webhooks/a.json',
        serverFunction: 'example.orders.handleOrder',
        triggerFiles: [
          '/project/workflows/src/orders/artefacts/triggers/t1.json',
          '/project/workflows/src/orders/artefacts/triggers/t2.json',
        ],
      },
    ],
    '/project'
  );
  assert.match(message, /Webhook example\.orders\.orderCreated/);
  assert.match(
    message,
    /\(workflows\/src\/orders\/artefacts\/webhooks\/a\.json\)/
  );
  assert.match(
    message,
    /workflows\/src\/orders\/artefacts\/triggers\/t1\.json, workflows\/src\/orders\/artefacts\/triggers\/t2\.json/
  );
  assert.match(message, /binding replaces the webhook's triggers/);
  assert.match(
    message,
    /remove the trigger file\(s\) or remove the webhook's serverFunction binding/
  );
});

test('the conflict check fails a push of only webhooks or only triggers', () => {
  let loads = 0;
  const load = () => {
    loads++;
    return {
      webhooks: [{ filePath: 'webhooks/orderCreated.json', content: webhook }],
      triggers: [sourcedTrigger('triggers/route.json', 'other')],
    };
  };
  for (const types of [['webhooks'], ['triggers'], ['functions', 'webhooks']]) {
    assert.throws(
      () => assertNoWebhookBindingConflicts(types, '/project', load),
      /triggers\/route\.json.*Either remove the trigger file\(s\)/
    );
  }
  assert.doesNotThrow(() =>
    assertNoWebhookBindingConflicts(['functions', 'jobs'], '/project', load)
  );
  assert.equal(loads, 3);
});
