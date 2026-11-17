import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import type createClient from 'openapi-fetch';
import type { components, paths } from '../sdk/schema';
import type { VariableFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import { parseBooleanEnv } from '../utils/deploymentConfig';
import {
  getRelativePath,
  getSrcPath,
  isInArtefactDirectory,
  isInNamedDirectory,
  readJsonFile,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import {
  chalk,
  createHeader,
  createLogger,
  warningColor,
} from '../utils/logger';
import {
  getRequiredNamespaces,
  matchesAnyRequiredNamespace,
  validateNamespace,
} from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { areComparisonPayloadsEqual } from '../utils/payloadComparison';
import { validateVariableArtifact } from '../utils/validation';

const log = createLogger('variables');
type VariableDto = components['schemas']['VariableDto'];
type FindVariableFileOptions = WalkDirOptions;
type VariableProtection = { secret?: unknown; secrecy?: unknown };

const MAX_API_ERROR_DEPTH = 4;
const MAX_API_ERROR_ENTRIES = 25;
const SENSITIVE_LOG_FIELD_PATTERN =
  /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|value|body|payload|request|headers/i;

function sanitizeApiError(error: unknown, depth: number = 0): unknown {
  if (error === null || error === undefined) {
    return error;
  }

  if (typeof error === 'string') {
    // API and transport errors can echo submitted variable values in free text.
    // Keep request metadata and status for diagnosis, never the returned text.
    return '[redacted]';
  }

  if (typeof error === 'number' || typeof error === 'boolean') {
    return error;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeApiError(error.message, depth + 1),
    };
  }

  if (depth >= MAX_API_ERROR_DEPTH) {
    return '[truncated]';
  }

  if (Array.isArray(error)) {
    const entries = error
      .slice(0, MAX_API_ERROR_ENTRIES)
      .map(entry => sanitizeApiError(entry, depth + 1));

    if (error.length > MAX_API_ERROR_ENTRIES) {
      entries.push(`[${error.length - MAX_API_ERROR_ENTRIES} more item(s)]`);
    }

    return entries;
  }

  if (typeof error === 'object') {
    const sanitized: Record<string, unknown> = {};
    const entries = Object.entries(error).slice(0, MAX_API_ERROR_ENTRIES);

    for (const [key, value] of entries) {
      sanitized[key] = SENSITIVE_LOG_FIELD_PATTERN.test(key)
        ? '[redacted]'
        : sanitizeApiError(value, depth + 1);
    }

    if (Object.keys(error).length > MAX_API_ERROR_ENTRIES) {
      sanitized.truncatedFields =
        Object.keys(error).length - MAX_API_ERROR_ENTRIES;
    }

    return sanitized;
  }

  return '[redacted]';
}

function logVariableApiRequest(
  operation: string,
  endpoint: string,
  metadata: Record<string, unknown>
): void {
  log.debug(
    { operation, endpoint, ...metadata },
    'Sending variable API request'
  );
}

function logVariableApiResponse(
  operation: string,
  endpoint: string,
  response: Response | undefined,
  error: unknown,
  metadata: Record<string, unknown> = {}
): void {
  log.debug(
    {
      operation,
      endpoint,
      status: response?.status,
      statusText: response?.statusText,
      ...metadata,
      ...(error === undefined ? {} : { error: sanitizeApiError(error) }),
    },
    error === undefined
      ? 'Variable API request completed'
      : 'Variable API request failed'
  );
}

function buildVariableLogMetadata(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const value = payload.value;
  const valueShape = Array.isArray(value)
    ? 'array'
    : value === null
      ? 'null'
      : typeof value;

  return {
    name: payload.name,
    context: payload.context,
    secret: payload.secret === true,
    secrecy: payload.secrecy,
    visibility: payload.visibility,
    state: payload.state,
    hasValue: value !== undefined,
    valueShape,
    providedFields: Object.entries(payload)
      .filter(([, fieldValue]) => fieldValue !== undefined)
      .map(([fieldName]) => fieldName),
  };
}

/**
 * Find the line number where an environment variable pattern appears in a file
 */
function findEnvVarLine(filePath: string, envVar: string): number | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const pattern = `{{${envVar}}}`;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(pattern)) {
        return i + 1; // Return 1-based line number
      }
    }
  } catch (_error) {
    // If we can't read the file or find the pattern, return null
  }
  return null;
}

/**
 * Process a value by replacing {{ENV_VAR}} patterns with environment variables
 */
function processValueWithEnvVars(
  value: any,
  variableName: string,
  filePath?: string
): any {
  if (typeof value === 'string') {
    // Replace {{VAR}} patterns
    return value.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, envVar) => {
      const envValue = process.env[envVar];
      if (envValue === undefined) {
        let fileRef = '';
        if (filePath) {
          const lineNumber = findEnvVarLine(filePath, envVar);
          const relativePath = getRelativePath(filePath);
          fileRef = lineNumber
            ? chalk.cyan(`${relativePath}:${lineNumber}`)
            : chalk.cyan(relativePath);
        }
        log.warn(
          warningColor(
            `WARN: Environment variable {{${envVar}}} not found, leaving as-is`
          ) + (fileRef ? ` ${fileRef}` : '')
        );
        return match;
      }
      return envValue;
    });
  } else if (Array.isArray(value)) {
    return value.map(item =>
      processValueWithEnvVars(item, variableName, filePath)
    );
  } else if (typeof value === 'object' && value !== null) {
    const processed: any = {};
    for (const [key, val] of Object.entries(value)) {
      const processedKey = processValueWithEnvVars(key, variableName, filePath);
      processed[processedKey] = processValueWithEnvVars(
        val,
        variableName,
        filePath
      );
    }
    return processed;
  }
  return value;
}

function resolveVariableIdentity(variable: VariableFile): {
  context: string;
  name: string;
} {
  const fallbackName = variable.content.name || 'N/A';
  const fallbackContext = variable.content.context || '';
  const resolvedName = processValueWithEnvVars(
    fallbackName,
    fallbackName,
    variable.filePath
  );
  const resolvedContext = processValueWithEnvVars(
    fallbackContext,
    fallbackName,
    variable.filePath
  );

  return {
    context:
      typeof resolvedContext === 'string' ? resolvedContext : fallbackContext,
    name: typeof resolvedName === 'string' ? resolvedName : fallbackName,
  };
}

/**
 * Validate a variable value against its JSON schema
 * Logs errors but does not throw - validation errors should not break processing
 */
function validateVariableValue(
  value: any,
  schema: any,
  variableName: string,
  variableContext: string
): boolean {
  if (!schema) {
    return true; // No schema means no validation needed
  }

  try {
    const ajv = new Ajv({
      allErrors: true,
      validateFormats: false, // Disable format validation (uri, email, etc.) to avoid errors
    });
    const validate = ajv.compile(schema);
    const valid = validate(value);

    if (!valid) {
      log.error(
        { name: variableName, context: variableContext },
        warningColor.bold('SCHEMA VALIDATION FAILED: ') +
          chalk.red('Value does not match schema')
      );

      if (validate.errors) {
        for (const error of validate.errors) {
          const path = error.instancePath || '(root)';
          const message = error.message || 'unknown error';
          log.error(
            { name: variableName, path, message },
            warningColor(`  → ${path}: ${message}`)
          );
        }
      }

      log.error(
        { name: variableName },
        warningColor('Validation failed but processing will continue')
      );
      return false;
    }

    log.debug({ name: variableName }, 'Schema validation passed');
    return true;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    log.error(
      { name: variableName, error: errorMessage },
      chalk.red('Error during schema validation: ') + errorMessage
    );
    log.error(
      { name: variableName },
      warningColor('Schema validation error, but processing will continue')
    );
    return false;
  }
}

function isSecretVariable(
  variableContent: VariableProtection,
  existingVariable?: VariableProtection
): boolean {
  const localIsSecret =
    variableContent.secret === true || variableContent.secrecy === 'SECRET';

  const existingIsSecret =
    existingVariable?.secret === true || existingVariable?.secrecy === 'SECRET';

  return localIsSecret || existingIsSecret;
}

function isObscuredVariable(
  variableContent: VariableProtection,
  existingVariable?: VariableProtection
): boolean {
  const localIsObscured = variableContent.secrecy === 'OBSCURED';
  const existingIsObscured = existingVariable?.secrecy === 'OBSCURED';

  return localIsObscured || existingIsObscured;
}

function isProtectedVariable(
  variableContent: VariableProtection,
  existingVariable?: VariableProtection
): boolean {
  return (
    isSecretVariable(variableContent, existingVariable) ||
    isObscuredVariable(variableContent, existingVariable) ||
    variableContent.secrecy === 'PARTIAL' ||
    existingVariable?.secrecy === 'PARTIAL'
  );
}

function isEmptyVariableValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (typeof value === 'object' && Object.keys(value).length === 0)
  );
}

/**
 * Find all variable JSON files in the project
 */
export function findVariableFiles(
  options: FindVariableFileOptions = {}
): VariableFile[] {
  const variableFiles: VariableFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        isInNamedDirectory(fullPath, 'vari') &&
        isInArtefactDirectory(fullPath)
      ) {
        const content = readJsonFile(fullPath);
        if (content) {
          variableFiles.push({
            filePath: fullPath,
            fileName: file,
            content,
          });
        }
      }
    },
    options
  );

  return variableFiles;
}

/**
 * Get all existing variables from the API
 */
export async function getExistingVariables(
  client: ReturnType<typeof createClient<paths>>
): Promise<any[]> {
  try {
    logVariableApiRequest('list', 'GET /variables', {});
    const { data, error, response } = await client.GET('/variables', {});

    if (error || !data) {
      logVariableApiResponse(
        'list',
        'GET /variables',
        response,
        error ?? 'Response did not include variable data'
      );
      return [];
    }

    logVariableApiResponse('list', 'GET /variables', response, undefined, {
      variableCount: data.length,
    });
    return data;
  } catch (error) {
    logVariableApiResponse('list', 'GET /variables', undefined, error);
    log.warn(
      { error: sanitizeApiError(error) },
      'Failed to fetch variables from API'
    );
    return [];
  }
}

/**
 * Delete a variable by ID
 */
async function deleteVariable(
  client: ReturnType<typeof createClient<paths>>,
  variableId: string,
  name: string,
  context: string
): Promise<boolean> {
  try {
    const metadata = { name, context };
    logVariableApiRequest('delete', 'DELETE /variables/{id}', metadata);
    const { error, response } = await client.DELETE('/variables/{id}', {
      params: { path: { id: variableId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      logVariableApiResponse(
        'delete',
        'DELETE /variables/{id}',
        response,
        error,
        metadata
      );
      log.error(
        { name, context, status: (response as Response).status },
        'Failed to delete variable'
      );
      return false;
    } else {
      logVariableApiResponse(
        'delete',
        'DELETE /variables/{id}',
        response,
        undefined,
        metadata
      );
      log.info({ name, context }, 'Variable deleted');
      return true;
    }
  } catch (error) {
    logVariableApiResponse(
      'delete',
      'DELETE /variables/{id}',
      undefined,
      error,
      { name, context }
    );
    log.error(
      { error: sanitizeApiError(error), name, context },
      'Error deleting variable'
    );
    return false;
  }
}

/**
 * POST or PATCH a variable to the API
 * Returns: 'created' | 'updated' | 'secret-metadata-updated' | 'noop' | 'failed'
 */
async function buildVariablePayload(
  variable: VariableFile,
  resolvedIdentity: {
    context: string;
    name: string;
  }
): Promise<{
  payload: Record<string, unknown>;
  isSecret: boolean;
}> {
  const variableName = resolvedIdentity.name;
  const variableContext = resolvedIdentity.context;
  // OBSCURED values can be initialized from environment placeholders, even
  // when the legacy secret flag is also present. SECRET values stay excluded.
  const isObscured = isObscuredVariable(variable.content);
  const isSecret = isSecretVariable(variable.content) && !isObscured;
  const hasValue = variable.content.value !== undefined;

  let processedValue: unknown = {};

  if (hasValue && isSecret) {
    const fileRef = chalk.cyan(getRelativePath(variable.filePath));
    log.error(
      warningColor.bold('WARN: ') +
        chalk.red.bold('Secret variable has a value defined in JSON file! ') +
        fileRef
    );
    log.error(
      warningColor.bold('WARN: ') +
        chalk.red(
          'Secret values should ONLY be set in PolyAPI Canopy, not in source files.'
        )
    );
    log.error(
      warningColor.bold('WARN: ') +
        warningColor('The value will be ignored and set to empty object.')
    );
    processedValue = {};
  } else if (hasValue && !isSecret) {
    processedValue = processValueWithEnvVars(
      variable.content.value,
      variableName,
      variable.filePath
    );

    if (variable.content.schema) {
      validateVariableValue(
        processedValue,
        variable.content.schema,
        variableName,
        variableContext
      );
    }
  } else {
    processedValue = {};
  }

  if (isObscured && isEmptyVariableValue(processedValue)) {
    processedValue = undefined;
  }

  return {
    isSecret,
    payload: {
      name: variableName,
      context: variableContext,
      description: variable.content.description,
      value: processedValue,
      secret: variable.content.secret,
      secrecy: variable.content.secrecy,
      visibility: variable.content.visibility,
      state: variable.content.state,
      expiresAt: variable.content.expiresAt,
      ownerUserId: variable.content.ownerUserId,
    },
  };
}

function buildVariableUpdatePayload(
  payload: Record<string, unknown>,
  existingVariable: VariableProtection,
  updateSecretValues: boolean
): Record<string, unknown> {
  const updatePayload = { ...payload };
  if (
    (isProtectedVariable(payload, existingVariable) && !updateSecretValues) ||
    isEmptyVariableValue(updatePayload.value)
  ) {
    delete updatePayload.value;
  }
  return updatePayload;
}

function buildVariableEndpointValidationPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const value = payload.value;
  const isPlainObject =
    value !== null && typeof value === 'object' && !Array.isArray(value);

  if (value !== undefined && !isPlainObject) {
    // OpenAPI currently types variable.value as object, but runtime accepts scalars/arrays.
    return { ...payload, value: {} };
  }

  return payload;
}

async function getExistingVariableDetails(
  client: ReturnType<typeof createClient<paths>>,
  variableId: string
): Promise<VariableDto | null> {
  try {
    logVariableApiRequest('get', 'GET /variables/{id}', { variableId });
    const { data, error, response } = await client.GET('/variables/{id}', {
      params: { path: { id: variableId } },
    });

    if (error || !data) {
      logVariableApiResponse(
        'get',
        'GET /variables/{id}',
        response,
        error ?? 'Response did not include variable data',
        { variableId }
      );
      log.warn(
        { variableId, status: (response as Response).status },
        'Failed to fetch variable details'
      );
      return null;
    }

    logVariableApiResponse('get', 'GET /variables/{id}', response, undefined, {
      variableId,
    });
    return data as VariableDto;
  } catch (error) {
    logVariableApiResponse('get', 'GET /variables/{id}', undefined, error, {
      variableId,
    });
    log.warn(
      { error: sanitizeApiError(error), variableId },
      'Error fetching variable details'
    );
    return null;
  }
}

function buildRemoteVariablePayload(
  localPayload: Record<string, unknown>,
  remoteVariable: VariableDto,
  includeValue: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: remoteVariable.name,
    context: remoteVariable.context,
  };

  if (localPayload.description !== undefined) {
    payload.description = remoteVariable.description;
  }
  if (includeValue && localPayload.value !== undefined) {
    payload.value = remoteVariable.value ?? {};
  }
  if (localPayload.secret !== undefined) {
    payload.secret = remoteVariable.secret;
  }
  if (localPayload.secrecy !== undefined) {
    payload.secrecy = remoteVariable.secrecy;
  }
  if (localPayload.visibility !== undefined) {
    payload.visibility = remoteVariable.visibility;
  }
  if (localPayload.state !== undefined) {
    payload.state = remoteVariable.state;
  }
  if (localPayload.expiresAt !== undefined) {
    payload.expiresAt = remoteVariable.expiresAt;
  }
  if (localPayload.ownerUserId !== undefined) {
    payload.ownerUserId = remoteVariable.ownerUserId ?? null;
  }

  return payload;
}

async function postVariable(
  client: ReturnType<typeof createClient<paths>>,
  variable: VariableFile,
  existingVariables: any[],
  resolvedIdentity: {
    context: string;
    name: string;
  },
  dryRun: boolean = false,
  force: boolean = false,
  updateSecretValues: boolean = false
): Promise<
  | 'created'
  | 'updated'
  | 'secret-metadata-updated'
  | 'requires-force'
  | 'secret-updates-disabled'
  | 'noop'
  | 'failed'
> {
  try {
    const variableName = resolvedIdentity.name;
    const variableContext = resolvedIdentity.context;
    const existingVariable = existingVariables.find(
      (v: any) => v.name === variableName && v.context === variableContext
    );
    const { payload, isSecret } = await buildVariablePayload(
      variable,
      resolvedIdentity
    );

    if (existingVariable) {
      const existingVariableDetails = await getExistingVariableDetails(
        client,
        existingVariable.id
      );
      // A list response may omit secrecy. Do not write without verified detail.
      if (!existingVariableDetails) return 'failed';

      if (isObscuredVariable(variable.content) && !force) {
        return 'requires-force';
      }
      if (isSecret && !updateSecretValues) {
        return 'secret-updates-disabled';
      }

      const updatePayload = buildVariableUpdatePayload(
        payload,
        existingVariableDetails,
        updateSecretValues
      );
      const metadataOnly =
        isProtectedVariable(payload, existingVariableDetails) &&
        updatePayload.value === undefined;

      if (
        !force &&
        areComparisonPayloadsEqual(
          updatePayload,
          buildRemoteVariablePayload(
            updatePayload,
            existingVariableDetails,
            updatePayload.value !== undefined
          )
        )
      ) {
        return 'noop';
      }

      const updateValidationPayload =
        buildVariableEndpointValidationPayload(updatePayload);

      if (
        !validateEndpointPayload('UpdateVariableDto', updateValidationPayload, {
          artifactType: 'Variable',
          artifactName: variableName,
          filePath: variable.filePath,
        })
      ) {
        return 'failed';
      }

      if (dryRun) {
        return metadataOnly ? 'secret-metadata-updated' : 'updated';
      }

      const updateMetadata = buildVariableLogMetadata(updatePayload);
      logVariableApiRequest('update', 'PATCH /variables/{id}', updateMetadata);
      const { error, response } = await client.PATCH('/variables/{id}', {
        params: { path: { id: existingVariable.id } },
        body: updatePayload as any,
      });

      if (error) {
        logVariableApiResponse(
          'update',
          'PATCH /variables/{id}',
          response,
          error,
          updateMetadata
        );
        const fileRef = chalk.cyan(getRelativePath(variable.filePath));

        // Check if the error is about changing secrecy level
        const errorMessage = (error as any)?.message || '';
        if (
          errorMessage.includes('Cannot change secrecy level') &&
          (!isProtectedVariable(existingVariableDetails) || updateSecretValues)
        ) {
          // Reuse the protected update payload; recreation must not restore a
          // value that was deliberately omitted (including empty values).
          if (
            !validateEndpointPayload(
              'CreateVariableDto',
              buildVariableEndpointValidationPayload(updatePayload),
              {
                artifactType: 'Variable',
                artifactName: variableName,
                filePath: variable.filePath,
              }
            )
          ) {
            return 'failed';
          }
          log.warn(
            warningColor(
              `WARN: Cannot change secrecy level - deleting and recreating variable ${fileRef}`
            )
          );

          // Delete the existing variable
          const deleted = await deleteVariable(
            client,
            existingVariable.id,
            variableName,
            variableContext
          );
          if (!deleted) {
            log.error(
              chalk.red(`Failed to delete variable for recreation ${fileRef}`)
            );
            return 'failed';
          }

          // Wait a moment for deletion to complete
          await sleep(500);

          // Recreate the variable with the new secrecy level
          const recreateMetadata = buildVariableLogMetadata(updatePayload);
          logVariableApiRequest(
            'recreate',
            'POST /variables',
            recreateMetadata
          );
          const { error: createError, response: createResponse } =
            await client.POST('/variables', {
              body: updatePayload as any,
            });

          if (createError) {
            logVariableApiResponse(
              'recreate',
              'POST /variables',
              createResponse,
              createError,
              recreateMetadata
            );
            log.error(`Failed to recreate variable ${fileRef}`);
            return 'failed';
          } else {
            logVariableApiResponse(
              'recreate',
              'POST /variables',
              createResponse,
              undefined,
              recreateMetadata
            );
            log.info(
              { name: variableName, context: variableContext },
              chalk.green(`Variable recreated with new secrecy level`)
            );
            return 'created';
          }
        }

        log.error(
          {
            ...updateMetadata,
            status: (response as Response | undefined)?.status,
            error: sanitizeApiError(error),
          },
          `Failed to update variable ${fileRef}`
        );
        return 'failed';
      } else {
        logVariableApiResponse(
          'update',
          'PATCH /variables/{id}',
          response,
          undefined,
          updateMetadata
        );
        return metadataOnly ? 'secret-metadata-updated' : 'updated';
      }
    } else {
      if (dryRun) {
        return 'created';
      }

      if (
        !validateEndpointPayload(
          'CreateVariableDto',
          buildVariableEndpointValidationPayload(payload),
          {
            artifactType: 'Variable',
            artifactName: variableName,
            filePath: variable.filePath,
          }
        )
      ) {
        return 'failed';
      }

      const createMetadata = buildVariableLogMetadata(payload);
      logVariableApiRequest('create', 'POST /variables', createMetadata);
      const { error, response } = await client.POST('/variables', {
        body: payload as any,
      });

      if (error) {
        logVariableApiResponse(
          'create',
          'POST /variables',
          response,
          error,
          createMetadata
        );
        const fileRef = chalk.cyan(getRelativePath(variable.filePath));
        log.error(`Failed to create variable ${fileRef}`);
        return 'failed';
      } else {
        logVariableApiResponse(
          'create',
          'POST /variables',
          response,
          undefined,
          createMetadata
        );
        return 'created';
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    log.error(
      {
        error: sanitizeApiError(errorMessage),
        stack: sanitizeApiError(errorStack),
      },
      'Error processing variable'
    );
    return 'failed';
  }
}

export interface CreatedVariable {
  name: string;
  context: string;
  instruction?: string;
}

/**
 * Synchronize variables with the API
 */
export async function syncVariables(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindVariableFileOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<CreatedVariable[]> {
  const updateSecretValues = parseBooleanEnv(
    'POLY_DEPLOY_UPDATE_EXISTING_SECRET_VARIABLES',
    false
  );
  const variableFiles = findVariableFiles(options.discoveryOptions);
  const allVariableFiles = findVariableFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });
  const resolvedVariableFiles = variableFiles.map(variable => ({
    identity: resolveVariableIdentity(variable),
    variable,
  }));
  const resolvedAllVariableFiles = allVariableFiles.map(variable => ({
    identity: resolveVariableIdentity(variable),
    variable,
  }));
  const createdVariables: CreatedVariable[] = [];

  log.info(chalk.cyan(createHeader('VARIABLES')));

  if (variableFiles.length === 0) {
    log.warn(
      warningColor(
        'No variable JSON files found in src/**/artefacts/vari/ (legacy src/**/artifacts/vari/ is also supported)'
      )
    );
    return createdVariables;
  }

  log.info(chalk.gray(`Found ${variableFiles.length} local variable file(s)`));

  // Step 1: Get existing variables from API (filtered by namespace)
  const namespaces = getRequiredNamespaces();
  const allVariables = await getExistingVariables(client);
  const existingVariables = allVariables.filter((variable: any) =>
    matchesAnyRequiredNamespace(variable.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${existingVariables.length} variable(s) from API in namespace(s) "${namespaces.join(', ')}"`
    )
  );

  // Step 2: Identify variables that don't exist locally (orphans)
  const localVariableKeys = new Set(
    resolvedAllVariableFiles.map(
      ({ identity }) => `${identity.name}:${identity.context}`
    )
  );

  if (options.detectOrphans === false) {
    log.info(chalk.gray('Skipping orphan detection for scoped variable sync'));
  } else {
    const orphanCandidates = existingVariables.filter(
      (variable: any) =>
        !localVariableKeys.has(`${variable.name}:${variable.context}`)
    );
    const { included: variablesToDelete, excluded: excludedVariables } =
      filterOrphansByContext(orphanCandidates);
    if (excludedVariables.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excludedVariables.length} variable orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (variablesToDelete.length > 0) {
      if (deleteOrphans) {
        log.info(
          warningColor(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${variablesToDelete.length} variable(s) not in local files...`
          )
        );
        for (const variable of variablesToDelete) {
          if (options.dryRun) {
            log.info(
              chalk.blue(
                `    [PLAN] Delete ${variable.name} (${variable.context})`
              )
            );
            summary.planned++;
            continue;
          }

          const result = await deleteVariable(
            client,
            variable.id,
            variable.name,
            variable.context
          );
          if (result) summary.deleted++;
          else summary.failed++;
          await sleep(300);
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${variablesToDelete.length} orphaned variable(s) (skipping deletion)`
          )
        );
        for (const variable of variablesToDelete) {
          orphans.push({
            type: 'variable',
            name: variable.name,
            context: variable.context,
            id: variable.id,
          });
        }
      }
    } else {
      log.debug('No variables to delete');
    }
  }

  // Step 3: Create or update local variables
  log.info(chalk.blue('Comparing local variable payloads with API...'));
  for (const { variable, identity } of resolvedVariableFiles) {
    const fileRef = chalk.cyan(getRelativePath(variable.filePath));
    log.info(
      `${chalk.dim(`  → ${identity.name} (${identity.context})`)} ${fileRef}`
    );

    // Validate artifact structure before syncing
    if (
      !validateVariableArtifact(
        variable.content,
        variable.filePath,
        skipInvalid
      )
    ) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    // Validate namespace
    try {
      validateNamespace(identity.context, 'Variable', identity.name);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'Namespace validation failed'
      );
      log.info(chalk.red('    [FAIL] Failed (namespace)'));
      summary.failed++;
      continue;
    }

    const result = await postVariable(
      client,
      variable,
      existingVariables,
      identity,
      options.dryRun,
      options.force,
      updateSecretValues
    );
    if (result === 'created') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Create'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Created'));
        summary.created++;
        if (
          isSecretVariable(variable.content) &&
          !isObscuredVariable(variable.content)
        ) {
          createdVariables.push({
            name: identity.name,
            context: identity.context,
            instruction: variable.content.instruction,
          });
        }
      }
    } else if (result === 'updated') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Update'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Updated'));
        summary.updated++;
      }
    } else if (result === 'secret-metadata-updated') {
      if (options.dryRun) {
        log.info(
          chalk.blue('    [PLAN] Update metadata (protected value unchanged)')
        );
        summary.planned++;
      } else {
        log.info(
          chalk.green('    [OK] Updated metadata (protected value unchanged)')
        );
        summary.updated++;
      }
    } else if (result === 'requires-force') {
      log.info(
        chalk.gray('    [SKIP] Existing obscured variable requires --force')
      );
      summary.skipped++;
    } else if (result === 'secret-updates-disabled') {
      log.info(chalk.gray('    [SKIP] Existing secret updates disabled'));
      summary.skipped++;
    } else if (result === 'noop') {
      log.info(chalk.gray('    [SKIP] Unchanged'));
      summary.skipped++;
    } else {
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
    }
    await sleep(500);
  }

  return createdVariables;
}
