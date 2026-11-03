/**
 * Typebox schemas for PolyAPI artifact validation
 *
 * These schemas are derived from the PolyAPI OpenAPI specification and
 * validate JSON artifact files before syncing to the API.
 */

import { type Static, Type } from '@sinclair/typebox';

/**
 * Common enum types
 */
const Visibility = Type.Union([
  Type.Literal('ENVIRONMENT'),
  Type.Literal('TENANT'),
  Type.Literal('PUBLIC'),
]);

const State = Type.Union([
  Type.Literal('ALPHA'),
  Type.Literal('BETA'),
  Type.Literal('STABLE'),
  Type.Literal('DEPRECATED'),
  Type.Literal('DISABLED'),
]);

const Secrecy = Type.Union([
  Type.Literal('SECRET'),
  Type.Literal('OBSCURED'),
  Type.Literal('PARTIAL'),
  Type.Literal('NONE'),
]);

const HttpMethod = Type.Union([
  Type.Literal('GET'),
  Type.Literal('POST'),
  Type.Literal('PUT'),
  Type.Literal('PATCH'),
  Type.Literal('DELETE'),
  Type.Literal('HEAD'),
]);

/**
 * Schema Artifact (CreateSchemaDto)
 */
export const SchemaArtifactSchema = Type.Object(
  {
    name: Type.String(),
    context: Type.Optional(Type.String()),
    schema: Type.Any(), // JSON Schema definition
    visibility: Type.Optional(Visibility),
    ownerUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  {
    $id: 'SchemaArtifact',
    additionalProperties: false,
  }
);

export type SchemaArtifact = Static<typeof SchemaArtifactSchema>;

/**
 * Webhook Security Function
 * id can be either:
 * - A UUID (e.g., "90188dcb-9a55-4ea7-8cb6-117268e7d4cb")
 * - A reference (e.g., "{{example.utilities.validateWebhookSecurity}}")
 */
const WebhookSecurityFunction = Type.Object(
  {
    id: Type.String(),
    message: Type.String(),
  },
  {
    additionalProperties: false,
  }
);

/**
 * Webhook XML Parser Options
 */
const WebhookHandleXmlParserOptions = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    explicitArray: Type.Optional(Type.Boolean()),
    mergeAttrs: Type.Optional(Type.Boolean()),
    normalizeTags: Type.Optional(Type.Boolean()),
    explicitRoot: Type.Optional(Type.Boolean()),
    tagNameProcessors: Type.Optional(Type.Array(Type.String())),
    attrNameProcessors: Type.Optional(Type.Array(Type.String())),
    valueProcessors: Type.Optional(Type.Array(Type.String())),
    attrValueProcessors: Type.Optional(Type.Array(Type.String())),
  },
  {
    additionalProperties: false,
  }
);

/**
 * Webhook Artifact (CreateWebhookHandleDto)
 */
export const WebhookArtifactSchema = Type.Object(
  {
    name: Type.String(),
    context: Type.Optional(Type.String()),
    eventPayload: Type.Optional(Type.Record(Type.String(), Type.Any())),
    eventPayloadTypeSchema: Type.Optional(
      Type.Record(Type.String(), Type.Any())
    ),
    description: Type.String(),
    visibility: Type.Optional(Visibility),
    state: Type.Optional(State),
    responsePayload: Type.Optional(Type.Record(Type.String(), Type.Any())),
    responseHeaders: Type.Optional(Type.Record(Type.String(), Type.Any())),
    responseStatus: Type.Optional(Type.Number()),
    slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    subpath: Type.Optional(Type.String()),
    method: Type.Optional(HttpMethod),
    requirePolyApiKey: Type.Optional(Type.Boolean()),
    securityFunctions: Type.Optional(Type.Array(WebhookSecurityFunction)),
    xmlParserOptions: Type.Optional(WebhookHandleXmlParserOptions),
    ownerUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  {
    $id: 'WebhookArtifact',
    additionalProperties: false,
  }
);

export type WebhookArtifact = Static<typeof WebhookArtifactSchema>;

/**
 * Function Argument
 */
const FunctionArgument = Type.Object(
  {
    name: Type.String(),
    type: Type.Optional(Type.String()),
    required: Type.Optional(Type.Boolean()),
    schema: Type.Optional(Type.Any()),
    description: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  }
);

/**
 * Function Artifact (CreateServerCustomFunctionDto - metadata only)
 */
export const FunctionArtifactSchema = Type.Object(
  {
    name: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    context: Type.Optional(Type.String()),
    visibility: Type.Optional(Visibility),
    state: Type.Optional(State),
    logsEnabled: Type.Optional(Type.Boolean()),
    serverSideAsync: Type.Optional(Type.Boolean()),
    generateContexts: Type.Optional(Type.Array(Type.String())),
    executionApiKey: Type.Optional(Type.String()),
    cachePolyLibrary: Type.Optional(Type.Boolean()),
    language: Type.Optional(Type.String()),
    typeSchemas: Type.Optional(Type.Record(Type.String(), Type.Any())),
    returnType: Type.Optional(Type.String()),
    returnTypeSchema: Type.Optional(Type.Record(Type.String(), Type.Any())),
    arguments: Type.Optional(Type.Array(FunctionArgument)),
    requirements: Type.Optional(Type.Array(Type.String())),
    internalDependencies: Type.Optional(Type.Record(Type.String(), Type.Any())),
    externalDependencies: Type.Optional(Type.Record(Type.String(), Type.Any())),
    ownerUserId: Type.Optional(Type.String()),
    server: Type.Optional(Type.Boolean()), // CLI-specific flag
  },
  {
    $id: 'FunctionArtifact',
    additionalProperties: false,
  }
);

export type FunctionArtifact = Static<typeof FunctionArtifactSchema>;

const AiVariableReference = Type.Object(
  {
    variableName: Type.String(),
    variableContext: Type.String(),
  },
  { additionalProperties: false }
);

const AiFunctionArgument = Type.Object(
  {
    key: Type.String(),
    name: Type.Optional(Type.String()),
    type: Type.String(),
    required: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
    typeSchema: Type.Optional(Type.Record(Type.String(), Type.Any())),
    secure: Type.Optional(Type.Boolean()),
    payload: Type.Optional(Type.Boolean()),
    variable: Type.Optional(Type.String()),
    removeIfNotPresentOnExecute: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

const AiFunctionArgumentConfig = Type.Union([
  Type.Object(
    {
      key: Type.String(),
      source: Type.Literal('ai'),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      key: Type.String(),
      source: Type.Literal('hardcoded'),
      value: Type.Any(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      key: Type.String(),
      source: Type.Literal('argument'),
      argumentKey: Type.String(),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      key: Type.String(),
      source: Type.Literal('variable'),
      variableName: Type.String(),
      variableContext: Type.String(),
    },
    { additionalProperties: false }
  ),
]);

const AiToolFunction = Type.Object(
  {
    functionName: Type.String(),
    functionContext: Type.String(),
    argumentConfig: Type.Optional(Type.Array(AiFunctionArgumentConfig)),
  },
  { additionalProperties: false }
);

/**
 * AI Function Artifact (CreateAiFunctionV2Dto with portable name/context
 * references in place of remote IDs)
 */
export const AiFunctionArtifactSchema = Type.Object(
  {
    name: Type.String(),
    context: Type.String(),
    description: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    apiType: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    systemPrompt: Type.Optional(Type.String()),
    systemPromptVariable: Type.Optional(AiVariableReference),
    inputTemplate: Type.Optional(Type.String()),
    arguments: Type.Optional(Type.Array(AiFunctionArgument)),
    returnType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    returnTypeSchema: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])
    ),
    outputSchema: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])
    ),
    toolFunctions: Type.Optional(Type.Array(AiToolFunction)),
    clientPromptEnabled: Type.Optional(Type.Boolean()),
    clientPromptRequired: Type.Optional(Type.Boolean()),
    clientPromptArgName: Type.Optional(Type.String()),
    visibility: Type.Optional(Visibility),
    state: Type.Optional(State),
    enabled: Type.Optional(Type.Boolean()),
    type: Type.Optional(Type.String()),
    voiceConnectProvider: Type.Optional(Type.String()),
    voiceOutput: Type.Optional(
      Type.Union([
        Type.Literal('ALLOY'),
        Type.Literal('ASH'),
        Type.Literal('BALLAD'),
        Type.Literal('CORAL'),
        Type.Literal('ECHO'),
        Type.Literal('SAGE'),
        Type.Literal('SHIMMER'),
        Type.Literal('VERSE'),
      ])
    ),
    voiceInitialMessage: Type.Optional(Type.String({ maxLength: 500 })),
  },
  {
    $id: 'AiFunctionArtifact',
    additionalProperties: false,
  }
);

export type AiFunctionArtifact = Static<typeof AiFunctionArtifactSchema>;

/**
 * MCP Server Artifact (CreateMCPServerDto with portable tool and OAuth secret
 * references in place of remote IDs). MCP servers have no context, so Flow
 * identifies them by exact name within the verified target environment.
 */
export const McpServerArtifactSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    isPublic: Type.Optional(Type.Boolean()),
    toolFunctions: Type.Optional(Type.Array(AiToolFunction)),
    oauthClientId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    oauthClientSecretVariable: Type.Optional(
      Type.Union([AiVariableReference, Type.Null()])
    ),
    oauthRedirectUris: Type.Optional(Type.Array(Type.String())),
  },
  {
    $id: 'McpServerArtifact',
    additionalProperties: false,
  }
);

export type McpServerArtifact = Static<typeof McpServerArtifactSchema>;

/**
 * Trigger Source
 */
const TriggerSource = Type.Object(
  {
    webhookName: Type.String(),
    webhookContext: Type.String(),
  },
  {
    additionalProperties: false,
  }
);

/**
 * Trigger Destination
 */
const TriggerDestination = Type.Object(
  {
    functionName: Type.String(),
    functionContext: Type.String(),
  },
  {
    additionalProperties: false,
  }
);

/**
 * Trigger Artifact
 */

const ErrorHandlerSource = Type.Object(
  {
    path: Type.String(),
    applicationIds: Type.Optional(Type.Array(Type.String())),
    userIds: Type.Optional(Type.Array(Type.String())),
    functionIds: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);

const WebhookTriggerArtifact = Type.Object(
  {
    name: Type.Optional(Type.String()),
    source: TriggerSource,
    destination: TriggerDestination,
    waitForResponse: Type.Optional(Type.Boolean()),
    ownerUserId: Type.Optional(Type.String()),
  },
  { $id: 'WebhookTriggerArtifact', additionalProperties: false }
);

const ErrorHandlerTriggerArtifact = Type.Object(
  {
    name: Type.Optional(Type.String()),
    errorHandler: ErrorHandlerSource,
    destination: TriggerDestination,
    enabled: Type.Optional(Type.Boolean()),
    ownerUserId: Type.Optional(Type.String()),
  },
  { $id: 'ErrorHandlerTriggerArtifact', additionalProperties: false }
);

export const TriggerArtifactSchema = Type.Union([
  WebhookTriggerArtifact,
  ErrorHandlerTriggerArtifact,
]);

export type WebhookTriggerArtifact = Static<typeof WebhookTriggerArtifact>;
export type ErrorHandlerTriggerArtifact = Static<
  typeof ErrorHandlerTriggerArtifact
>;
export type TriggerArtifact = Static<typeof TriggerArtifactSchema>;

const GraphQLSubscriptionType = Type.Union([
  Type.Literal('CUSTOM'),
  Type.Literal('OHIP'),
]);

const GraphQLSubscriptionTransportProtocol = Type.Union([
  Type.Literal('WS'),
  Type.Literal('HTTP'),
]);

const GraphQLSubscriptionOffsetSelection = Type.Union([
  Type.Literal('PROVIDER_HIGHEST'),
  Type.Literal('SPECIFIC'),
  Type.Literal('PERSISTED'),
]);

const GraphQLSubscriptionDestination = Type.Object(
  {
    functionName: Type.String(),
    functionContext: Type.String(),
  },
  { additionalProperties: false }
);

/**
 * GraphQL Subscription Artifact (GraphQLSubscriptionCreateDto with
 * destination referenced by function name and context instead of function ID)
 */
export const GraphQLSubscriptionArtifactSchema = Type.Object(
  {
    name: Type.String(),
    context: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ownerUserId: Type.Optional(Type.String()),
    visibility: Type.Optional(
      Type.Union([Type.Literal('ENVIRONMENT'), Type.Literal('TENANT')])
    ),
    type: GraphQLSubscriptionType,
    transportProtocol: Type.Optional(GraphQLSubscriptionTransportProtocol),
    websocketUrl: Type.String(),
    query: Type.String(),
    paramsVariableId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    paramsSfxId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    paramsObject: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])
    ),
    destination: GraphQLSubscriptionDestination,
    functionParams: Type.Optional(
      Type.Union([
        Type.Record(Type.String(), Type.Any()),
        Type.Array(Type.Any()),
        Type.Null(),
      ])
    ),
    enabled: Type.Optional(Type.Boolean()),
    ohipOffsetSelection: Type.Optional(GraphQLSubscriptionOffsetSelection),
    ohipOffset: Type.Optional(Type.String({ maxLength: 256 })),
    ohipMaintainOffset: Type.Optional(Type.Boolean()),
    eventInactivityThresholdMs: Type.Optional(
      Type.Union([
        Type.Number({ minimum: 60000, maximum: 86400000 }),
        Type.Null(),
      ])
    ),
  },
  {
    $id: 'GraphQLSubscriptionArtifact',
    additionalProperties: false,
  }
);

export type GraphQLSubscriptionArtifact = Static<
  typeof GraphQLSubscriptionArtifactSchema
>;

/**
 * Variable Artifact (ConfigVariableDto with CLI extensions)
 *
 * Note: The API uses ConfigVariable endpoints, but our CLI calls them "variables"
 * The CLI also adds a 'schema' field for local validation that isn't sent to the API
 */
export const VariableArtifactSchema = Type.Object(
  {
    name: Type.String(),
    context: Type.String(),
    description: Type.Optional(Type.String()),
    instruction: Type.Optional(Type.String()), // CLI-specific: instructions for setting value
    value: Type.Optional(Type.Any()),
    secret: Type.Optional(Type.Boolean()), // Deprecated field, use secrecy instead
    secrecy: Type.Optional(Secrecy),
    visibility: Type.Optional(Visibility),
    state: Type.Optional(State),
    expiresAt: Type.Optional(Type.String()),
    ownerUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    schema: Type.Optional(Type.Any()), // CLI-specific: JSON Schema for value validation (not sent to API)
  },
  {
    $id: 'VariableArtifact',
    additionalProperties: false,
  }
);

export type VariableArtifact = Static<typeof VariableArtifactSchema>;

/**
 * Table Column Definition
 */
const TableColumnSchema = Type.Object(
  {
    name: Type.String(),
    type: Type.String(),
    default: Type.Optional(Type.Any()),
    required: Type.Optional(Type.Boolean()),
    unique: Type.Optional(Type.Boolean()),
    primary: Type.Optional(Type.Boolean()),
    schema: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])
    ),
  },
  { additionalProperties: false }
);

/**
 * Table Artifact (CreateTableDto)
 */
export const TableArtifactSchema = Type.Object(
  {
    name: Type.String(),
    context: Type.String(),
    description: Type.Optional(Type.String()),
    ownerUserId: Type.Optional(Type.String()),
    visibility: Type.Optional(Visibility),
    columns: Type.Array(TableColumnSchema),
  },
  {
    $id: 'TableArtifact',
    additionalProperties: false,
  }
);

export type TableArtifact = Static<typeof TableArtifactSchema>;

/**
 * Job Schedule Types
 */
const JobSchedulePeriodical = Type.Object(
  {
    type: Type.Literal('periodical'),
    value: Type.String(),
    acceptableDelayTime: Type.Optional(
      Type.Union([Type.Number(), Type.Null()])
    ),
  },
  { additionalProperties: false }
);

const JobScheduleInterval = Type.Object(
  {
    type: Type.Literal('interval'),
    value: Type.Number(),
    acceptableDelayTime: Type.Optional(
      Type.Union([Type.Number(), Type.Null()])
    ),
  },
  { additionalProperties: false }
);

const JobScheduleOnTime = Type.Object(
  {
    type: Type.Literal('on_time'),
    value: Type.String(),
    acceptableDelayTime: Type.Optional(
      Type.Union([Type.Number(), Type.Null()])
    ),
  },
  { additionalProperties: false }
);

const JobSchedule = Type.Union([
  JobSchedulePeriodical,
  JobScheduleInterval,
  JobScheduleOnTime,
]);

/**
 * Job Function Reference (resolved to ID at sync time)
 */
const JobFunctionRefSchema = Type.Object(
  {
    functionName: Type.String(),
    functionContext: Type.String(),
    eventPayload: Type.Optional(Type.Record(Type.String(), Type.Any())),
    headersPayload: Type.Optional(Type.Record(Type.String(), Type.Any())),
    paramsPayload: Type.Optional(Type.Record(Type.String(), Type.Any())),
  },
  { additionalProperties: false }
);

/**
 * Job Artifact (CreateJobDto — functions referenced by name+context, not ID)
 */
export const JobArtifactSchema = Type.Object(
  {
    name: Type.String(),
    schedule: JobSchedule,
    executionType: Type.Union([
      Type.Literal('sequential'),
      Type.Literal('parallel'),
    ]),
    enabled: Type.Boolean(),
    functions: Type.Array(JobFunctionRefSchema),
    ownerUserId: Type.Optional(Type.String()),
  },
  {
    $id: 'JobArtifact',
    additionalProperties: false,
  }
);

export type JobArtifact = Static<typeof JobArtifactSchema>;
