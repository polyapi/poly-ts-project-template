import type createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import type {
  ErrorHandlerTriggerFileContent,
  TriggerFile,
  WebhookTriggerFileContent,
} from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import {
  getSrcPath,
  isInArtefactDirectory,
  readJsonFile,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import { chalk, createHeader, createLogger, warningColor } from '../utils/logger';
import { getRequiredNamespaces, matchesAnyRequiredNamespace, validateNamespace } from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { validateTriggerArtifact } from '../utils/validation';
import { getExistingServerFunctions } from './functions';
import { getExistingWebhooks } from './webhooks';

function isErrorHandlerTrigger(
  content: unknown
): content is ErrorHandlerTriggerFileContent {
  return (
    !!content &&
    typeof content === 'object' &&
    'errorHandler' in content &&
    typeof (content as any).errorHandler === 'object' &&
    typeof (content as any).errorHandler.path === 'string' &&
    'destination' in content &&
    !!(content as any).destination &&
    typeof (content as any).destination.functionName === 'string' &&
    typeof (content as any).destination.functionContext === 'string'
  );
}

function isWebhookTrigger(
  content: unknown
): content is WebhookTriggerFileContent {
  return (
    !!content &&
    typeof content === 'object' &&
    'source' in content &&
    !!(content as any).source &&
    typeof (content as any).source.webhookName === 'string' &&
    typeof (content as any).source.webhookContext === 'string' &&
    'destination' in content &&
    !!(content as any).destination &&
    typeof (content as any).destination.functionName === 'string' &&
    typeof (content as any).destination.functionContext === 'string'
  );
}

const log = createLogger('triggers');
type FindTriggerFileOptions = WalkDirOptions;

/**
 * Find all trigger JSON files in the project
 */
export function findTriggerFiles(
  options: FindTriggerFileOptions = {}
): TriggerFile[] {
  const triggerFiles: TriggerFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        fullPath.includes('/triggers/') &&
        isInArtefactDirectory(fullPath)
      ) {
        const content = readJsonFile(fullPath);
        if (content) {
          triggerFiles.push({
            filePath: fullPath,
            fileName: file,
            content,
          });
        }
      }
    },
    options
  );

  return triggerFiles;
}

/**
 * Get all existing triggers from the API
 */
export async function getExistingTriggers(
  client: ReturnType<typeof createClient<paths>>
): Promise<any[]> {
  try {
    const { data, error } = await client.GET('/triggers', {});

    if (error || !data) {
      return [];
    }

    return data;
  } catch (error) {
    log.warn({ error }, 'Failed to fetch triggers from API');
    return [];
  }
}

/**
 * Delete a trigger by ID
 */
async function deleteTrigger(
  client: ReturnType<typeof createClient<paths>>,
  triggerId: string
): Promise<boolean> {
  try {
    const { error, response } = await client.DELETE('/triggers/{id}', {
      params: { path: { id: triggerId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      log.error(
        { triggerId, status: (response as any)?.status },
        'Failed to delete trigger'
      );
      return false;
    } else {
      log.info({ triggerId }, 'Trigger deleted');
      return true;
    }
  } catch (error) {
    log.error({ error }, 'Error deleting trigger');
    return false;
  }
}

/**
 * Create or update a trigger
 * Returns: 'created' | 'updated' | 'failed'
 */
async function postTrigger(
  client: ReturnType<typeof createClient<paths>>,
  trigger: TriggerFile,
  webhooks: any[],
  functions: any[],
  existingTriggers: any[],
  dryRun: boolean = false,
  force: boolean = false
): Promise<'created' | 'updated' | 'failed' | 'noop'> {
  try {
    const content = trigger.content;
    let payload: any = {};
    let func: any = null;
    const name: string | undefined = getTriggerName(trigger);
    let existingTrigger: any;

    if (isWebhookTrigger(content)) {
      const { source, destination, waitForResponse, ownerUserId } = content;
      // Find webhook ID by name and context
      const webhook = webhooks.find(
        (wh: any) =>
          wh.name === source.webhookName && wh.context === source.webhookContext
      );
      if (!webhook) {
        log.error(
          { webhookName: source.webhookName, context: source.webhookContext },
          'Webhook not found for trigger'
        );
        return 'failed';
      }
      // Find function ID by name and context
      func = functions.find(
        (fn: any) =>
          fn.name === destination.functionName &&
          fn.context === destination.functionContext
      );
      if (!func) {
        log.error(
          {
            functionName: destination.functionName,
            context: destination.functionContext,
          },
          'Function not found for trigger'
        );
        return 'failed';
      }
      payload = {
        ...(name !== undefined ? { name } : {}),
        source: { webhookHandleId: webhook.id },
        destination: { serverFunctionId: func.id },
        waitForResponse: waitForResponse ?? true,
        ...(ownerUserId !== undefined ? { ownerUserId } : {}),
      };
      log.debug(
        {
          webhookId: webhook.id,
          functionId: func.id,
          triggerName: payload.name,
        },
        'Resolved webhook trigger IDs'
      );
      // Check if trigger already exists (prefer name match, fallback to id match)
      if (payload.name) {
        existingTrigger = existingTriggers.find(
          (t: any) => t.name === payload.name
        );
      }
      if (!existingTrigger) {
        existingTrigger = existingTriggers.find((t: any) => {
          const webhookId = getTriggerWebhookId(t);
          const functionId = getTriggerFunctionId(t);
          return webhookId === webhook.id && functionId === func.id;
        });
      }
      if (existingTrigger) {
        const existingWebhookId = getTriggerWebhookId(existingTrigger);
        const existingFunctionId = getTriggerFunctionId(existingTrigger);
        const existingWaitForResponse =
          existingTrigger.waitForResponse ?? false;
        const existingName = existingTrigger.name;
        const isSame =
          existingWebhookId === payload.source.webhookHandleId &&
          existingFunctionId === payload.destination.serverFunctionId &&
          existingWaitForResponse === payload.waitForResponse &&
          (payload.name ?? '') === (existingName ?? '');
        if (isSame && !force) {
          return 'noop';
        }
        if (dryRun) {
          return 'updated';
        }
        const deleted = await deleteTrigger(client, existingTrigger.id);
        if (!deleted) {
          return 'failed';
        }
      }
    } else if (isErrorHandlerTrigger(content)) {
      const { errorHandler, destination, enabled, ownerUserId } = content;
      // Find function ID by name and context
      func = functions.find(
        (fn: any) =>
          fn.name === destination.functionName &&
          fn.context === destination.functionContext
      );
      if (!func) {
        log.error(
          {
            functionName: destination.functionName,
            context: destination.functionContext,
          },
          'Function not found for error handler trigger'
        );
        return 'failed';
      }
      payload = {
        ...(name ? { name } : {}),
        source: {
          errorHandler: {
            path: errorHandler.path,
            ...(errorHandler.applicationIds
              ? { applicationIds: errorHandler.applicationIds }
              : {}),
            ...(errorHandler.userIds ? { userIds: errorHandler.userIds } : {}),
            ...(errorHandler.functionIds
              ? { functionIds: errorHandler.functionIds }
              : {}),
          },
        },
        destination: { serverFunctionId: func.id },
        ...(enabled !== undefined ? { enabled } : {}),
        ...(ownerUserId !== undefined ? { ownerUserId } : {}),
      };
      log.debug(
        { functionId: func.id, triggerName: payload.name },
        'Resolved error handler trigger IDs'
      );
      // Check if trigger already exists (prefer name match)
      if (payload.name) {
        existingTrigger = existingTriggers.find(
          (t: any) => t.name === payload.name
        );
      }
      if (!existingTrigger) {
        existingTrigger = existingTriggers.find(
          (t: any) =>
            !getTriggerWebhookId(t) &&
            getTriggerFunctionId(t) === func.id &&
            t.errorHandler?.path === errorHandler.path
        );
      }
      if (existingTrigger) {
        const isSame =
          getTriggerFunctionId(existingTrigger) ===
            payload.destination.serverFunctionId &&
          existingTrigger.errorHandler?.path === errorHandler.path &&
          sortedIds(existingTrigger.errorHandler?.applicationIds) ===
            sortedIds(errorHandler.applicationIds) &&
          sortedIds(existingTrigger.errorHandler?.userIds) ===
            sortedIds(errorHandler.userIds) &&
          sortedIds(existingTrigger.errorHandler?.functionIds) ===
            sortedIds(errorHandler.functionIds) &&
          (existingTrigger.enabled ?? true) === (enabled ?? true) &&
          (payload.name ?? '') === (existingTrigger.name ?? '');
        if (isSame && !force) {
          return 'noop';
        }
        if (dryRun) {
          return 'updated';
        }
        const deleted = await deleteTrigger(client, existingTrigger.id);
        if (!deleted) {
          return 'failed';
        }
      }
    } else {
      log.error(
        { content },
        'Unknown trigger type: must be webhook or error handler'
      );
      return 'failed';
    }

    if (dryRun) {
      return existingTrigger ? 'updated' : 'created';
    }

    if (
      !validateEndpointPayload('CreateTriggerDto', payload, {
        artifactType: 'Trigger',
        artifactName: name ?? trigger.fileName,
        filePath: trigger.filePath,
      })
    ) {
      return 'failed';
    }

    const { error, response } = await client.POST('/triggers', {
      body: payload as any,
    });

    if (error) {
      log.error(
        {
          functionName: func?.name,
          status: (response as any)?.status,
          error,
        },
        'Failed to create trigger'
      );
      return 'failed';
    }

    return existingTrigger ? 'updated' : 'created';
  } catch (error) {
    log.error({ error }, 'Error processing trigger');
    return 'failed';
  }
}

/**
 * Synchronize triggers with the API
 */
export async function syncTriggers(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindTriggerFileOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const triggerFiles = findTriggerFiles(options.discoveryOptions);
  const allTriggerFiles = findTriggerFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });

  log.info(chalk.cyan(createHeader('TRIGGERS')));

  if (triggerFiles.length === 0) {
    log.warn(
      warningColor(
        'No trigger files found in src/**/artefacts/triggers/ (legacy src/**/artifacts/triggers/ is also supported)'
      )
    );
    return;
  }

  log.info(chalk.gray(`Found ${triggerFiles.length} local trigger file(s)`));

  // Get fresh lists of webhooks and functions for ID resolution
  const namespaces = getRequiredNamespaces();
  const webhooksForTriggers = await getExistingWebhooks(client);
  const functionsForTriggers = await getExistingServerFunctions(client);
  const webhooksInNamespace = webhooksForTriggers.filter((webhook: any) =>
    matchesAnyRequiredNamespace(webhook.context)
  );
  const functionsInNamespace = functionsForTriggers.filter((fn: any) =>
    matchesAnyRequiredNamespace(fn.context)
  );
  log.info(
    chalk.gray(
      `Resolved ${webhooksInNamespace.length} webhook(s) and ${functionsInNamespace.length} function(s) in namespace(s) "${namespaces.join(", ")}"`
    )
  );

  // Step 1: Get existing triggers from API (filtered by namespace)
  const allTriggers = await getExistingTriggers(client);
  log.debug({ count: allTriggers.length }, 'Fetched triggers from API');
  const webhookIds = new Set(
    webhooksInNamespace.map((webhook: any) => webhook.id)
  );
  const functionIds = new Set(functionsInNamespace.map((fn: any) => fn.id));
  // Filter triggers where either the webhook or function is in our namespace
  const existingTriggers = allTriggers.filter((trigger: any) => {
    const webhookId = getTriggerWebhookId(trigger);
    const functionId = getTriggerFunctionId(trigger);
    return (
      (webhookId && webhookIds.has(webhookId)) ||
      (functionId && functionIds.has(functionId))
    );
  });
  log.info(
    chalk.gray(
      `Fetched ${existingTriggers.length} trigger(s) from API in namespace(s) "${namespaces.join(", ")}"`
    )
  );

  // Step 2: Delete triggers that don't exist locally
  if (options.detectOrphans === false) {
    log.info(chalk.gray('Skipping orphan detection for scoped trigger sync'));
  } else {
    const localTriggerKeys = new Set(
      allTriggerFiles
        .map(tf => {
          const content = tf.content;
          if (isWebhookTrigger(content)) {
            const wh = webhooksForTriggers.find(
              (w: any) =>
                w.name === content.source.webhookName &&
                w.context === content.source.webhookContext
            );
            const fn = functionsForTriggers.find(
              (f: any) =>
                f.name === content.destination.functionName &&
                f.context === content.destination.functionContext
            );
            return wh && fn ? `${wh.id}:${fn.id}` : null;
          } else if (isErrorHandlerTrigger(content)) {
            const fn = functionsForTriggers.find(
              (f: any) =>
                f.name === content.destination.functionName &&
                f.context === content.destination.functionContext
            );
            return fn ? `${content.errorHandler.path}:${fn.id}` : null;
          }
          return null;
        })
        .filter(Boolean)
    );

    const localTriggerNames = new Set(
      triggerFiles.map(tf => getTriggerName(tf)).filter(Boolean)
    );

    const orphanCandidates = existingTriggers.filter((trigger: any) => {
      if (trigger.name && localTriggerNames.has(trigger.name)) {
        return false;
      }
      const webhookId = getTriggerWebhookId(trigger);
      const functionId = getTriggerFunctionId(trigger);
      const key = webhookId
        ? `${webhookId}:${functionId}`
        : `${trigger.errorHandler?.path}:${functionId}`;
      return !localTriggerKeys.has(key);
    });
    const { included: triggersToDeleteByContext, excluded: excludedTriggers } =
      filterOrphansByContext(
        orphanCandidates.map((trigger: any) => ({
          trigger,
          context:
            trigger.source?.webhook?.context ||
            trigger.destination?.serverFunction?.context ||
            '',
        }))
      );
    const triggersToDelete = triggersToDeleteByContext.map(
      item => item.trigger as any
    );
    if (excludedTriggers.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excludedTriggers.length} trigger orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (triggersToDelete.length > 0) {
      if (deleteOrphans) {
        log.info(
          warningColor(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${triggersToDelete.length} trigger(s) not in local files...`
          )
        );
        for (const trigger of triggersToDelete) {
          if (options.dryRun) {
            log.info(
              chalk.blue(`    [PLAN] Delete ${trigger.name ?? trigger.id}`)
            );
            summary.planned++;
            continue;
          }

          await deleteTrigger(client, trigger.id);
          await sleep(300);
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${triggersToDelete.length} orphaned trigger(s) (skipping deletion)`
          )
        );
        for (const trigger of triggersToDelete) {
          const displayName =
            trigger.name ||
            (trigger.errorHandler
              ? `errorHandler:${trigger.errorHandler.path}`
              : trigger.webhookHandleId
                ? `webhook:${trigger.webhookHandleId}`
                : 'unknown');
          const displayContext = trigger.errorHandler?.path || '';
          orphans.push({
            type: 'trigger',
            name: displayName,
            context: displayContext,
            id: trigger.id,
          });
        }
      }
    } else {
      log.debug('No triggers to delete');
    }
  }

  // Step 3: Create or update local triggers
  log.info(chalk.blue('Syncing triggers...'));
  for (const trigger of triggerFiles) {
    // Print a meaningful summary for each trigger type
    if (isWebhookTrigger(trigger.content)) {
      const { source, destination } = trigger.content;
      log.info(
        chalk.dim(
          `  → Webhook: ${source.webhookName} → ${destination.functionName}`
        )
      );
      // Namespace validation for webhook triggers
      try {
        validateNamespace(
          source.webhookContext,
          'Trigger webhook',
          source.webhookName
        );
        validateNamespace(
          destination.functionContext,
          'Trigger function',
          destination.functionName
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
    } else if (isErrorHandlerTrigger(trigger.content)) {
      const { errorHandler, destination } = trigger.content;
      log.info(
        chalk.dim(
          `  → ErrorHandler: ${errorHandler.path} → ${destination.functionName}`
        )
      );
      // Namespace validation for error handler triggers (only function destination)
      try {
        validateNamespace(
          destination.functionContext,
          'Trigger function',
          destination.functionName
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
    } else {
      log.info(chalk.dim('  → Unknown trigger type'));
      summary.failed++;
      continue;
    }

    // Validate artifact structure before syncing
    if (
      !validateTriggerArtifact(trigger.content, trigger.filePath, skipInvalid)
    ) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    const result = await postTrigger(
      client,
      trigger,
      webhooksForTriggers,
      functionsForTriggers,
      existingTriggers,
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
    } else if (result === 'updated') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Update'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Updated'));
        summary.updated++;
      }
    } else if (result === 'noop') {
      log.info(chalk.gray('    [SKIP] Unchanged'));
      summary.skipped++;
    } else {
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
    }
    await sleep(500);
  }
}

function sortedIds(ids: string[] | undefined): string {
  return (ids ?? []).slice().sort().join(',');
}

function getTriggerName(trigger: TriggerFile): string | undefined {
  const content = trigger.content as any;
  if (typeof content.name === 'string') {
    return content.name;
  }

  const base = trigger.fileName.replace(/\.json$/i, '');
  const sanitized = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');

  return sanitized.length > 0 ? sanitized : undefined;
}

function getTriggerWebhookId(trigger: any): string | undefined {
  return (
    trigger?.source?.webhookHandleId ??
    trigger?.webhookHandleId ??
    trigger?.source?.webhook?.id ??
    trigger?.webhook?.id
  );
}

function getTriggerFunctionId(trigger: any): string | undefined {
  return (
    trigger?.destination?.serverFunctionId ??
    trigger?.serverFunctionId ??
    trigger?.destination?.serverFunction?.id ??
    trigger?.serverFunction?.id
  );
}
