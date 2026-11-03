import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { McpServerFile } from '../types';
import { createSummary } from '../types/summary';
import { McpServerArtifactSchema } from '../utils/schemas';
import {
  getExistingMcpServers,
  planMcpServer,
  resolveMcpServerPayload,
  syncMcpServers,
} from './mcpServers';

const server: McpServerFile = {
  filePath: '/workspace/src/weather/artefacts/mcp-servers/weatherTools.json',
  fileName: 'weatherTools.json',
  content: {
    name: 'example-weather-tools',
    description: 'Weather lookup tools for MCP clients.',
    enabled: true,
    isPublic: false,
    toolFunctions: [
      {
        functionName: 'searchLocations',
        functionContext: 'example.weather',
        argumentConfig: [
          { key: 'name', source: 'ai' },
          { key: 'count', source: 'hardcoded', value: 3 },
        ],
      },
      {
        functionName: 'getCurrentWeather',
        functionContext: 'example.weather',
        argumentConfig: [
          { key: 'latitude', source: 'ai' },
          {
            key: 'apiKey',
            source: 'variable',
            variableName: 'weatherKey',
            variableContext: 'example.weather',
          },
        ],
      },
    ],
    oauthClientId: 'weather-client',
    oauthClientSecretVariable: {
      variableName: 'oauthSecret',
      variableContext: 'example.weather',
    },
    oauthRedirectUris: ['https://client.example.test/callback'],
  },
};

const functions = [
  {
    id: 'search-id',
    functionName: 'searchLocations',
    functionContext: 'example.weather',
  },
  {
    id: 'current-id',
    functionName: 'getCurrentWeather',
    functionContext: 'example.weather',
  },
];
const variables = [
  {
    id: 'key-id',
    variableName: 'weatherKey',
    variableContext: 'example.weather',
  },
  {
    id: 'secret-id',
    variableName: 'oauthSecret',
    variableContext: 'example.weather',
  },
];

const resolvedPayload = {
  name: 'example-weather-tools',
  description: 'Weather lookup tools for MCP clients.',
  enabled: true,
  isPublic: false,
  oauthClientId: 'weather-client',
  oauthClientSecretVariableId: 'secret-id',
  oauthRedirectUris: ['https://client.example.test/callback'],
  toolFunctions: [
    {
      id: 'search-id',
      argumentConfig: [
        { key: 'name', source: 'ai' },
        { key: 'count', source: 'hardcoded', value: 3 },
      ],
    },
    {
      id: 'current-id',
      argumentConfig: [
        { key: 'latitude', source: 'ai' },
        { key: 'apiKey', source: 'variable', variableId: 'key-id' },
      ],
    },
  ],
};

test('MCP server artefacts accept portable references and reject environment-specific IDs', () => {
  const validator = TypeCompiler.Compile(McpServerArtifactSchema);
  assert.equal(validator.Check(server.content), true);
  assert.equal(validator.Check({ name: 'minimal' }), true);
  assert.equal(validator.Check({ name: '' }), false);
  for (const remoteOnly of [
    { toolFunctionIds: ['remote-id'] },
    { oauthClientSecretVariableId: 'remote-id' },
    { environmentId: 'remote-env' },
    { mcpUrl: 'https://example.test/mcp-servers/1/mcp' },
    { context: 'example.weather' },
    { toolFunctions: [{ id: 'remote-id' }] },
  ]) {
    assert.equal(
      validator.Check({ ...server.content, ...remoteOnly }),
      false,
      JSON.stringify(remoteOnly)
    );
  }
});

test('resolves tool, variable-argument, and OAuth secret references to API IDs', () => {
  assert.deepEqual(
    resolveMcpServerPayload(server, functions, variables),
    resolvedPayload
  );
  const cleared = resolveMcpServerPayload(
    {
      ...server,
      content: { name: 'cleared', oauthClientSecretVariable: null },
    },
    functions,
    variables
  );
  assert.deepEqual(cleared, {
    name: 'cleared',
    oauthClientSecretVariableId: null,
  });
});

test('unresolvable or ambiguous references stop the plan instead of guessing', () => {
  const missingTool = planMcpServer(server, [], functions.slice(1), variables);
  assert.equal(missingTool.action, 'failed');
  assert.match(
    (missingTool as { reason: string }).reason,
    /example\.weather\.searchLocations was not found/
  );

  const ambiguous = planMcpServer(
    server,
    [],
    [...functions, { ...functions[0], id: 'other-search-id' }],
    variables
  );
  assert.match((ambiguous as { reason: string }).reason, /ambiguous/);

  const outsideNamespace = planMcpServer(
    server,
    [],
    functions,
    variables.filter(item => item.variableName !== 'oauthSecret')
  );
  assert.match(
    (outsideNamespace as { reason: string }).reason,
    /example\.weather\.oauthSecret was not found in the project namespace/
  );
});

test('plans create, noop, and changed-field updates by exact name', () => {
  assert.deepEqual(planMcpServer(server, [], functions, variables), {
    action: 'create',
    payload: resolvedPayload,
  });

  // The API adds IDs, timestamps, and derived fields that are not local changes.
  const remote = {
    ...resolvedPayload,
    id: 'mcp-id',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    environmentId: 'env-1',
    mcpUrl: 'https://na1.polyapi.io/mcp-servers/mcp-id/mcp',
    toolFunctionIds: ['search-id', 'current-id'],
  };
  const unrelated = { ...remote, id: 'other-id', name: 'someone-else' };
  const noop = planMcpServer(server, [unrelated, remote], functions, variables);
  assert.equal(noop.action, 'noop');

  const changed = planMcpServer(
    { ...server, content: { ...server.content, enabled: false } },
    [remote],
    functions,
    variables
  );
  assert.deepEqual(changed, {
    action: 'update',
    id: 'mcp-id',
    payload: { enabled: false },
    remote,
  });
});

test('duplicate remote names fail rather than updating an arbitrary server', () => {
  const plan = planMcpServer(
    server,
    [
      { id: 'one', name: server.content.name },
      { id: 'two', name: server.content.name },
    ],
    functions,
    variables
  );
  assert.equal(plan.action, 'failed');
  assert.match(
    (plan as { reason: string }).reason,
    /2 MCP servers named "example-weather-tools"/
  );
});

test('remote MCP servers are scoped to the verified target environment', async () => {
  const client = {
    GET: async () => ({
      data: [
        { id: 'a', name: 'same-name', environmentId: 'env-1' },
        { id: 'b', name: 'same-name', environmentId: 'env-2' },
        { id: 'c', name: 'unscoped' },
      ],
    }),
  } as any;
  assert.deepEqual(
    (await getExistingMcpServers(client, 'env-1'))?.map(item => item.id),
    ['a', 'c']
  );
  const failing = { GET: async () => ({ error: { message: 'nope' } }) } as any;
  assert.equal(await getExistingMcpServers(failing, 'env-1'), null);
});

test('sync previews without writing, then creates with the resolved payload', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-mcp-'));
  const directory = path.join(root, 'src/weather/artefacts/mcp-servers');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'weatherTools.json'),
    JSON.stringify(server.content)
  );
  const previousCwd = process.cwd();
  const previousNamespace = process.env.POLYAPI_NAMESPACE;
  process.chdir(root);
  process.env.POLYAPI_NAMESPACE = 'example';
  t.after(() => {
    process.chdir(previousCwd);
    if (previousNamespace === undefined) delete process.env.POLYAPI_NAMESPACE;
    else process.env.POLYAPI_NAMESPACE = previousNamespace;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writes: { method: string; path: string; body: unknown }[] = [];
  const client = {
    async GET(requestPath: string) {
      if (requestPath === '/mcp-servers') return { data: [] };
      if (requestPath === '/functions/api') {
        return {
          data: functions.map(item => ({
            id: item.id,
            name: item.functionName,
            context: item.functionContext,
          })),
        };
      }
      if (requestPath === '/variables') {
        return {
          data: variables.map(item => ({
            id: item.id,
            name: item.variableName,
            context: item.variableContext,
          })),
        };
      }
      return { data: [] };
    },
    async POST(requestPath: string, options: { body: unknown }) {
      writes.push({ method: 'POST', path: requestPath, body: options.body });
      return { data: { id: 'new-id', mcpUrl: 'https://example.test/mcp' } };
    },
    async PATCH(requestPath: string, options: { body: unknown }) {
      writes.push({ method: 'PATCH', path: requestPath, body: options.body });
      return { data: {} };
    },
  } as any;

  const preview = createSummary().mcpServers;
  await syncMcpServers(client, preview, false, {
    dryRun: true,
    environmentId: 'env-1',
  });
  assert.deepEqual(writes, []);
  assert.equal(preview.planned, 1);

  const applied = createSummary().mcpServers;
  await syncMcpServers(client, applied, false, { environmentId: 'env-1' });
  assert.equal(applied.created, 1);
  assert.equal(applied.failed, 0);
  assert.deepEqual(writes, [
    { method: 'POST', path: '/mcp-servers', body: resolvedPayload },
  ]);
});
