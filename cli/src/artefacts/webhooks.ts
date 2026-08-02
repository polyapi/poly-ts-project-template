import type createClient from 'openapi-fetch';
import type { components, paths } from '../sdk/schema';
import type { WebhookFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { areComparisonPayloadsEqual } from '../utils/payloadComparison';

type WebhookHandleBasicDto = components['schemas']['WebhookHandleBasicDto'];
type WebhookHandleDto = components['schemas']['WebhookHandleDto'];
type CreateWebhookHandleDto =
  paths['/webhooks']['post']['requestBody']['content']['application/json'];
type UpdateWebhookHandleDto =
  paths['/webhooks/{id}']['patch']['requestBody']['content']['application/json'];

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
import { chalk, createHeader, createLogger, warningColor } from '../utils/logger';
import { getRequiredNamespaces, matchesAnyRequiredNamespace, validateNamespace } from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { validateWebhookArtifact } from '../utils/validation';

const log = createLogger('webhooks');
type FindWebhookFileOptions = WalkDirOptions;

/**
 * Find all webhook JSON files in the project
 */
export function findWebhookFiles(
  options: FindWebhookFileOptions = {}
): WebhookFile[] {
  const webhookFiles: WebhookFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        isInNamedDirectory(fullPath, 'webhooks') &&
        isInArtefactDirectory(fullPath)
      ) {
        const content = readJsonFile(fullPath);
        if (content) {
          webhookFiles.push({
            filePath: fullPath,
            fileName: file,
            content,
          });
        }
      }
    },
    options
  );

  return webhookFiles;
}

/**
 * Get all existing webhooks from the API
 */
export async function getExistingWebhooks(
  client: ReturnType<typeof createClient<paths>>
): Promise<WebhookHandleBasicDto[]> {
  try {
    const { data, error } = await client.GET('/webhooks', {});

    if (error || !data) {
      return [];
    }

    return data;
  } catch (error) {
    log.warn({ error }, 'Failed to fetch webhooks from API');
    return [];
  }
}

/**
 * Check if a webhook already exists
 */
function webhookExists(
  name: string,
  context: string,
  existingWebhooks: WebhookHandleBasicDto[]
): boolean {
  return existingWebhooks.some(
    webhook => webhook.name === name && webhook.context === context
  );
}

/**
 * Delete a webhook by ID
 */
async function deleteWebhook(
  client: ReturnType<typeof createClient<paths>>,
  webhookId: string,
  name: string,
  context: string
): Promise<boolean> {
  try {
    const { error, response } = await client.DELETE('/webhooks/{id}', {
      params: { path: { id: webhookId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      log.error(
        { name, context, status: (response as any)?.status, error },
        'Failed to delete webhook'
      );
      return false;
    } else {
      log.info({ name, context }, 'Webhook deleted');
      return true;
    }
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting webhook');
    return false;
  }
}

/**
 * POST or PUT a webhook to the API
 */
function normalizeSecurityFunctions(
  securityFunctions:
    | components['schemas']['WebhookSecurityFunction'][]
    | undefined
): components['schemas']['WebhookSecurityFunction'][] | undefined {
  if (!securityFunctions) {
    return undefined;
  }

  return [...securityFunctions]
    .map(securityFunction => ({
      id: securityFunction.id,
      ...(securityFunction.message !== undefined
        ? { message: securityFunction.message }
        : {}),
    }))
    .sort((left, right) =>
      `${left.id}:${left.message ?? ''}`.localeCompare(
        `${right.id}:${right.message ?? ''}`
      )
    );
}

async function buildWebhookPayload(
  webhook: WebhookFile,
  functions: any[]
): Promise<Record<string, unknown> | null> {
  const payload = { ...webhook.content } as Record<string, unknown>;

  if (payload.eventPayload && payload.eventPayloadTypeSchema !== undefined) {
    delete payload.eventPayloadTypeSchema;
  }

  if (Array.isArray(payload.securityFunctions)) {
    const resolvedSecurityFunctions = [];
    for (const securityFunction of payload.securityFunctions as Array<any>) {
      const idValue = securityFunction.id;
      const referenceMatch =
        typeof idValue === 'string'
          ? idValue.match(/^\{\{(.+)\.([^.]+)\}\}$/)
          : null;

      if (referenceMatch) {
        const [, functionContext, functionName] = referenceMatch;
        const func = functions.find(
          (fn: any) =>
            fn.name === functionName && fn.context === functionContext
        );

        if (!func) {
          log.error(
            {
              reference: idValue,
              functionName,
              context: functionContext,
            },
            'Security function not found for webhook'
          );
          return null;
        }

        resolvedSecurityFunctions.push({
          id: func.id,
          message: securityFunction.message,
        });
        log.debug(
          {
            reference: idValue,
            functionId: func.id,
          },
          'Resolved security function reference'
        );
      } else {
        resolvedSecurityFunctions.push(securityFunction);
      }
    }

    payload.securityFunctions = normalizeSecurityFunctions(
      resolvedSecurityFunctions as components['schemas']['WebhookSecurityFunction'][]
    );
  }

  return payload;
}

async function getExistingWebhookDetails(
  client: ReturnType<typeof createClient<paths>>,
  webhookId: string
): Promise<WebhookHandleDto | null> {
  try {
    const { data, error, response } = await client.GET('/webhooks/{id}', {
      params: { path: { id: webhookId } },
    });

    if (error || !data) {
      log.warn(
        { webhookId, status: (response as any)?.status },
        'Failed to fetch webhook details'
      );
      return null;
    }

    return data as WebhookHandleDto;
  } catch (error) {
    log.warn({ error, webhookId }, 'Error fetching webhook details');
    return null;
  }
}

function buildRemoteWebhookPayload(
  localPayload: Record<string, unknown>,
  remoteWebhook: WebhookHandleDto,
  existingWebhook: WebhookHandleBasicDto
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: remoteWebhook.name,
    description: remoteWebhook.description,
    context: remoteWebhook.context,
  };

  if (localPayload.visibility !== undefined) {
    payload.visibility = remoteWebhook.visibility;
  }
  if (localPayload.state !== undefined) {
    payload.state = existingWebhook.state;
  }
  if (localPayload.eventPayloadTypeSchema !== undefined) {
    payload.eventPayloadTypeSchema = remoteWebhook.eventPayloadTypeSchema;
  }
  if (localPayload.responsePayload !== undefined) {
    payload.responsePayload = remoteWebhook.responsePayload;
  }
  if (localPayload.responseHeaders !== undefined) {
    payload.responseHeaders = remoteWebhook.responseHeaders;
  }
  if (localPayload.responseStatus !== undefined) {
    payload.responseStatus = remoteWebhook.responseStatus;
  }
  if (localPayload.slug !== undefined) {
    payload.slug = remoteWebhook.slug;
  }
  if (localPayload.subpath !== undefined) {
    payload.subpath = remoteWebhook.subpath;
  }
  if (localPayload.method !== undefined) {
    payload.method = remoteWebhook.method;
  }
  if (localPayload.requirePolyApiKey !== undefined) {
    payload.requirePolyApiKey = remoteWebhook.requirePolyApiKey;
  }
  if (localPayload.securityFunctions !== undefined) {
    payload.securityFunctions = normalizeSecurityFunctions(
      remoteWebhook.securityFunctions
    );
  }
  if (localPayload.xmlParserOptions !== undefined) {
    const localXmlParserOptions = localPayload.xmlParserOptions as
      | Record<string, unknown>
      | undefined;
    const remoteXmlParserOptions = remoteWebhook.xmlParserOptions as
      | Record<string, unknown>
      | undefined;

    payload.xmlParserOptions = Object.fromEntries(
      Object.keys(localXmlParserOptions ?? {}).map(key => [
        key,
        remoteXmlParserOptions?.[key],
      ])
    );
  }
  if (localPayload.ownerUserId !== undefined) {
    payload.ownerUserId = remoteWebhook.ownerUserId ?? null;
  }
  if (localPayload.enabled !== undefined) {
    payload.enabled = remoteWebhook.enabled;
  }

  return payload;
}

async function postWebhook(
  client: ReturnType<typeof createClient<paths>>,
  webhook: WebhookFile,
  existingWebhooks: WebhookHandleBasicDto[],
  functions: any[],
  dryRun: boolean = false,
  force: boolean = false
): Promise<'created' | 'updated' | 'noop' | 'failed'> {
  try {
    const webhookName = webhook.content.name || 'N/A';
    const webhookContext = webhook.content.context || '';
    const payload = await buildWebhookPayload(webhook, functions);
    if (!payload) {
      return 'failed';
    }

    const exists = webhookExists(webhookName, webhookContext, existingWebhooks);

    if (exists) {
      // Find the existing webhook to get its ID
      const existingWebhook = existingWebhooks.find(
        wh => wh.name === webhookName && wh.context === webhookContext
      );

      if (!existingWebhook) {
        log.error(
          { name: webhookName, context: webhookContext },
          'Webhook exists but not found in list'
        );
        return 'failed';
      }

      const webhookDetails = await getExistingWebhookDetails(
        client,
        existingWebhook.id
      );
      if (
        !force &&
        webhookDetails &&
        areComparisonPayloadsEqual(
          payload,
          buildRemoteWebhookPayload(payload, webhookDetails, existingWebhook)
        )
      ) {
        return 'noop';
      }

      if (dryRun) {
        return 'updated';
      }

      if (
        !validateEndpointPayload('UpdateWebhookHandleDto', payload, {
          artifactType: 'Webhook',
          artifactName: webhookName,
          filePath: webhook.filePath,
        })
      ) {
        return 'failed';
      }

      const { error, response } = await client.PATCH('/webhooks/{id}', {
        params: { path: { id: existingWebhook.id } },
        body: payload as UpdateWebhookHandleDto,
      });

      if (error) {
        log.error(
          {
            name: webhookName,
            context: webhookContext,
            status: (response as any)?.status,
            error,
          },
          'Failed to update webhook'
        );
        return 'failed';
      } else {
        return 'updated';
      }
    } else {
      if (dryRun) {
        return 'created';
      }

      if (
        !validateEndpointPayload('CreateWebhookHandleDto', payload, {
          artifactType: 'Webhook',
          artifactName: webhookName,
          filePath: webhook.filePath,
        })
      ) {
        return 'failed';
      }

      const { error, response } = await client.POST('/webhooks', {
        body: payload as CreateWebhookHandleDto,
      });

      if (error) {
        log.error(
          {
            name: webhookName,
            context: webhookContext,
            status: (response as any)?.status,
            error,
          },
          'Failed to create webhook'
        );
        return 'failed';
      } else {
        return 'created';
      }
    }
  } catch (error) {
    log.error({ error }, 'Error processing webhook');
    return 'failed';
  }
}

/**
 * Synchronize webhooks with the API
 */
export async function syncWebhooks(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindWebhookFileOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const webhookFiles = findWebhookFiles(options.discoveryOptions);
  const allWebhookFiles = findWebhookFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });

  log.info(chalk.cyan(createHeader('WEBHOOKS')));

  if (webhookFiles.length === 0) {
    log.warn(
      warningColor(
        'No webhook JSON files found in src/**/artefacts/webhooks/ (legacy src/**/artifacts/webhooks/ is also supported)'
      )
    );
    return;
  }

  log.info(chalk.gray(`Found ${webhookFiles.length} local webhook file(s)`));

  // Step 1: Get existing webhooks from API (filtered by namespace)
  const namespaces = getRequiredNamespaces();
  const allWebhooks = await getExistingWebhooks(client);
  const existingWebhooks = allWebhooks.filter(webhook =>
    matchesAnyRequiredNamespace(webhook.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${existingWebhooks.length} webhook(s) from API in namespace(s) "${namespaces.join(", ")}"`
    )
  );

  // Step 1b: Get existing functions for security function resolution
  const { getExistingServerFunctions } = await import('./functions');
  const allFunctions = await getExistingServerFunctions(client);
  const functionsInNamespace = allFunctions.filter((fn: any) =>
    matchesAnyRequiredNamespace(fn.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${functionsInNamespace.length} function(s) from API in namespace(s) "${namespaces.join(", ")}"`
    )
  );

  // Step 2: Identify webhooks that don't exist locally (orphans)
  const localWebhookKeys = new Set(
    allWebhookFiles.map(wf => `${wf.content.name}:${wf.content.context}`)
  );

  if (options.detectOrphans === false) {
    log.info(chalk.gray('Skipping orphan detection for scoped webhook sync'));
  } else {
    const orphanCandidates = existingWebhooks.filter(
      (webhook: any) =>
        !localWebhookKeys.has(`${webhook.name}:${webhook.context}`)
    );
    const { included: webhooksToDelete, excluded: excludedWebhooks } =
      filterOrphansByContext(orphanCandidates);
    if (excludedWebhooks.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excludedWebhooks.length} webhook orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (webhooksToDelete.length > 0) {
      if (deleteOrphans) {
        log.info(
          warningColor(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${webhooksToDelete.length} webhook(s) not in local files...`
          )
        );
        for (const webhook of webhooksToDelete) {
          if (options.dryRun) {
            log.info(
              chalk.blue(
                `    [PLAN] Delete ${webhook.name} (${webhook.context})`
              )
            );
            summary.planned++;
            continue;
          }

          const result = await deleteWebhook(
            client,
            webhook.id,
            webhook.name,
            webhook.context
          );
          if (result) summary.deleted++;
          else summary.failed++;
          await sleep(300);
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${webhooksToDelete.length} orphaned webhook(s) (skipping deletion)`
          )
        );
        for (const webhook of webhooksToDelete) {
          orphans.push({
            type: 'webhook',
            name: webhook.name,
            context: webhook.context,
            id: webhook.id,
          });
        }
      }
    } else {
      log.debug('No webhooks to delete');
    }
  }

  // Step 3: Create or update local webhooks
  log.info(chalk.blue('Comparing local webhook payloads with API...'));
  for (const webhook of webhookFiles) {
    const webhookName = webhook.content.name || 'N/A';
    const webhookContext = webhook.content.context || '';
    log.info(chalk.dim(`  → ${webhookName} (${webhookContext})`));

    // Validate artifact structure before syncing
    if (
      !validateWebhookArtifact(webhook.content, webhook.filePath, skipInvalid)
    ) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    // Validate namespace
    try {
      validateNamespace(webhookContext, 'Webhook', webhookName);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'Namespace validation failed'
      );
      log.info(chalk.red('    [FAIL] Failed (namespace)'));
      summary.failed++;
      continue;
    }

    const result = await postWebhook(
      client,
      webhook,
      existingWebhooks,
      functionsInNamespace,
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
