import assert from 'node:assert/strict';
import test from 'node:test';
import { substituteEnvTokens } from './envSubstitution';

const VARIABLE = 'FLOW_BOOLEAN_PLACEHOLDER_TEST';

function withVariable(value: string, run: () => void): void {
  const previous = process.env[VARIABLE];
  process.env[VARIABLE] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[VARIABLE];
    else process.env[VARIABLE] = previous;
  }
}

test('converts exact env placeholders for root artifact boolean attributes', () => {
  for (const [value, expected] of [
    ['true', true],
    ['TRUE', true],
    ['TrUe', true],
    ['1', true],
    ['false', false],
    ['FALSE', false],
    ['FaLsE', false],
    ['0', false],
  ] as const) {
    withVariable(value, () => {
      const result = substituteEnvTokens({
        enabled: `{{${VARIABLE}}}`,
        isPublic: `{{${VARIABLE}}}`,
        waitForResponse: `{{${VARIABLE}}}`,
        ohipMaintainOffset: `{{${VARIABLE}}}`,
        requirePolyApiKey: `{{${VARIABLE}}}`,
        logsEnabled: `{{${VARIABLE}}}`,
        cachePolyLibrary: `{{${VARIABLE}}}`,
        clientPromptEnabled: `{{${VARIABLE}}}`,
        clientPromptRequired: `{{${VARIABLE}}}`,
        secret: `{{${VARIABLE}}}`,
      });

      for (const actual of Object.values(result)) {
        assert.equal(actual, expected);
      }
    });
  }
});

test('converts nested webhook, function argument, and table boolean attributes', () => {
  withVariable('false', () => {
    assert.deepEqual(
      substituteEnvTokens({
        xmlParserOptions: {
          enabled: `{{${VARIABLE}}}`,
          explicitArray: `{{${VARIABLE}}}`,
          mergeAttrs: `{{${VARIABLE}}}`,
          normalizeTags: `{{${VARIABLE}}}`,
          explicitRoot: `{{${VARIABLE}}}`,
        },
        arguments: [
          {
            required: `{{${VARIABLE}}}`,
            secure: `{{${VARIABLE}}}`,
            payload: `{{${VARIABLE}}}`,
            removeIfNotPresentOnExecute: `{{${VARIABLE}}}`,
          },
        ],
        columns: [
          {
            required: `{{${VARIABLE}}}`,
            unique: `{{${VARIABLE}}}`,
            primary: `{{${VARIABLE}}}`,
          },
        ],
      }),
      {
        xmlParserOptions: {
          enabled: false,
          explicitArray: false,
          mergeAttrs: false,
          normalizeTags: false,
          explicitRoot: false,
        },
        arguments: [
          {
            required: false,
            secure: false,
            payload: false,
            removeIfNotPresentOnExecute: false,
          },
        ],
        columns: [{ required: false, unique: false, primary: false }],
      }
    );
  });
});

test('does not coerce literal strings, non-boolean fields, payload data, partial tokens, or invalid values', () => {
  withVariable('false', () => {
    assert.deepEqual(
      substituteEnvTokens({
        description: `{{${VARIABLE}}}`,
        eventPayload: { enabled: `{{${VARIABLE}}}` },
        enabled: `prefix-{{${VARIABLE}}}`,
        isPublic: 'false',
      }),
      {
        description: 'false',
        eventPayload: { enabled: 'false' },
        enabled: 'prefix-false',
        isPublic: 'false',
      }
    );
  });

  for (const value of ['yes', '2', '', ' true ']) {
    withVariable(value, () => {
      assert.equal(
        substituteEnvTokens({ enabled: `{{${VARIABLE}}}` }).enabled,
        value
      );
    });
  }
});
