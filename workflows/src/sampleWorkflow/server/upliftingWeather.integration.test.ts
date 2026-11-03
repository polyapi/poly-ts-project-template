import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'ava';

const integrationTest =
  process.env.RUN_AI_INTEGRATION === 'true' ? test : test.skip;

const artefact = JSON.parse(
  readFileSync(
    path.join(__dirname, '../artefacts/ai-functions/upliftingWeather.json'),
    'utf8'
  )
);

integrationTest(
  'upliftingWeather returns its deployed structured contract',
  async t => {
    // Load the generated SDK only when the opt-in integration test runs.
    const poly = require('polyapi');
    const result = await poly.example.sampleWorkflow.upliftingWeather(
      'London, United Kingdom',
      'an outdoor walk'
    );

    // The output schema requires every declared field and allows no others.
    t.deepEqual(
      Object.keys(result).sort(),
      [...artefact.outputSchema.required].sort()
    );
    t.true(typeof result.location === 'string' && result.location.length > 0);
    t.not(result.currentWeather, null);
    t.is(typeof result.currentWeather.condition, 'string');
    t.is(typeof result.currentWeather.temperature, 'number');
    t.is(result.currentWeather.unit, 'C');
    t.true(
      typeof result.description === 'string' && result.description.length > 0
    );
    t.true(Array.isArray(result.recommendedItems));
    t.true(
      result.recommendedItems.every((item: unknown) => typeof item === 'string')
    );
    t.true(
      typeof result.upliftingMessage === 'string' &&
        result.upliftingMessage.length > 0
    );
    t.is(
      result.attribution,
      artefact.outputSchema.properties.attribution.enum[0]
    );
  }
);
