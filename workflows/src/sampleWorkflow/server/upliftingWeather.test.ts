import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'ava';

// Keep the checked-in weather tools trainable and aligned with the AI bindings.
// These checks need no credentials and make no PolyAPI or provider requests.

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  description?: string;
};

type Binding = { key: string; source: string; value?: unknown };
type Parameter = { name: string; in: string; schema: Schema };
type Operation = {
  operationId: string;
  parameters: Parameter[];
  security?: unknown[];
  responses: Record<string, any>;
};

const ARTEFACTS = path.resolve(__dirname, '../artefacts');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const AI = readJson(path.join(ARTEFACTS, 'ai-functions/upliftingWeather.json'));
const SPECS_DIR = path.join(ARTEFACTS, 'specs/weather');
const SPECS = readdirSync(SPECS_DIR)
  .filter(
    name => name.endsWith('.json') && !/\.poly(?:-model)?\.json$/.test(name)
  )
  .map(name => readJson(path.join(SPECS_DIR, name)));

// The platform translator camel-cases this provider parameter. An offline test
// cannot prove the translation; inspect the trained model to confirm it.
const TRANSLATED_ARGUMENTS: Record<string, string> = {
  temperature_unit: 'temperatureUnit',
};

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'description',
]);

const typeOf = (value: unknown) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
};

/** Report violations of the JSON Schema keywords these contracts use. */
function violations(schema: Schema, value: unknown, at = '$'): string[] {
  const unsupported = Object.keys(schema).filter(
    keyword => !SUPPORTED_KEYWORDS.has(keyword)
  );
  if (unsupported.length)
    throw new Error(`${at} uses unsupported keyword(s): ${unsupported}`);
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = [schema.type].flat();
    if (
      !allowed.some(
        type => type === actual || (type === 'number' && actual === 'integer')
      )
    )
      return [`${at} must be ${allowed.join(' or ')}, not ${actual}`];
  }
  const errors: string[] = [];
  if (
    schema.enum &&
    !schema.enum.some(
      option => JSON.stringify(option) === JSON.stringify(value)
    )
  )
    errors.push(`${at} must be one of the declared values`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${at} must be at most ${schema.maximum}`);
  }
  if (
    typeof value === 'string' &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  )
    errors.push(`${at} must have at least ${schema.minLength} characters`);
  if (Array.isArray(value) && schema.items) {
    const items = schema.items;
    value.forEach((item, index) => {
      errors.push(...violations(items, item, `${at}[${index}]`));
    });
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in object)) errors.push(`${at}.${key} is required`);
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...violations(property, item, `${at}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${at}.${key} is not allowed`);
    }
  }
  return errors;
}

const operation = (spec: any): Operation =>
  (Object.values(spec.paths)[0] as Record<string, Operation>).get;
const responseSchema = (spec: any): Schema =>
  operation(spec).responses['200'].content['application/json'].schema;
const specFor = (operationId: string) => {
  const spec = SPECS.find(item => operation(item).operationId === operationId);
  if (!spec) throw new Error(`No bundled spec declares ${operationId}`);
  return spec;
};

test('weather tools match the bundled training contracts without credentials', t => {
  const tools = new Map<
    string,
    { functionContext: string; argumentConfig: Binding[] }
  >(
    AI.toolFunctions.map((tool: { functionName: string }) => [
      tool.functionName,
      tool,
    ])
  );
  t.deepEqual(
    [...tools.keys()].sort(),
    SPECS.map(spec => operation(spec).operationId).sort()
  );
  for (const spec of SPECS) {
    const endpoint = operation(spec);
    const tool = tools.get(endpoint.operationId);
    if (!tool) throw new Error(`Missing tool for ${endpoint.operationId}`);
    t.is(tool.functionContext, AI.context);
    const bindings = new Map(
      tool.argumentConfig.map(entry => [entry.key, entry])
    );
    const parameters = new Map(
      endpoint.parameters.map(entry => [
        TRANSLATED_ARGUMENTS[entry.name] ?? entry.name,
        entry,
      ])
    );
    // Flow's translation adds hostUrl to the provider's query arguments.
    t.deepEqual(
      [...bindings.keys()].sort(),
      [...parameters.keys(), 'hostUrl'].sort()
    );
    t.deepEqual(bindings.get('hostUrl'), {
      key: 'hostUrl',
      source: 'hardcoded',
      value: spec.servers[0].url,
    });
    t.falsy(spec.security?.length || endpoint.security?.length);
    t.falsy(spec.components?.securitySchemes);
    for (const binding of bindings.values())
      t.true(['ai', 'hardcoded'].includes(binding.source), binding.key);
    for (const [name, parameter] of parameters) {
      t.is(parameter.in, 'query', name);
      const binding = bindings.get(name);
      if (binding?.source === 'hardcoded')
        t.deepEqual(violations(parameter.schema, binding.value), [], name);
    }
  }
  const weather = tools.get('getCurrentWeather');
  const current = weather?.argumentConfig.find(
    entry => entry.key === 'current'
  );
  const fields = String(current?.value).split(',');
  const schema = responseSchema(specFor('getCurrentWeather'));
  for (const section of ['current', 'current_units']) {
    const required = schema.properties?.[section]?.required ?? [];
    t.deepEqual(
      fields.filter(field => !required.includes(field)),
      [],
      section
    );
  }
});

for (const result of [{}, { results: [] }]) {
  test(`location contract accepts no matches: ${JSON.stringify(result)}`, t => {
    t.deepEqual(
      violations(responseSchema(specFor('searchLocations')), result),
      []
    );
  });
}

test('location contract requires coordinates for a candidate', t => {
  const schema = responseSchema(specFor('searchLocations'));
  t.notDeepEqual(
    violations(schema, { results: [{ id: 1, name: 'London' }] }),
    []
  );
});

for (const currentWeather of [
  null,
  { condition: 'Overcast', temperature: 12, unit: 'C' },
]) {
  test(`output accepts ${currentWeather ? 'available' : 'unavailable'} weather and requires attribution`, t => {
    const output: Record<string, unknown> = {
      location: 'London, United Kingdom',
      currentWeather,
      description: currentWeather
        ? 'Current conditions'
        : 'Weather unavailable',
      recommendedItems: [],
      upliftingMessage: 'Enjoy your day.',
      attribution: AI.outputSchema.properties.attribution.enum[0],
    };
    t.deepEqual(violations(AI.outputSchema, output), []);
    delete output.attribution;
    t.notDeepEqual(violations(AI.outputSchema, output), []);
  });
}

test('weather contract allows null measurements but requires response structure', t => {
  const schema = responseSchema(specFor('getCurrentWeather'));
  const current = {
    time: '2026-01-01T12:00',
    interval: 900,
    temperature_2m: null,
    apparent_temperature: null,
    precipitation: null,
    weather_code: null,
    wind_speed_10m: null,
  };
  const result: Record<string, unknown> = {
    current,
    current_units: Object.fromEntries(
      Object.keys(current).map(key => [key, 'unit'])
    ),
  };
  t.deepEqual(violations(schema, result), []);
  delete result.current_units;
  t.notDeepEqual(violations(schema, result), []);
});
