import test from 'ava';

const integrationTest =
  process.env.RUN_AI_INTEGRATION === 'true' ? test : test.skip;

integrationTest(
  'upliftingWeather returns its deployed structured contract',
  async t => {
    // Load the generated SDK only when the opt-in integration test runs.
    const poly = require('polyapi');
    const result = await poly.example.sampleAiFx.upliftingWeather(
      'London, United Kingdom',
      'an outdoor walk'
    );

    t.is(typeof result.location, 'string');
    t.is(typeof result.currentWeather, 'object');
    t.is(typeof result.currentWeather.condition, 'string');
    t.is(typeof result.currentWeather.temperature, 'number');
    t.true(['C', 'F'].includes(result.currentWeather.unit));
    t.is(typeof result.description, 'string');
    t.true(Array.isArray(result.recommendedItems));
    t.true(
      result.recommendedItems.every((item: unknown) => typeof item === 'string')
    );
    t.is(typeof result.upliftingMessage, 'string');
  }
);
