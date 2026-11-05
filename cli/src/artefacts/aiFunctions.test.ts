import assert from 'node:assert/strict';
import test from 'node:test';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { AiFunctionFile } from '../types';
import { AiFunctionArtifactSchema } from '../utils/schemas';
import {
  buildAiFunctionUpdatePayload,
  resolveAiFunctionPayload,
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
