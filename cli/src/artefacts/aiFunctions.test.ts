import assert from 'node:assert/strict';
import test from 'node:test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { AiFunctionFile } from '../types';
import { AiFunctionArtifactSchema } from '../utils/schemas';
import { getAiFunctionRuleErrors } from '../utils/validation';
import {
  buildAiFunctionUpdatePayload,
  resolveAiFunctionPayload,
  toResolvableVariables,
} from './aiFunctions';

const aiFunction: AiFunctionFile = {
  filePath:
    '/workspace/src/weather/artefacts/ai-functions/upliftingWeather.json',
  fileName: 'upliftingWeather.json',
  content: {
    name: 'upliftingWeather',
    context: 'example.sampleAiFx',
    description:
      'Returns accurate, practical, and encouraging weather guidance.',
    visibility: 'ENVIRONMENT',
    state: 'ALPHA',
    enabled: true,
    type: 'TEXT',
    provider: 'openai',
    apiType: 'responses',
    model: 'gpt-5.5',
    arguments: [
      { key: 'location', type: 'string', required: true },
      { key: 'activity', type: 'string', required: false },
    ],
    systemPrompt: 'Use the weather tools for all weather facts.',
    inputTemplate:
      'Provide weather guidance for {{location}} in the context of {{activity}} when supplied.',
    clientPromptEnabled: false,
    clientPromptRequired: false,
    clientPromptArgName: '',
    toolFunctions: [
      {
        functionName: 'search',
        functionContext: 'accuWeather.locations',
        argumentConfig: [
          { key: 'locationText', source: 'ai' },
          {
            key: 'apiKey',
            source: 'variable',
            variableName: 'weatherApiKey',
            variableContext: 'example.sampleAiFx',
          },
        ],
      },
      {
        functionName: 'getByLocationKey',
        functionContext: 'accuWeather.currentConditions',
        argumentConfig: [
          { key: 'locationId', source: 'ai' },
          {
            key: 'apiKey',
            source: 'variable',
            variableName: 'weatherApiKey',
            variableContext: 'example.sampleAiFx',
          },
        ],
      },
    ],
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'location',
        'currentWeather',
        'description',
        'recommendedItems',
        'upliftingMessage',
      ],
      properties: {
        location: { type: 'string' },
        currentWeather: {
          type: 'object',
          additionalProperties: false,
          required: ['condition', 'temperature', 'unit'],
          properties: {
            condition: { type: 'string' },
            temperature: { type: 'number' },
            unit: { type: 'string', enum: ['C', 'F'] },
          },
        },
        description: { type: 'string' },
        recommendedItems: { type: 'array', items: { type: 'string' } },
        upliftingMessage: { type: 'string' },
      },
    },
  },
};

const artifactValidator = TypeCompiler.Compile(AiFunctionArtifactSchema);

test('accepts portable references and rejects remote ID fields', () => {
  assert.equal(artifactValidator.Check(aiFunction.content), true);
  assert.equal(
    artifactValidator.Check({
      ...aiFunction.content,
      systemPromptVariableId: 'remote-id',
    }),
    false
  );
  assert.equal(
    artifactValidator.Check({
      ...aiFunction.content,
      toolFunctions: [{ id: 'remote-id' }],
    }),
    false
  );
});

test('resolves portable AI function and variable references to API IDs', () => {
  const payload = resolveAiFunctionPayload(
    aiFunction,
    [
      {
        id: 'resolve-function-id',
        functionName: 'search',
        functionContext: 'accuWeather.locations',
      },
      {
        id: 'current-function-id',
        functionName: 'getByLocationKey',
        functionContext: 'accuWeather.currentConditions',
      },
    ],
    [
      {
        id: 'api-key-variable-id',
        variableName: 'weatherApiKey',
        variableContext: 'example.sampleAiFx',
      },
    ]
  );

  const expectedContent = { ...aiFunction.content };
  delete expectedContent.toolFunctions;

  assert.deepEqual(payload, {
    ...expectedContent,
    toolFunctions: [
      {
        id: 'resolve-function-id',
        argumentConfig: [
          { key: 'locationText', source: 'ai' },
          {
            key: 'apiKey',
            source: 'variable',
            variableId: 'api-key-variable-id',
          },
        ],
      },
      {
        id: 'current-function-id',
        argumentConfig: [
          { key: 'locationId', source: 'ai' },
          {
            key: 'apiKey',
            source: 'variable',
            variableId: 'api-key-variable-id',
          },
        ],
      },
    ],
  });
});

test('rejects an ambiguous exact tool reference instead of choosing an arbitrary ID', () => {
  const searchTool = aiFunction.content.toolFunctions?.[0];
  assert.ok(searchTool);
  const payload = resolveAiFunctionPayload(
    {
      ...aiFunction,
      content: {
        ...aiFunction.content,
        toolFunctions: [searchTool],
      },
    },
    [
      {
        id: 'environment-function-id',
        functionName: 'search',
        functionContext: 'accuWeather.locations',
      },
      {
        id: 'public-function-id',
        functionName: 'search',
        functionContext: 'accuWeather.locations',
      },
    ],
    [
      {
        id: 'api-key-variable-id',
        variableName: 'weatherApiKey',
        variableContext: 'example.sampleAiFx',
      },
    ]
  );

  assert.equal(payload, null);
});

test('builds a partial PATCH containing only changed mutable fields', () => {
  const update = buildAiFunctionUpdatePayload(
    {
      name: 'weather',
      context: 'example.ai',
      provider: 'openai',
      model: 'gpt-5.5',
      enabled: true,
    },
    {
      name: 'weather',
      context: 'example.ai',
      provider: 'openai',
      model: 'gpt-5.4',
      enabled: true,
      id: 'ai-function-id',
    }
  );

  assert.deepEqual(update, {
    payload: { model: 'gpt-5.5' },
    immutableChanges: [],
  });
});

test('reports changed create-only fields instead of PATCHing them', () => {
  const update = buildAiFunctionUpdatePayload(
    {
      context: 'example.ai',
      provider: 'openai',
    },
    {
      context: 'example.ai',
      provider: 'anthropic',
    }
  );

  assert.deepEqual(update, {
    payload: {},
    immutableChanges: ['provider'],
  });
});

test('ignores API-only metadata while comparing nested tool configuration', () => {
  const update = buildAiFunctionUpdatePayload(
    {
      toolFunctions: [
        {
          id: 'function-id',
          argumentConfig: [{ key: 'locationId', source: 'ai' }],
        },
      ],
    },
    {
      toolFunctions: [
        {
          id: 'function-id',
          name: 'getByLocationKey',
          argumentConfig: [
            {
              key: 'locationId',
              source: 'ai',
              generatedDescription: 'extra',
            },
          ],
        },
      ],
    }
  );

  assert.deepEqual(update, { payload: {}, immutableChanges: [] });
});

test('removing a property from a hardcoded tool value updates the AI Function', () => {
  const tool = (value: Record<string, unknown>) => ({
    toolFunctions: [
      {
        id: 'function-id',
        argumentConfig: [{ key: 'options', source: 'hardcoded', value }],
      },
    ],
  });
  const local = tool({ units: 'metric' });
  const update = buildAiFunctionUpdatePayload(local, {
    ...tool({ units: 'metric', legacy: true }),
    id: 'ai-function-id',
  });
  assert.deepEqual(update, { payload: local, immutableChanges: [] });
});

const voiceFunction: AiFunctionFile = {
  filePath: '/workspace/src/voice/artefacts/ai-functions/frontDesk.json',
  fileName: 'frontDesk.json',
  content: {
    name: 'frontDesk',
    context: 'example.voice',
    type: 'VOICE',
    voiceInitialMessage: null,
    twilioAuthTokenVariable: {
      variableName: 'twilioAuthToken',
      variableContext: 'example.voice',
    },
  },
};

test('voiceInitialMessage accepts null and twilioAuthTokenVariable a reference or null', () => {
  assert.equal(artifactValidator.Check(voiceFunction.content), true);
  assert.equal(
    artifactValidator.Check({
      ...voiceFunction.content,
      twilioAuthTokenVariable: null,
    }),
    true
  );
  assert.equal(
    artifactValidator.Check({
      ...voiceFunction.content,
      twilioAuthTokenVariableId: 'remote-id',
    }),
    false
  );
});

test('twilioAuthTokenVariable resolves to the ID of a SECRET variable', () => {
  const variables = toResolvableVariables([
    {
      id: 'twilio-variable-id',
      name: 'twilioAuthToken',
      context: 'example.voice',
      secrecy: 'SECRET',
    },
  ]);
  const payload = resolveAiFunctionPayload(voiceFunction, [], variables);
  assert.equal(payload?.twilioAuthTokenVariableId, 'twilio-variable-id');
  assert.equal(payload?.voiceInitialMessage, null);
  assert.equal(payload && 'twilioAuthTokenVariable' in payload, false);
});

test('twilioAuthTokenVariable rejects variables that are not SECRET', () => {
  for (const item of [
    { secrecy: 'OBSCURED' },
    { secrecy: 'NONE' },
    { secret: false },
    {},
  ]) {
    const variables = toResolvableVariables([
      {
        id: 'twilio-variable-id',
        name: 'twilioAuthToken',
        context: 'example.voice',
        ...item,
      },
    ]);
    assert.equal(resolveAiFunctionPayload(voiceFunction, [], variables), null);
  }
});

test('twilioAuthTokenVariable null reverts to platform credentials', () => {
  const payload = resolveAiFunctionPayload(
    {
      ...voiceFunction,
      content: { ...voiceFunction.content, twilioAuthTokenVariable: null },
    },
    [],
    []
  );
  assert.equal(payload?.twilioAuthTokenVariableId, null);
});

test('output and error schemas must have object roots', () => {
  assert.deepEqual(
    getAiFunctionRuleErrors({ outputSchema: aiFunction.content.outputSchema }),
    []
  );
  assert.deepEqual(getAiFunctionRuleErrors({ outputSchema: null }), []);
  for (const outputSchema of [
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
    { anyOf: [{ type: 'object' }, { type: 'string' }] },
    { enum: ['a', 'b'] },
  ]) {
    const errors = getAiFunctionRuleErrors({ outputSchema });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, '/outputSchema');
  }
  // Object type inferred from properties, and local $ref roots, are allowed.
  assert.deepEqual(
    getAiFunctionRuleErrors({
      outputSchema: { properties: { a: { type: 'string' } } },
    }),
    []
  );
  assert.deepEqual(
    getAiFunctionRuleErrors({ outputSchema: { $ref: '#/definitions/Out' } }),
    []
  );
});

test('errorSchema follows the PolyAPI failure contract', () => {
  const outputSchema = { type: 'object', properties: {} };
  const errorSchema = {
    type: 'object',
    properties: {
      status: { const: 'failed' },
      message: { type: 'string' },
    },
    required: ['status', 'message'],
  };
  assert.deepEqual(getAiFunctionRuleErrors({ outputSchema, errorSchema }), []);
  assert.match(
    getAiFunctionRuleErrors({ errorSchema })[0].message,
    /requires outputSchema/
  );
  assert.equal(
    getAiFunctionRuleErrors({
      outputSchema,
      errorSchema: { type: 'array' },
    }).length,
    3
  );
});

test('twilioAuthTokenVariable is limited to VOICE functions', () => {
  assert.equal(
    getAiFunctionRuleErrors({
      type: 'TEXT',
      twilioAuthTokenVariable: voiceFunction.content.twilioAuthTokenVariable,
    }).length,
    1
  );
  assert.deepEqual(
    getAiFunctionRuleErrors({
      type: 'VOICE',
      twilioAuthTokenVariable: voiceFunction.content.twilioAuthTokenVariable,
    }),
    []
  );
});
