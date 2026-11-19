/**
 * Validation utilities using Typebox
 *
 * Provides validation functions for all CLI artifact types
 */

import type { TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { describeJobIntervalProblem } from './jobInterval';
import { chalk, createLogger, warningColor } from './logger';
import {
  AiFunctionArtifactSchema,
  FunctionArtifactSchema,
  GraphQLSubscriptionArtifactSchema,
  JobArtifactSchema,
  McpServerArtifactSchema,
  SchemaArtifactSchema,
  TableArtifactSchema,
  TriggerArtifactSchema,
  VariableArtifactSchema,
  WebhookArtifactSchema,
} from './schemas';

const log = createLogger('validation');

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validation error
 */
export interface ValidationError {
  path: string;
  message: string;
  value?: any;
}

/**
 * Compile a Typebox schema for faster validation
 */
function compileSchema<T extends TSchema>(schema: T) {
  return TypeCompiler.Compile(schema);
}

/**
 * Validate data against a Typebox schema
 */
function validate<T extends TSchema>(
  schema: T,
  data: unknown,
  _artifactName?: string,
  _artifactType?: string
): ValidationResult {
  const compiled = compileSchema(schema);
  const valid = compiled.Check(data);

  if (valid) {
    return { valid: true, errors: [] };
  }

  // Collect errors
  const errors: ValidationError[] = [];
  for (const error of compiled.Errors(data)) {
    errors.push({
      path: error.path,
      message: error.message,
      value: error.value,
    });
  }

  return { valid: false, errors };
}

/**
 * Validation error class
 */
export class ValidationFailedError extends Error {
  constructor(
    public artifactName: string,
    public artifactType: string,
    public errors: ValidationError[],
    public filePath?: string
  ) {
    super(`Validation failed for ${artifactType}: ${artifactName}`);
    this.name = 'ValidationFailedError';
  }
}

/**
 * Log validation errors
 */
function logValidationErrors(
  errors: ValidationError[],
  artifactName: string,
  artifactType: string,
  filePath?: string,
  skipInvalid: boolean = false
): void {
  log.error(
    { name: artifactName, type: artifactType, file: filePath },
    chalk.red.bold('⚠️  VALIDATION FAILED')
  );

  for (const error of errors) {
    const path = error.path || '(root)';
    log.error(
      { name: artifactName, path },
      warningColor(`  → ${path}: `) + chalk.red(error.message)
    );

    if (error.value !== undefined) {
      log.error(
        { name: artifactName, path },
        chalk.dim(`     Received: ${JSON.stringify(error.value)}`)
      );
    }
  }

  if (skipInvalid) {
    log.error(
      { name: artifactName },
      warningColor(
        '\nThis artifact will be skipped. Please fix the validation errors.\n'
      )
    );
  } else {
    log.error(
      { name: artifactName },
      chalk.red.bold('\n❌ Stopping sync due to validation errors.')
    );
    log.error(
      { name: artifactName },
      chalk.gray(
        'Use --skip-invalid flag to skip invalid artifacts and continue.\n'
      )
    );
  }
}

/**
 * Validate and log results
 */
function validateAndLog<T extends TSchema>(
  schema: T,
  data: unknown,
  artifactName: string,
  artifactType: string,
  filePath?: string,
  skipInvalid: boolean = false,
  semanticCheck?: (data: any) => ValidationError[]
): boolean {
  const result = validate(schema, data, artifactName, artifactType);
  // Rules the JSON shape cannot express run once the shape is valid.
  if (result.valid && semanticCheck) {
    result.errors = semanticCheck(data);
    result.valid = result.errors.length === 0;
  }

  if (!result.valid) {
    logValidationErrors(
      result.errors,
      artifactName,
      artifactType,
      filePath,
      skipInvalid
    );

    if (!skipInvalid) {
      throw new ValidationFailedError(
        artifactName,
        artifactType,
        result.errors,
        filePath
      );
    }

    return false;
  }

  log.debug(
    { name: artifactName, type: artifactType },
    chalk.green('✓ Validation passed')
  );
  return true;
}

/**
 * Validate a schema artifact
 */
export function validateSchemaArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    SchemaArtifactSchema,
    data,
    name,
    'Schema',
    filePath,
    skipInvalid
  );
}

/**
 * Validate a webhook artifact
 */
export function validateWebhookArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    WebhookArtifactSchema,
    data,
    name,
    'Webhook',
    filePath,
    skipInvalid
  );
}

/**
 * Validate a function artifact (metadata)
 */
export function validateFunctionArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    FunctionArtifactSchema,
    data,
    name,
    'Function',
    filePath,
    skipInvalid
  );
}

const NON_OBJECT_ROOT_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'enum', 'const'];

/**
 * PolyAPI (R35) rejects AI Function output schemas whose root is not an
 * object: OpenAI structured output needs an object root. Local `$ref` roots
 * are left to the API, which inlines them before checking.
 */
export function getAiFunctionRuleErrors(data: {
  outputSchema?: unknown;
  errorSchema?: unknown;
  type?: unknown;
  twilioAuthTokenVariable?: unknown;
}): ValidationError[] {
  const errors: ValidationError[] = [];
  if (
    data.twilioAuthTokenVariable &&
    typeof data.type === 'string' &&
    data.type.toUpperCase() !== 'VOICE'
  ) {
    errors.push({
      path: '/twilioAuthTokenVariable',
      message: 'twilioAuthTokenVariable applies to VOICE AI Functions only.',
    });
  }
  const checkObjectRoot = (field: 'outputSchema' | 'errorSchema'): void => {
    const schema = data[field];
    if (schema === undefined || schema === null) return;
    const record = schema as Record<string, unknown>;
    if (typeof record.$ref === 'string') return;
    if (
      (record.type !== undefined && record.type !== 'object') ||
      NON_OBJECT_ROOT_KEYWORDS.some(key => key in record)
    ) {
      errors.push({
        path: `/${field}`,
        message: `${field} must describe an object at the root (type "object" with properties); root primitives, arrays, unions, enum and const are rejected by PolyAPI. For plain-text output, omit outputSchema.`,
      });
    }
  };
  checkObjectRoot('outputSchema');
  checkObjectRoot('errorSchema');

  const errorSchema = data.errorSchema as
    | Record<string, any>
    | null
    | undefined;
  if (errorSchema) {
    if (!data.outputSchema) {
      errors.push({
        path: '/errorSchema',
        message: 'errorSchema requires outputSchema to also be set.',
      });
    }
    const properties = (errorSchema.properties ?? {}) as Record<string, any>;
    const required = Array.isArray(errorSchema.required)
      ? errorSchema.required
      : [];
    const status = properties.status;
    const fixedFailed =
      status &&
      (status.const === 'failed' ||
        (Array.isArray(status.enum) &&
          status.enum.length === 1 &&
          status.enum[0] === 'failed'));
    if (!fixedFailed || !required.includes('status')) {
      errors.push({
        path: '/errorSchema',
        message:
          'errorSchema must declare "status" as a required property fixed to "failed" (for example { "status": { "const": "failed" } }).',
      });
    }
    if (
      properties.message?.type !== 'string' ||
      !required.includes('message')
    ) {
      errors.push({
        path: '/errorSchema',
        message:
          'errorSchema must declare "message" as a required string property.',
      });
    }
  }

  return errors;
}

/**
 * Validate an AI function artifact.
 */
export function validateAiFunctionArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    AiFunctionArtifactSchema,
    data,
    name,
    'AI Function',
    filePath,
    skipInvalid,
    getAiFunctionRuleErrors
  );
}

/**
 * Validate an MCP server artifact.
 */
export function validateMcpServerArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    McpServerArtifactSchema,
    data,
    name,
    'MCP Server',
    filePath,
    skipInvalid
  );
}

/**
 * Validate a trigger artifact
 */
export function validateTriggerArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const source = (data as any)?.source;
  const name = source ? `${source.webhookName} → function` : 'unknown';
  return validateAndLog(
    TriggerArtifactSchema,
    data,
    name,
    'Trigger',
    filePath,
    skipInvalid
  );
}

/**
 * Validate a GraphQL subscription artifact
 */
export function validateGraphQLSubscriptionArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    GraphQLSubscriptionArtifactSchema,
    data,
    name,
    'GraphQL Subscription',
    filePath,
    skipInvalid
  );
}

/**
 * Validate a variable artifact
 */
export function validateVariableArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    VariableArtifactSchema,
    data,
    name,
    'Variable',
    filePath,
    skipInvalid
  );
}

/**
 * Validate a table artifact
 */
export function validateTableArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    TableArtifactSchema,
    data,
    name,
    'Table',
    filePath,
    skipInvalid
  );
}

/**
 * Interval schedules must be at least 10 seconds (the API's minimum).
 */
export function getJobScheduleErrors(data: {
  schedule?: { type?: string; value?: unknown };
}): ValidationError[] {
  if (data.schedule?.type !== 'interval') return [];
  const problem = describeJobIntervalProblem(data.schedule.value);
  return problem
    ? [
        {
          path: '/schedule/value',
          message: problem,
          value: data.schedule.value,
        },
      ]
    : [];
}

/**
 * Validate a job artifact
 */
export function validateJobArtifact(
  data: unknown,
  filePath?: string,
  skipInvalid: boolean = false
): boolean {
  const name = (data as any)?.name || 'unknown';
  return validateAndLog(
    JobArtifactSchema,
    data,
    name,
    'Job',
    filePath,
    skipInvalid,
    getJobScheduleErrors
  );
}

/**
 * Strip CLI-specific fields before sending to API
 * These fields are used for local validation/tooling but not accepted by the API
 */
export function stripCliFields<T extends Record<string, any>>(
  data: T,
  fieldsToStrip: string[]
): T {
  const cleaned = { ...data };
  for (const field of fieldsToStrip) {
    delete cleaned[field];
  }
  return cleaned;
}

/**
 * Strip variable CLI-specific fields (schema, instruction)
 */
export function stripVariableCliFields<T extends Record<string, any>>(
  data: T
): T {
  return stripCliFields(data, ['schema', 'instruction']);
}

/**
 * Strip function CLI-specific fields (server flag)
 */
export function stripFunctionCliFields<T extends Record<string, any>>(
  data: T
): T {
  return stripCliFields(data, ['server']);
}
