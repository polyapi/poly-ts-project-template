import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'ava';

// Pin the reviewed MCP tool surface, so widening it fails review. These checks
// need no credentials and make no PolyAPI or provider requests.

type Binding = { key: string; source: string; value?: unknown };
type Tool = {
  functionName: string;
  functionContext: string;
  argumentConfig: Binding[];
};

const ARTEFACTS = path.resolve(__dirname, '../artefacts');
const readJson = (file: string) =>
  JSON.parse(readFileSync(path.join(ARTEFACTS, file), 'utf8'));
const SERVER = readJson('mcp-servers/weatherTools.json');
const AI = readJson('ai-functions/upliftingWeather.json');
const TOOLS: Tool[] = SERVER.toolFunctions;
const CONTEXT = TOOLS[0]?.functionContext ?? '';
const ROOT = CONTEXT.replace(/\.sampleWorkflow$/, '');

const bindings = (name: string, source: string) =>
  (TOOLS.find(tool => tool.functionName === name)?.argumentConfig ?? []).filter(
    binding => binding.source === source
  );

test('the server stays private and is named after the project namespace', t => {
  t.is(SERVER.isPublic, false);
  t.is(SERVER.enabled, true);
  t.true(CONTEXT.endsWith('.sampleWorkflow'));
  // MCP server names are unique per environment and have no context.
  t.is(SERVER.name, `${ROOT.replace(/\./g, '-')}-weather-tools`);
});

test('only the two read-only weather tools are exposed', t => {
  t.deepEqual(
    TOOLS.map(tool => `${tool.functionContext}.${tool.functionName}`),
    [`${CONTEXT}.searchLocations`, `${CONTEXT}.getCurrentWeather`]
  );
});

test('clients choose only the place and the coordinates', t => {
  t.deepEqual(
    bindings('searchLocations', 'ai').map(binding => binding.key),
    ['name']
  );
  t.deepEqual(
    bindings('getCurrentWeather', 'ai').map(binding => binding.key),
    ['latitude', 'longitude']
  );
  for (const tool of TOOLS) {
    t.true(
      tool.argumentConfig.every(
        binding => binding.source === 'ai' || binding.source === 'hardcoded'
      ),
      tool.functionName
    );
  }
});

test('provider hosts stay fixed', t => {
  const host = (name: string) =>
    bindings(name, 'hardcoded').find(binding => binding.key === 'hostUrl')
      ?.value;
  t.is(host('searchLocations'), 'https://geocoding-api.open-meteo.com');
  t.is(host('getCurrentWeather'), 'https://api.open-meteo.com');
});

test('the MCP tools use the same bindings as the Weather AI lesson', t => {
  t.deepEqual(TOOLS, AI.toolFunctions);
});

test('the artefact carries no OAuth settings or remote IDs', t => {
  for (const field of [
    'oauthClientId',
    'oauthClientSecretVariable',
    'oauthRedirectUris',
    'toolFunctionIds',
    'environmentId',
    'mcpUrl',
    'id',
  ]) {
    t.false(field in SERVER, field);
  }
});
