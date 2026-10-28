import { createInterface } from 'node:readline/promises';
import type createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import type { GraphQLSubscriptionFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import {
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
import { GraphQLSubscriptionArtifactSchema } from '../utils/schemas';
import { validateGraphQLSubscriptionArtifact } from '../utils/validation';
import { getReferenceableServerFunctions } from './references';
import { getExistingVariables } from './variables';

type CreateGraphQLSubscriptionDto =
  paths['/subscriptions/graphql']['post']['requestBody']['content']['application/json'];

type GraphQLSubscriptionRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  context?: string;
};

type FindGraphQLSubscriptionFileOptions = WalkDirOptions;
type FunctionParamsPayload =
  | Record<string, unknown>
  | unknown[]
  | null
  | undefined
  | typeof INVALID_FUNCTION_PARAMS;
type PolyVariableReference = {
  type: 'PolyVariable';
  id?: unknown;
  variableName?: unknown;
  variableContext?: unknown;
  path?: unknown;
  unwrap?: unknown;
};

const log = createLogger('subscriptions');
const INVALID_FUNCTION_PARAMS = Symbol('INVALID_FUNCTION_PARAMS');
const INVALID_PARAMS_OBJECT = Symbol('INVALID_PARAMS_OBJECT');
const GRAPHQL_SUBSCRIPTION_RECREATE_WAIT_SECONDS = 30;

export function findGraphQLSubscriptionFiles(
  options: FindGraphQLSubscriptionFileOptions = {}
): GraphQLSubscriptionFile[] {
  const subscriptionFiles: GraphQLSubscriptionFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        isInNamedDirectory(fullPath, 'subscriptions') &&
        isInArtefactDirectory(fullPath)
      ) {
        const content = readJsonFile<GraphQLSubscriptionFile['content']>(
          fullPath,
          { schema: GraphQLSubscriptionArtifactSchema }
        );
        if (content) {
          subscriptionFiles.push({
            filePath: fullPath,
            fileName: file,
            content,
          });
        }
      }
    },
    options
  );

  return subscriptionFiles;
}

export async function getExistingGraphQLSubscriptions(
  client: ReturnType<typeof createClient<paths>>
): Promise<GraphQLSubscriptionRecord[]> {
  try {
    const { data, error, response } = await (client.GET as any)(
      '/subscriptions/graphql',
      {}
    );

    if (error || !data) {
      log.warn(
        { status: (response as any)?.status, error },
        'Failed to fetch GraphQL subscriptions from API'
      );
      return [];
    }

    return normalizeSubscriptionList(data);
  } catch (error) {
    log.warn({ error }, 'Failed to fetch GraphQL subscriptions from API');
    return [];
  }
}

async function deleteGraphQLSubscription(
  client: ReturnType<typeof createClient<paths>>,
  subscriptionId: string,
  name: string,
  context: string
): Promise<boolean> {
  try {
    const { error, response } = await client.DELETE(
      '/subscriptions/graphql/{id}',
      {
        params: { path: { id: subscriptionId } },
        headers: await getDeleteHeaders(),
      }
    );

    if (error) {
      log.error(
        { name, context, status: (response as any)?.status, error },
        'Failed to delete GraphQL subscription'
      );
      return false;
    }

    log.info({ name, context }, 'GraphQL subscription deleted');
    return true;
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting GraphQL subscription');
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSubscriptionList(data: unknown): GraphQLSubscriptionRecord[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord) as GraphQLSubscriptionRecord[];
  }

  if (!isRecord(data)) {
    return [];
  }

  for (const key of ['results', 'items', 'subscriptions', 'data']) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord) as GraphQLSubscriptionRecord[];
    }
  }

  if (
    typeof data.id === 'string' ||
    typeof data.name === 'string' ||
    typeof data.context === 'string'
  ) {
    return [data as GraphQLSubscriptionRecord];
  }

  return [];
}

function subscriptionExists(
  name: string,
  context: string,
  existingSubscriptions: GraphQLSubscriptionRecord[]
): boolean {
  return existingSubscriptions.some(
    subscription =>
      subscription.name === name && subscription.context === context
  );
}

function findDestinationFunction(
  subscription: GraphQLSubscriptionFile,
  functions: any[]
): any | null {
  return (
    functions.find(
      (fn: any) =>
        fn.name === subscription.content.destination.functionName &&
        fn.context === subscription.content.destination.functionContext
    ) ?? null
  );
}

function normalizeFunctionParams(
  subscription: GraphQLSubscriptionFile,
  functionParams: unknown
): FunctionParamsPayload {
  if (functionParams === undefined) {
    return undefined;
  }

  if (functionParams === null) {
    return null;
  }

  if (Array.isArray(functionParams)) {
    if (functionParams.length === 0) {
      return undefined;
    }

    return functionParams;
  }

  if (isRecord(functionParams)) {
    return functionParams;
  }

  log.error(
    {
      name: subscription.content.name,
      context: subscription.content.context,
    },
    'GraphQL subscription functionParams must be an object, array, or null'
  );
  return INVALID_FUNCTION_PARAMS;
}

function isPolyVariableReference(
  value: unknown
): value is PolyVariableReference {
  return isRecord(value) && value.type === 'PolyVariable';
}

function resolvePolyVariableReference(
  value: PolyVariableReference,
  variables: any[],
  subscription: GraphQLSubscriptionFile
): Record<string, unknown> | typeof INVALID_PARAMS_OBJECT {
  const { id, variableName, variableContext, ...payloadReference } = value;

  if (typeof id === 'string') {
    return {
      ...payloadReference,
      id,
    };
  }

  if (typeof variableName !== 'string' || typeof variableContext !== 'string') {
    log.error(
      {
        name: subscription.content.name,
        context: subscription.content.context,
      },
      'PolyVariable reference must include variableName and variableContext'
    );
    return INVALID_PARAMS_OBJECT;
  }

  const variable = variables.find(
    (item: any) =>
      item.name === variableName && item.context === variableContext
  );

  if (!variable?.id) {
    log.error(
      {
        subscriptionName: subscription.content.name,
        subscriptionContext: subscription.content.context,
        variableName,
        variableContext,
      },
      'Variable not found for GraphQL subscription paramsObject'
    );
    return INVALID_PARAMS_OBJECT;
  }

  return {
    ...payloadReference,
    id: variable.id,
  };
}

function resolveParamsObjectReferences(
  value: unknown,
  variables: any[],
  subscription: GraphQLSubscriptionFile
): unknown | typeof INVALID_PARAMS_OBJECT {
  if (Array.isArray(value)) {
    const resolvedItems = [];
    for (const item of value) {
      const resolvedItem = resolveParamsObjectReferences(
        item,
        variables,
        subscription
      );
      if (resolvedItem === INVALID_PARAMS_OBJECT) {
        return INVALID_PARAMS_OBJECT;
      }
      resolvedItems.push(resolvedItem);
    }
    return resolvedItems;
  }

  if (!isRecord(value)) {
    return value;
  }

  if (isPolyVariableReference(value)) {
    return resolvePolyVariableReference(value, variables, subscription);
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const resolvedValue = resolveParamsObjectReferences(
      nestedValue,
      variables,
      subscription
    );
    if (resolvedValue === INVALID_PARAMS_OBJECT) {
      return INVALID_PARAMS_OBJECT;
    }
    resolved[key] = resolvedValue;
  }

  return resolved;
}

function buildGraphQLSubscriptionPayload(
  subscription: GraphQLSubscriptionFile,
  functions: any[],
  variables: any[]
): CreateGraphQLSubscriptionDto | null {
  const func = findDestinationFunction(subscription, functions);
  if (!func) {
    log.error(
      {
        functionName: subscription.content.destination.functionName,
        context: subscription.content.destination.functionContext,
      },
      'Function not found for GraphQL subscription'
    );
    return null;
  }

  const {
    destination: _destination,
    functionParams,
    ...content
  } = subscription.content;
  const normalizedFunctionParams = normalizeFunctionParams(
    subscription,
    functionParams
  );
  if (normalizedFunctionParams === INVALID_FUNCTION_PARAMS) {
    return null;
  }

  const payload: Record<string, unknown> = {
    ...content,
    functionId: func.id,
  };

  if (content.paramsObject !== undefined) {
    const resolvedParamsObject = resolveParamsObjectReferences(
      content.paramsObject,
      variables,
      subscription
    );
    if (resolvedParamsObject === INVALID_PARAMS_OBJECT) {
      return null;
    }
    payload.paramsObject = resolvedParamsObject;
  }

  if (normalizedFunctionParams !== undefined) {
    payload.functionParams = normalizedFunctionParams;
  }

  return payload as CreateGraphQLSubscriptionDto;
}

async function confirmGraphQLSubscriptionRecreate(
  name: string,
  context: string
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.warn(
      { name, context },
      warningColor(
        'Cannot prompt to recreate GraphQL subscription without an interactive terminal; skipping'
      )
    );
    return false;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (
      await readline.question(
        warningColor(
          `GraphQL subscriptions cannot be updated right now; they can only be re-created. Type YES to delete and re-create ${context}.${name}, or press Enter to skip: `
        )
      )
    ).trim();
    return answer === 'YES';
  } finally {
    readline.close();
  }
}

async function waitForGraphQLSubscriptionStreamingConnectionDeletion(
  name: string,
  context: string
): Promise<void> {
  log.info(
    warningColor(
      `Waiting ${GRAPHQL_SUBSCRIPTION_RECREATE_WAIT_SECONDS}s for ${context}.${name} streaming connection to be gracefully deleted before re-creating...`
    )
  );

  for (
    let secondsRemaining = GRAPHQL_SUBSCRIPTION_RECREATE_WAIT_SECONDS;
    secondsRemaining > 0;
    secondsRemaining -= 1
  ) {
    log.info(
      chalk.gray(
        `    [WAIT] ${secondsRemaining}s remaining before GraphQL subscription re-create`
      )
    );
    await sleep(1000);
  }
}

async function createGraphQLSubscription(
  client: ReturnType<typeof createClient<paths>>,
  payload: CreateGraphQLSubscriptionDto,
  subscription: GraphQLSubscriptionFile,
  subscriptionName: string,
  subscriptionContext: string
): Promise<boolean> {
  if (
    !validateEndpointPayload('GraphQLSubscriptionCreateDto', payload, {
      artifactType: 'GraphQL Subscription',
      artifactName: subscriptionName,
      filePath: subscription.filePath,
    })
  ) {
    return false;
  }

  const { error, response } = await (client.POST as any)(
    '/subscriptions/graphql',
    {
      body: payload,
    }
  );

  if (error) {
    log.error(
      {
        name: subscriptionName,
        context: subscriptionContext,
        status: (response as any)?.status,
        error,
      },
      'Failed to create GraphQL subscription'
    );
    return false;
  }

  return true;
}

async function postGraphQLSubscription(
  client: ReturnType<typeof createClient<paths>>,
  subscription: GraphQLSubscriptionFile,
  existingSubscriptions: GraphQLSubscriptionRecord[],
  functions: any[],
  variables: any[],
  dryRun: boolean = false,
  force: boolean = false
): Promise<
  | 'created'
  | 'recreated'
  | 'recreate-planned'
  | 'skipped-unsupported'
  | 'noop'
  | 'failed'
> {
  try {
    const subscriptionName = subscription.content.name || 'N/A';
    const subscriptionContext = subscription.content.context || '';
    const payload = buildGraphQLSubscriptionPayload(
      subscription,
      functions,
      variables
    );
    if (!payload) {
      return 'failed';
    }

    const exists = subscriptionExists(
      subscriptionName,
      subscriptionContext,
      existingSubscriptions
    );

    if (exists) {
      const existingSubscription = existingSubscriptions.find(
        item =>
          item.name === subscriptionName && item.context === subscriptionContext
      );

      if (!existingSubscription?.id) {
        log.error(
          { name: subscriptionName, context: subscriptionContext },
          'GraphQL subscription exists but has no ID'
        );
        return 'failed';
      }

      if (!force) {
        log.warn(
          { name: subscriptionName, context: subscriptionContext },
          warningColor(
            'GraphQL streaming subscription updates are not supported right now; skipping existing subscription. Use --force to delete and re-create it.'
          )
        );
        return 'skipped-unsupported';
      }

      if (dryRun) {
        return 'recreate-planned';
      }

      if (
        !validateEndpointPayload('GraphQLSubscriptionCreateDto', payload, {
          artifactType: 'GraphQL Subscription',
          artifactName: subscriptionName,
          filePath: subscription.filePath,
        })
      ) {
        return 'failed';
      }

      const confirmed = await confirmGraphQLSubscriptionRecreate(
        subscriptionName,
        subscriptionContext
      );
      if (!confirmed) {
        return 'noop';
      }

      const deleted = await deleteGraphQLSubscription(
        client,
        existingSubscription.id,
        subscriptionName,
        subscriptionContext
      );
      if (!deleted) {
        return 'failed';
      }

      await waitForGraphQLSubscriptionStreamingConnectionDeletion(
        subscriptionName,
        subscriptionContext
      );
      const created = await createGraphQLSubscription(
        client,
        payload,
        subscription,
        subscriptionName,
        subscriptionContext
      );
      return created ? 'recreated' : 'failed';
    }

    if (dryRun) {
      return 'created';
    }

    const created = await createGraphQLSubscription(
      client,
      payload,
      subscription,
      subscriptionName,
      subscriptionContext
    );
    return created ? 'created' : 'failed';
  } catch (error) {
    log.error({ error }, 'Error processing GraphQL subscription');
    return 'failed';
  }
}

export async function syncGraphQLSubscriptions(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindGraphQLSubscriptionFileOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const subscriptionFiles = findGraphQLSubscriptionFiles(
    options.discoveryOptions
  );
  const allSubscriptionFiles = findGraphQLSubscriptionFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });

  log.info(chalk.cyan(createHeader('SUBSCRIPTIONS')));

  if (subscriptionFiles.length === 0) {
    log.warn(
      warningColor(
        'No GraphQL subscription JSON files found in src/**/artefacts/subscriptions/ (legacy src/**/artifacts/subscriptions/ is also supported)'
      )
    );
    return;
  }

  log.info(
    chalk.gray(`Found ${subscriptionFiles.length} local subscription file(s)`)
  );

  const namespaces = getRequiredNamespaces();
  const allSubscriptions = await getExistingGraphQLSubscriptions(client);
  const existingSubscriptions = allSubscriptions.filter(
    subscription =>
      typeof subscription.context === 'string' &&
      matchesAnyRequiredNamespace(subscription.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${existingSubscriptions.length} GraphQL subscription(s) from API in namespace(s) "${namespaces.join(', ')}"`
    )
  );

  const referenceableFunctions = await getReferenceableServerFunctions(client);
  log.info(
    chalk.gray(
      `Resolved ${referenceableFunctions.length} accessible server function(s)`
    )
  );

  const allVariables = await getExistingVariables(client);
  const variablesInNamespace = allVariables.filter((variable: any) =>
    matchesAnyRequiredNamespace(variable.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${variablesInNamespace.length} variable(s) from API in namespace(s) "${namespaces.join(', ')}"`
    )
  );

  const localSubscriptionKeys = new Set(
    allSubscriptionFiles.map(
      subscription =>
        `${subscription.content.name}:${subscription.content.context}`
    )
  );

  if (options.detectOrphans === false) {
    log.info(
      chalk.gray('Skipping orphan detection for scoped subscription sync')
    );
  } else {
    const orphanCandidates = existingSubscriptions.filter(
      subscription =>
        !localSubscriptionKeys.has(
          `${subscription.name}:${subscription.context}`
        )
    );
    const { included: subscriptionsToDelete, excluded: excludedSubscriptions } =
      filterOrphansByContext(orphanCandidates);

    if (excludedSubscriptions.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excludedSubscriptions.length} subscription orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (subscriptionsToDelete.length > 0) {
      if (deleteOrphans) {
        log.info(
          warningColor(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${subscriptionsToDelete.length} GraphQL subscription(s) not in local files...`
          )
        );
        for (const subscription of subscriptionsToDelete) {
          if (options.dryRun) {
            log.info(
              chalk.blue(
                `    [PLAN] Delete ${subscription.name ?? subscription.id} (${subscription.context ?? ''})`
              )
            );
            summary.planned++;
            continue;
          }

          if (subscription.id) {
            const deleted = await deleteGraphQLSubscription(
              client,
              subscription.id,
              subscription.name ?? subscription.id,
              subscription.context ?? ''
            );
            if (deleted) {
              summary.deleted++;
            } else {
              summary.failed++;
            }
            await sleep(300);
          }
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${subscriptionsToDelete.length} orphaned GraphQL subscription(s) (skipping deletion)`
          )
        );
        for (const subscription of subscriptionsToDelete) {
          if (!subscription.id) {
            continue;
          }

          orphans.push({
            type: 'subscription',
            name: subscription.name ?? subscription.id,
            context: subscription.context ?? '',
            id: subscription.id,
          });
        }
      }
    } else {
      log.debug('No GraphQL subscriptions to delete');
    }
  }

  log.info(chalk.blue('Syncing GraphQL subscriptions...'));
  for (const subscription of subscriptionFiles) {
    const destination = subscription.content.destination;
    log.info(
      chalk.dim(
        `  → ${subscription.content.name} → ${destination.functionName}`
      )
    );

    try {
      validateNamespace(
        subscription.content.context,
        'GraphQL subscription',
        subscription.content.name
      );
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'Namespace validation failed'
      );
      log.info(chalk.red('    [FAIL] Failed (namespace)'));
      summary.failed++;
      continue;
    }

    if (
      !validateGraphQLSubscriptionArtifact(
        subscription.content,
        subscription.filePath,
        skipInvalid
      )
    ) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    const result = await postGraphQLSubscription(
      client,
      subscription,
      existingSubscriptions,
      referenceableFunctions,
      variablesInNamespace,
      options.dryRun,
      options.force
    );

    if (result === 'created') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Create'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Created'));
        summary.created++;
      }
    } else if (result === 'recreate-planned') {
      log.info(chalk.blue('    [PLAN] Delete and recreate'));
      summary.planned++;
    } else if (result === 'recreated') {
      log.info(chalk.green('    [OK] Recreated'));
      summary.deleted++;
      summary.created++;
    } else if (result === 'skipped-unsupported') {
      log.info(chalk.gray('    [SKIP] Update unsupported'));
      summary.skipped++;
    } else if (result === 'noop') {
      log.info(chalk.gray('    [SKIP] Skipped'));
      summary.skipped++;
    } else {
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
    }

    await sleep(500);
  }
}
