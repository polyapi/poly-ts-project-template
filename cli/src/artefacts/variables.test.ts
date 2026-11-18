import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import createClient from 'openapi-fetch';
import { symbols } from 'pino';
import type { paths } from '../sdk/schema';
import type { VariableFile } from '../types';
import { createSummary } from '../types/summary';
import * as apiClient from '../utils/apiClient';
import { logger } from '../utils/logger';
import { syncVariables } from './variables';

const setting = 'POLY_DEPLOY_UPDATE_EXISTING_SECRET_VARIABLES';
const identity = { name: 'settings', context: 'example.test' };
const replacement = 'synthetic-replacement';

type Scenario = {
  local?: Partial<VariableFile['content']>;
  remote?: Record<string, unknown> | null;
  allowValueUpdate?: string;
  force?: boolean;
  dryRun?: boolean;
  rejectSecrecyChange?: boolean;
  detailStatus?: number;
  apiError?: unknown;
  transportError?: boolean;
};

async function sync(t: TestContext, scenario: Scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-variables-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(process, 'cwd', () => root);
  t.mock.property(process, 'env', {
    POLYAPI_NAMESPACE: 'example',
    FLOW_TEST_VALUE: replacement,
    OTP_ENABLED: 'false',
    ...(scenario.allowValueUpdate === undefined
      ? {}
      : { [setting]: scenario.allowValueUpdate }),
  });
  t.mock.method(apiClient, 'sleep', async () => {});
  const previousLevel = logger.level;
  const messages: string[] = [];
  const stream = (logger as unknown as Record<symbol, NodeJS.WritableStream>)[
    symbols.streamSym
  ];
  t.mock.method(stream, 'write', (chunk: string) => {
    messages.push(chunk);
    return true;
  });
  logger.level = 'debug';
  t.after(() => {
    logger.level = previousLevel;
  });

  const directory = join(root, 'src/demo/artefacts/vari');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'settings.json');
  const source = JSON.stringify({
    ...identity,
    description: 'Updated metadata',
    secrecy: 'OBSCURED',
    value: '{{FLOW_TEST_VALUE}}',
    ...scenario.local,
  });
  writeFileSync(file, source);

  const remote =
    scenario.remote === null
      ? null
      : {
          ...identity,
          id: 'variable-id',
          description: 'Original metadata',
          secrecy: 'OBSCURED',
          value: '********',
          ...scenario.remote,
        };
  const writes: Array<{
    method: string;
    body?: Record<string, unknown>;
  }> = [];
  const client = createClient<paths>({
    baseUrl: 'https://polyapi.test',
    fetch: async request => {
      const route = new URL(request.url).pathname;
      if (request.method === 'GET' && route === '/variables') {
        // List responses may omit secrecy; protection must inspect the detail.
        return Response.json(remote ? [{ ...identity, id: remote.id }] : []);
      }
      if (request.method === 'GET' && route === '/variables/variable-id') {
        return Response.json(remote, {
          status: scenario.detailStatus ?? 200,
        });
      }
      if (request.method === 'PATCH' && route === '/variables/variable-id') {
        writes.push({
          method: 'PATCH',
          body: (await request.json()) as Record<string, unknown>,
        });
        if (scenario.transportError) {
          throw new Error(`Rejected value: ${replacement}`);
        }
        if (scenario.apiError) {
          return Response.json(scenario.apiError, { status: 400 });
        }
        return scenario.rejectSecrecyChange
          ? Response.json(
              { message: 'Cannot change secrecy level' },
              { status: 400 }
            )
          : Response.json({ id: 'variable-id' });
      }
      if (request.method === 'DELETE' && route === '/variables/variable-id') {
        writes.push({ method: 'DELETE' });
        return new Response(null, { status: 204 });
      }
      if (request.method === 'POST' && route === '/variables') {
        writes.push({
          method: 'POST',
          body: (await request.json()) as Record<string, unknown>,
        });
        return Response.json({ id: 'new-variable-id' }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${request.method} ${route}`);
    },
  });
  const summary = createSummary();
  const created = await syncVariables(
    client,
    summary.variables,
    summary.orphans,
    false,
    false,
    {
      force: scenario.force,
      dryRun: scenario.dryRun,
      detectOrphans: false,
    }
  );
  assert.equal(readFileSync(file, 'utf8'), source);
  return { writes, summary: summary.variables, created, messages };
}

for (const allow of [undefined, 'false', 'true']) {
  test(`forced OBSCURED updates require the value opt-in (${allow ?? 'unset'})`, async t => {
    const { writes, summary, messages } = await sync(t, {
      force: true,
      allowValueUpdate: allow,
    });
    assert.deepEqual(writes, [
      {
        method: 'PATCH',
        body: {
          ...identity,
          description: 'Updated metadata',
          secrecy: 'OBSCURED',
          ...(allow === 'true' ? { value: replacement } : {}),
        },
      },
    ]);
    assert.equal(summary.updated, 1);
    assert.equal(summary.failed, 0);
    assert.equal(
      messages
        .join('')
        .includes('Updated metadata (protected value unchanged)'),
      allow !== 'true'
    );
  });

  test(`existing OBSCURED variables require force (${allow ?? 'unset'})`, async t => {
    const { writes, summary } = await sync(t, { allowValueUpdate: allow });
    assert.deepEqual(writes, []);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.failed, 0);
  });
}

for (const value of [undefined, null, '', {}, []]) {
  test(`forced opted-in updates preserve empty values (${JSON.stringify(value)})`, async t => {
    const { writes, summary } = await sync(t, {
      local: { value },
      allowValueUpdate: 'true',
      force: true,
    });
    assert.equal(writes.length, 1);
    assert.equal('value' in (writes[0].body ?? {}), false);
    assert.equal(summary.updated, 1);
  });
}

for (const value of [
  false,
  0,
  ['configured'],
  { nested: '{{FLOW_TEST_VALUE}}' },
]) {
  test(`opted-in updates preserve non-empty value types (${JSON.stringify(value)})`, async t => {
    const { writes } = await sync(t, {
      local: { value },
      allowValueUpdate: 'true',
      force: true,
    });
    assert.deepEqual(
      writes[0].body?.value,
      typeof value === 'object' && !Array.isArray(value)
        ? { nested: replacement }
        : value
    );
  });
}

for (const secrecy of ['SECRET', 'OBSCURED', 'PARTIAL'] as const) {
  for (const allow of ['false', 'true']) {
    test(`remote ${secrecy} protection applies when local secrecy is omitted (${allow})`, async t => {
      const { writes, summary } = await sync(t, {
        local: { secrecy: undefined },
        remote: { secrecy, secret: secrecy === 'SECRET' },
        allowValueUpdate: allow,
        force: true,
      });
      assert.equal(writes.length, 1);
      assert.equal('value' in (writes[0].body ?? {}), allow === 'true');
      if (allow === 'true') assert.equal(writes[0].body?.value, replacement);
      assert.equal(summary.updated, 1);
      assert.equal(summary.failed, 0);
    });

    test(`recreation cannot bypass remote ${secrecy} protection (${allow})`, async t => {
      const { writes, summary } = await sync(t, {
        local: { secrecy: 'NONE', secret: false },
        remote: { secrecy, secret: secrecy === 'SECRET' },
        allowValueUpdate: allow,
        rejectSecrecyChange: true,
      });
      assert.deepEqual(
        writes.map(write => write.method),
        allow === 'true' ? ['PATCH', 'DELETE', 'POST'] : ['PATCH']
      );
      assert.equal(summary.failed, allow === 'true' ? 0 : 1);
      if (allow === 'true') assert.equal(writes[2].body?.value, replacement);
    });
  }
}

for (const allow of ['false', 'true']) {
  test(`local PARTIAL values require the opt-in (${allow})`, async t => {
    const { writes, summary } = await sync(t, {
      local: { secrecy: 'PARTIAL' },
      remote: { secrecy: 'PARTIAL' },
      allowValueUpdate: allow,
    });
    assert.equal(writes.length, 1);
    assert.equal('value' in (writes[0].body ?? {}), allow === 'true');
    assert.equal(summary.failed, 0);
  });

  test(`SECRET source values remain excluded (${allow})`, async t => {
    const { writes, summary } = await sync(t, {
      local: { secrecy: 'SECRET' },
      remote: { secrecy: 'SECRET' },
      allowValueUpdate: allow,
      force: true,
    });
    assert.equal(writes.length, allow === 'true' ? 1 : 0);
    if (allow === 'true') {
      assert.equal('value' in (writes[0].body ?? {}), false);
    } else {
      assert.equal(summary.skipped, 1);
    }
    assert.equal(summary.failed, 0);
  });

  test(`dry runs do not write protected values (${allow})`, async t => {
    const { writes, summary } = await sync(t, {
      allowValueUpdate: allow,
      force: true,
      dryRun: true,
    });
    assert.deepEqual(writes, []);
    assert.equal(summary.planned, 1);
    assert.equal(summary.failed, 0);
  });
}

for (const secret of [undefined, true]) {
  test(`new OBSCURED values can be initialized without force or opt-in (secret=${secret})`, async t => {
    const { writes, summary, created } = await sync(t, {
      local: { secret },
      remote: null,
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, 'POST');
    assert.equal(writes[0].body?.value, replacement);
    assert.equal(summary.created, 1);
    assert.deepEqual(created, []);
  });
}

test('ordinary values can still update without force or opt-in', async t => {
  const { writes, summary } = await sync(t, {
    local: { secrecy: 'NONE' },
    remote: { secrecy: 'NONE', value: 'previous-value' },
  });
  assert.equal(writes[0].body?.value, replacement);
  assert.equal(summary.updated, 1);
  assert.equal(summary.failed, 0);
});

test('failed detail reads cannot bypass protected-value checks', async t => {
  const { writes, summary } = await sync(t, {
    local: { secrecy: 'NONE' },
    allowValueUpdate: 'true',
    force: true,
    detailStatus: 503,
  });
  assert.deepEqual(writes, []);
  assert.equal(summary.failed, 1);
});

test('invalid opt-in settings fail before syncing', async t => {
  await assert.rejects(
    sync(t, { allowValueUpdate: 'invalid', force: true }),
    /Invalid boolean value for POLY_DEPLOY_UPDATE_EXISTING_SECRET_VARIABLES/
  );
});

for (const failure of ['none', 'api', 'transport']) {
  test(`replacement values stay out of debug and error logs (${failure})`, async t => {
    const { messages, summary } = await sync(t, {
      force: true,
      allowValueUpdate: 'true',
      apiError:
        failure === 'api'
          ? {
              message: `Rejected value: ${replacement}`,
              body: { value: replacement },
              details: [replacement],
            }
          : undefined,
      transportError: failure === 'transport',
    });
    assert.ok(messages.length > 0);
    assert.equal(messages.join('').includes(replacement), false);
    assert.equal(summary.failed, failure === 'none' ? 0 : 1);
  });
}
