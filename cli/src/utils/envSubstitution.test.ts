import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from '@sinclair/typebox';
import { substituteEnvTokens } from './envSubstitution';
import { JobArtifactSchema, TriggerArtifactSchema } from './schemas';

function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => void
): void {
  const previousValues = Object.fromEntries(
    Object.keys(values).map(key => [key, process.env[key]])
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previousValues)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('preserves string substitution behavior when no schema is provided', () => {
  withEnvironment(
    {
      FLOW_TEST_LEGACY_BOOLEAN: 'true',
      FLOW_TEST_LEGACY_NUMBER: '42',
    },
    () => {
      assert.deepEqual(
        substituteEnvTokens({
          booleanLike: '{{FLOW_TEST_LEGACY_BOOLEAN}}',
          numberLike: '{{FLOW_TEST_LEGACY_NUMBER}}',
        }),
        {
          booleanLike: 'true',
          numberLike: '42',
        }
      );
    }
  );
});

test('coerces exact boolean, number, and integer tokens through nested schemas', () => {
  const schema = Type.Object({
    enabled: Type.Boolean(),
    limit: Type.Number(),
    count: Type.Integer(),
    nullableEnabled: Type.Union([Type.Boolean(), Type.Null()]),
    nullableLimit: Type.Union([Type.Number(), Type.Null()]),
    nested: Type.Array(
      Type.Object({
        enabled: Type.Boolean(),
        threshold: Type.Number(),
      })
    ),
  });

  withEnvironment(
    {
      FLOW_TEST_BOOLEAN: 'true',
      FLOW_TEST_COUNT: '1e2',
      FLOW_TEST_FALSE: 'false',
      FLOW_TEST_NUMBER: '-12.5e2',
    },
    () => {
      assert.deepEqual(
        substituteEnvTokens(
          {
            enabled: '{{FLOW_TEST_BOOLEAN}}',
            limit: '{{FLOW_TEST_NUMBER}}',
            count: '{{FLOW_TEST_COUNT}}',
            nullableEnabled: '{{FLOW_TEST_FALSE}}',
            nullableLimit: '{{FLOW_TEST_COUNT}}',
            nested: [
              {
                enabled: '{{FLOW_TEST_FALSE}}',
                threshold: '{{FLOW_TEST_NUMBER}}',
              },
            ],
          },
          schema
        ),
        {
          enabled: true,
          limit: -1250,
          count: 100,
          nullableEnabled: false,
          nullableLimit: 100,
          nested: [{ enabled: false, threshold: -1250 }],
        }
      );
    }
  );
});

test('does not coerce string, Any, or mixed string unions', () => {
  const schema = Type.Object({
    text: Type.String(),
    anything: Type.Any(),
    mixed: Type.Union([Type.Number(), Type.String()]),
  });

  withEnvironment(
    {
      FLOW_TEST_AMBIGUOUS_BOOLEAN: 'true',
      FLOW_TEST_AMBIGUOUS_NUMBER: '42',
    },
    () => {
      assert.deepEqual(
        substituteEnvTokens(
          {
            text: '{{FLOW_TEST_AMBIGUOUS_NUMBER}}',
            anything: '{{FLOW_TEST_AMBIGUOUS_BOOLEAN}}',
            mixed: '{{FLOW_TEST_AMBIGUOUS_NUMBER}}',
          },
          schema
        ),
        {
          text: '42',
          anything: 'true',
          mixed: '42',
        }
      );
    }
  );
});

test('requires exact JSON boolean and finite number syntax', () => {
  const invalidNumbers = [
    '',
    ' 1',
    '01',
    '+1',
    '.5',
    '1.',
    '0x10',
    'Infinity',
    'NaN',
    '1e309',
  ];

  withEnvironment(
    {
      FLOW_TEST_INVALID_BOOLEAN: 'TRUE',
      FLOW_TEST_INVALID_INTEGER: '1.5',
      FLOW_TEST_INVALID_NUMBER: '',
    },
    () => {
      assert.equal(
        substituteEnvTokens('{{FLOW_TEST_INVALID_BOOLEAN}}', Type.Boolean()),
        'TRUE'
      );
      assert.equal(
        substituteEnvTokens('{{FLOW_TEST_INVALID_INTEGER}}', Type.Integer()),
        '1.5'
      );

      for (const invalidNumber of invalidNumbers) {
        process.env.FLOW_TEST_INVALID_NUMBER = invalidNumber;
        assert.equal(
          substituteEnvTokens('{{FLOW_TEST_INVALID_NUMBER}}', Type.Number()),
          invalidNumber
        );
      }
    }
  );
});

test('only coerces a whole token and leaves unresolved tokens intact', () => {
  const schema = Type.Object({
    literal: Type.Boolean(),
    embedded: Type.Boolean(),
    repeated: Type.Number(),
    unresolved: Type.Boolean(),
  });

  withEnvironment(
    {
      FLOW_TEST_EXACT_BOOLEAN: 'true',
      FLOW_TEST_FIRST_NUMBER: '1',
      FLOW_TEST_SECOND_NUMBER: '2',
      FLOW_TEST_UNRESOLVED_BOOLEAN: undefined,
    },
    () => {
      assert.deepEqual(
        substituteEnvTokens(
          {
            literal: 'true',
            embedded: 'prefix-{{FLOW_TEST_EXACT_BOOLEAN}}',
            repeated: '{{FLOW_TEST_FIRST_NUMBER}}{{FLOW_TEST_SECOND_NUMBER}}',
            unresolved: '{{FLOW_TEST_UNRESOLVED_BOOLEAN}}',
          },
          schema
        ),
        {
          literal: 'true',
          embedded: 'prefix-true',
          repeated: '12',
          unresolved: '{{FLOW_TEST_UNRESOLVED_BOOLEAN}}',
        }
      );
    }
  );
});

test('selects object union branches using literal discriminators', () => {
  withEnvironment(
    {
      FLOW_TEST_JOB_ENABLED: 'true',
      FLOW_TEST_INTERVAL_KIND: 'interval',
      FLOW_TEST_INTERVAL_VALUE: '30',
    },
    () => {
      assert.deepEqual(
        substituteEnvTokens(
          {
            name: 'intervalJob',
            schedule: {
              type: '{{FLOW_TEST_INTERVAL_KIND}}',
              value: '{{FLOW_TEST_INTERVAL_VALUE}}',
            },
            executionType: 'sequential',
            enabled: '{{FLOW_TEST_JOB_ENABLED}}',
            functions: [],
          },
          JobArtifactSchema
        ),
        {
          name: 'intervalJob',
          schedule: { type: 'interval', value: 30 },
          executionType: 'sequential',
          enabled: true,
          functions: [],
        }
      );

      assert.deepEqual(
        substituteEnvTokens(
          {
            name: 'periodicalJob',
            schedule: {
              type: 'periodical',
              value: '{{FLOW_TEST_INTERVAL_VALUE}}',
            },
            executionType: 'sequential',
            enabled: true,
            functions: [],
          },
          JobArtifactSchema
        ),
        {
          name: 'periodicalJob',
          schedule: { type: 'periodical', value: '30' },
          executionType: 'sequential',
          enabled: true,
          functions: [],
        }
      );
    }
  );
});

test('selects object union branches using required shape', () => {
  withEnvironment({ FLOW_TEST_TRIGGER_ENABLED: 'false' }, () => {
    assert.deepEqual(
      substituteEnvTokens(
        {
          errorHandler: { path: '/orders' },
          destination: {
            functionName: 'handleError',
            functionContext: 'example.errors',
          },
          enabled: '{{FLOW_TEST_TRIGGER_ENABLED}}',
        },
        TriggerArtifactSchema
      ),
      {
        errorHandler: { path: '/orders' },
        destination: {
          functionName: 'handleError',
          functionContext: 'example.errors',
        },
        enabled: false,
      }
    );
  });
});

test('does not coerce through an ambiguous object union', () => {
  const schema = Type.Union([
    Type.Object({ value: Type.Number() }),
    Type.Object({ value: Type.String() }),
  ]);

  withEnvironment({ FLOW_TEST_AMBIGUOUS_VALUE: '42' }, () => {
    assert.deepEqual(
      substituteEnvTokens({ value: '{{FLOW_TEST_AMBIGUOUS_VALUE}}' }, schema),
      { value: '42' }
    );
  });
});
