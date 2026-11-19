import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import { createSummary } from '../types/summary';
import * as apiClient from '../utils/apiClient';
import {
  planGraphQLSubscriptionUpdate,
  syncGraphQLSubscriptions,
} from './subscriptions';

const local = {
  name: 'reservations',
  context: 'example.streams',
  description: 'Reservation events.',
  visibility: 'ENVIRONMENT',
  type: 'OHIP',
  websocketUrl: 'wss://ohip.example.test/subscriptions',
  query: 'subscription { newEvent { id } }',
  functionId: 'handler-id',
  enabled: true,
  ohipOffsetSelection: 'PROVIDER_HIGHEST',
  ohipMaintainOffset: true,
  eventInactivityThresholdMs: 600000,
  functionParams: { mode: 'live' },
};

const remote = {
  ...local,
  id: 'subscription-id',
  transportProtocol: 'WS',
  paramsObject: null,
  ohipOffsetSelection: undefined,
  ohipOffset: null,
};

test('unchanged subscriptions need no update', () => {
  assert.deepEqual(planGraphQLSubscriptionUpdate(local, remote), {
    structuralChanges: [],
    patch: {},
  });
});

test('non-structural changes are patched in place', () => {
  const plan = planGraphQLSubscriptionUpdate(
    {
      ...local,
      description: 'Updated.',
      enabled: false,
      eventInactivityThresholdMs: 120000,
      ohipMaintainOffset: false,
      functionParams: { mode: 'replay' },
    },
    remote
  );
  assert.deepEqual(plan.structuralChanges, []);
  assert.deepEqual(plan.patch, {
    description: 'Updated.',
    enabled: false,
    eventInactivityThresholdMs: 120000,
    ohipMaintainOffset: false,
    functionParams: { mode: 'replay' },
  });
});

test('structural changes are reported separately', () => {
  const plan = planGraphQLSubscriptionUpdate(
    {
      ...local,
      query: 'subscription { other { id } }',
      functionId: 'new-handler-id',
      description: 'Updated.',
    },
    remote
  );
  assert.deepEqual(plan.structuralChanges, ['query', 'functionId']);
  assert.deepEqual(plan.patch, { description: 'Updated.' });
});

test('force patches every patchable field including paramsObject', () => {
  const plan = planGraphQLSubscriptionUpdate(
    { ...local, paramsObject: { hotelId: 'H1' } },
    remote,
    true
  );
  assert.deepEqual(plan.structuralChanges, []);
  assert.deepEqual(plan.patch.paramsObject, { hotelId: 'H1' });
  assert.equal(plan.patch.description, local.description);
  assert.equal('ohipOffsetSelection' in plan.patch, false);
  assert.equal('query' in plan.patch, false);
  assert.equal('name' in plan.patch, false);
});

async function sync(
  t: TestContext,
  artefact: Record<string, unknown>,
  options: { dryRun?: boolean; force?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'flow-subscriptions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(process, 'cwd', () => root);
  t.mock.property(process, 'env', {
    ...process.env,
    POLYAPI_NAMESPACE: 'example',
    POLYAPI_NAMESPACES: '',
    OTP_ENABLED: 'false',
  });
  t.mock.method(apiClient, 'sleep', async () => {});
  const directory = join(root, 'src/streams/artefacts/subscriptions');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'reservations.json'), JSON.stringify(artefact));

  const requests: Array<{ method: string; route: string; body?: unknown }> = [];
  const client = createClient<paths>({
    baseUrl: 'https://polyapi.test',
    fetch: async request => {
      const route = new URL(request.url).pathname;
      const body = request.method === 'GET' ? undefined : await request.text();
      requests.push({
        method: request.method,
        route,
        body: body ? JSON.parse(body) : undefined,
      });
      if (route === '/subscriptions/graphql') {
        return Response.json([
          { id: remote.id, name: local.name, context: local.context },
        ]);
      }
      if (route === '/subscriptions/graphql/subscription-id') {
        return Response.json(remote);
      }
      if (route === '/functions/server') {
        return Response.json([
          { id: 'handler-id', name: 'handle', context: 'example.streams' },
        ]);
      }
      if (route.startsWith('/functions/server/') || route === '/variables') {
        return Response.json([]);
      }
      return Response.json({}, { status: 404 });
    },
  });

  const summary = createSummary().subscriptions;
  await syncGraphQLSubscriptions(client, summary, [], false, false, {
    ...options,
    detectOrphans: false,
  });
  return {
    summary,
    writes: requests.filter(request => request.method !== 'GET'),
  };
}

const artefact = {
  name: local.name,
  context: local.context,
  description: local.description,
  visibility: 'ENVIRONMENT',
  type: 'OHIP',
  websocketUrl: local.websocketUrl,
  query: local.query,
  destination: { functionName: 'handle', functionContext: 'example.streams' },
  enabled: true,
  ohipMaintainOffset: true,
  eventInactivityThresholdMs: 600000,
  functionParams: { mode: 'live' },
};

test('sync skips unchanged existing subscriptions', async t => {
  const { summary, writes } = await sync(t, artefact);
  assert.deepEqual(writes, []);
  assert.equal(summary.skipped, 1);
});

test('dry run plans an in-place update without writing', async t => {
  const { summary, writes } = await sync(
    t,
    { ...artefact, enabled: false },
    { dryRun: true }
  );
  assert.deepEqual(writes, []);
  assert.equal(summary.planned, 1);
});

test('sync PATCHes non-structural changes without recreating', async t => {
  const { summary, writes } = await sync(t, {
    ...artefact,
    enabled: false,
    eventInactivityThresholdMs: 120000,
  });
  assert.deepEqual(writes, [
    {
      method: 'PATCH',
      route: '/subscriptions/graphql/subscription-id',
      body: { enabled: false, eventInactivityThresholdMs: 120000 },
    },
  ]);
  assert.equal(summary.updated, 1);
  assert.equal(summary.deleted, 0);
});

test('structural changes without --force are skipped, not recreated', async t => {
  const { summary, writes } = await sync(t, {
    ...artefact,
    query: 'subscription { other { id } }',
  });
  assert.deepEqual(writes, []);
  assert.equal(summary.skipped, 1);
});

test('structural changes with --force plan a recreate in dry run', async t => {
  const { summary, writes } = await sync(
    t,
    { ...artefact, query: 'subscription { other { id } }' },
    { dryRun: true, force: true }
  );
  assert.deepEqual(writes, []);
  assert.equal(summary.planned, 1);
});
