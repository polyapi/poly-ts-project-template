/**
 * Type definitions for CLI artifacts and operations
 */

export interface WebhookFile {
  filePath: string;
  fileName: string;
  content: any;
}

export interface CanopyFile {
  filePath: string;
  fileName: string;
  content: {
    id?: string;
    name?: string;
    subpath?: string;
    description?: string;
  } & Record<string, unknown>;
}

export interface FunctionFile {
  tsFilePath: string;
  type: 'client' | 'server';
  metadata: {
    name: string;
    context: string;
    description: string;
    visibility?: 'ENVIRONMENT' | 'TENANT' | 'PUBLIC';
    logsEnabled?: boolean;
    generateContexts?: string[];
    executionApiKey?: string;
    cachePolyLibrary?: boolean;
  };
}

export interface AiFunctionReference {
  functionName: string;
  functionContext: string;
}

export interface AiVariableReference {
  variableName: string;
  variableContext: string;
}

export interface AiFunctionArgumentConfig {
  key: string;
  source: 'ai' | 'hardcoded' | 'argument' | 'variable';
  value?: unknown;
  argumentKey?: string;
  variableName?: string;
  variableContext?: string;
}

export interface AiToolFunction extends AiFunctionReference {
  argumentConfig?: AiFunctionArgumentConfig[];
}

export interface McpServerFile {
  filePath: string;
  fileName: string;
  content: {
    name: string;
    description?: string;
    enabled?: boolean;
    isPublic?: boolean;
    toolFunctions?: AiToolFunction[];
    oauthClientId?: string | null;
    oauthClientSecretVariable?: AiVariableReference | null;
    oauthRedirectUris?: string[];
  };
}

export interface AiFunctionFile {
  filePath: string;
  fileName: string;
  content: {
    name: string;
    context: string;
    description?: string;
    visibility?: 'ENVIRONMENT' | 'TENANT' | 'PUBLIC';
    state?: 'ALPHA' | 'BETA' | 'STABLE' | 'DEPRECATED' | 'DISABLED';
    enabled?: boolean;
    type?: string;
    provider?: string;
    apiType?: string;
    model?: string;
    arguments?: Array<Record<string, unknown>>;
    returnType?: string | null;
    returnTypeSchema?: Record<string, unknown> | null;
    systemPrompt?: string;
    systemPromptVariable?: AiVariableReference;
    inputTemplate?: string;
    clientPromptEnabled?: boolean;
    clientPromptRequired?: boolean;
    clientPromptArgName?: string;
    toolFunctions?: AiToolFunction[];
    outputSchema?: Record<string, unknown> | null;
    voiceConnectProvider?: string;
    voiceOutput?:
      | 'ALLOY'
      | 'ASH'
      | 'BALLAD'
      | 'CORAL'
      | 'ECHO'
      | 'SAGE'
      | 'SHIMMER'
      | 'VERSE';
    voiceInitialMessage?: string;
  };
}

export interface WebhookTriggerFileContent {
  name?: string;
  source: {
    webhookName: string;
    webhookContext: string;
  };
  destination: {
    functionName: string;
    functionContext: string;
  };
  waitForResponse?: boolean;
  ownerUserId?: string;
}

export interface ErrorHandlerTriggerFileContent {
  name?: string;
  errorHandler: {
    path: string;
    applicationIds?: string[];
    userIds?: string[];
    functionIds?: string[];
  };
  destination: {
    functionName: string;
    functionContext: string;
  };
  enabled?: boolean;
  ownerUserId?: string;
}

export type TriggerFileContent =
  | WebhookTriggerFileContent
  | ErrorHandlerTriggerFileContent;

export interface TriggerFile {
  filePath: string;
  fileName: string;
  content: TriggerFileContent;
}

export interface GraphQLSubscriptionFile {
  filePath: string;
  fileName: string;
  content: {
    name: string;
    context: string;
    description?: string | null;
    ownerUserId?: string;
    visibility?: 'ENVIRONMENT' | 'TENANT';
    type: 'CUSTOM' | 'OHIP';
    transportProtocol?: 'WS' | 'HTTP';
    websocketUrl: string;
    query: string;
    paramsVariableId?: string | null;
    paramsSfxId?: string | null;
    paramsObject?: Record<string, unknown> | null;
    destination: {
      functionName: string;
      functionContext: string;
    };
    functionParams?: Record<string, unknown> | unknown[] | null;
    enabled?: boolean;
    ohipOffsetSelection?: 'PROVIDER_HIGHEST' | 'SPECIFIC' | 'PERSISTED';
    ohipOffset?: string;
    ohipMaintainOffset?: boolean;
    eventInactivityThresholdMs?: number | null;
  };
}

export interface SchemaFile {
  filePath: string;
  fileName: string;
  content: {
    name: string;
    context: string;
    schema: any;
  };
}

export interface VariableFile {
  filePath: string;
  fileName: string;
  content: {
    name: string;
    context: string;
    description?: string;
    instruction?: string;
    value?: unknown;
    secret?: boolean;
    secrecy?: 'SECRET' | 'OBSCURED' | 'PARTIAL' | 'NONE';
    visibility?: 'ENVIRONMENT' | 'TENANT' | 'PUBLIC';
    state?: 'ALPHA' | 'BETA' | 'STABLE' | 'DEPRECATED' | 'DISABLED';
    expiresAt?: string;
    ownerUserId?: string | null;
    schema?: Record<string, unknown>;
  };
}

export interface JobFunctionRef {
  functionName: string;
  functionContext: string;
  eventPayload?: Record<string, unknown>;
  headersPayload?: Record<string, unknown>;
  paramsPayload?: Record<string, unknown>;
}

export interface JobSchedulePeriodical {
  type: 'periodical';
  value: string;
  acceptableDelayTime?: number | null;
}

export interface JobScheduleInterval {
  type: 'interval';
  value: number;
  acceptableDelayTime?: number | null;
}

export interface JobScheduleOnTime {
  type: 'on_time';
  value: string;
  acceptableDelayTime?: number | null;
}

export type JobSchedule =
  | JobSchedulePeriodical
  | JobScheduleInterval
  | JobScheduleOnTime;

export interface JobFile {
  filePath: string;
  fileName: string;
  content: {
    name: string;
    schedule: JobSchedule;
    executionType: 'sequential' | 'parallel';
    enabled: boolean;
    functions: JobFunctionRef[];
    ownerUserId?: string;
  };
}

export interface TableColumnDef {
  name: string;
  type: string;
  default?: unknown;
  required?: boolean;
  unique?: boolean;
  primary?: boolean;
  schema?: Record<string, unknown> | null;
}

export interface TableFile {
  filePath: string;
  fileName: string;
  content: {
    name: string;
    context: string;
    description?: string;
    ownerUserId?: string;
    visibility?: 'ENVIRONMENT' | 'TENANT';
    columns: TableColumnDef[];
  };
}
