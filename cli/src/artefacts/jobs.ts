import type createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import type { JobFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import {
  getSrcPath,
  readJsonFile,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import { chalk, createHeader, createLogger } from '../utils/logger';
import { getRequiredNamespace } from '../utils/namespace';
import { areComparisonPayloadsEqual } from '../utils/payloadComparison';
import { validateJobArtifact } from '../utils/validation';
import { getExistingServerFunctions } from './functions';

const log = createLogger('jobs');
type FindJobFileOptions = WalkDirOptions;
type CreateJobDto =
  paths['/jobs']['post']['requestBody']['content']['application/json'];
type UpdateJobDto =
  paths['/jobs/{id}']['patch']['requestBody']['content']['application/json'];

/**
 * Find all job JSON files in the project (artefacts/jobs/*.json)
 */
export function findJobFiles(options: FindJobFileOptions = {}): JobFile[] {
  const jobFiles: JobFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        fullPath.includes('/jobs/') &&
        fullPath.includes('/artefacts/')
      ) {
        const content = readJsonFile(fullPath);
        if (content) {
          jobFiles.push({
            filePath: fullPath,
            fileName: file,
            content,
          });
        }
      }
    },
    options
  );

  return jobFiles;
}

/**
 * Get all existing jobs from the API
 */
async function getExistingJobs(
  client: ReturnType<typeof createClient<paths>>
): Promise<any[]> {
  try {
    const { data, error } = await client.GET('/jobs', {});

    if (error || !data) {
      return [];
    }

    return data as any[];
  } catch (error) {
    log.warn({ error }, 'Failed to fetch jobs from API');
    return [];
  }
}

/**
 * Delete a job by ID
 */
async function deleteJob(
  client: ReturnType<typeof createClient<paths>>,
  jobId: string,
  name: string
): Promise<boolean> {
  try {
    const { error, response } = await client.DELETE('/jobs/{id}', {
      params: { path: { id: jobId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      log.error(
        { jobId, name, status: (response as any)?.status },
        'Failed to delete job'
      );
      return false;
    }

    log.info({ jobId, name }, 'Job deleted');
    return true;
  } catch (error) {
    log.error({ error, name }, 'Error deleting job');
    return false;
  }
}

/**
 * Resolve function references (name+context) to IDs
 * Returns null if any function cannot be resolved
 */
function resolveFunctionRefs(
  jobFile: JobFile,
  functions: any[]
):
  | {
      id: string;
      eventPayload: object;
      headersPayload: object;
      paramsPayload: object;
    }[]
  | null {
  const resolved = [];

  for (const ref of jobFile.content.functions) {
    const fn = functions.find(
      f => f.name === ref.functionName && f.context === ref.functionContext
    );

    if (!fn) {
      log.error(
        { functionName: ref.functionName, context: ref.functionContext },
        'Function not found for job'
      );
      return null;
    }

    resolved.push({
      id: fn.id,
      eventPayload: ref.eventPayload ?? {},
      headersPayload: ref.headersPayload ?? {},
      paramsPayload: ref.paramsPayload ?? {},
    });
  }

  return resolved;
}

function buildJobPayload(
  jobFile: JobFile,
  resolvedFunctions: {
    id: string;
    eventPayload: object;
    headersPayload: object;
    paramsPayload: object;
  }[]
): CreateJobDto {
  const { name, schedule, executionType, enabled, ownerUserId } =
    jobFile.content;

  return {
    name,
    schedule,
    executionType,
    enabled,
    functions: resolvedFunctions as CreateJobDto['functions'],
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
  };
}

function buildRemoteJobPayload(
  localPayload: Record<string, unknown>,
  existingJob: any
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: existingJob.name,
    executionType: existingJob.executionType,
    enabled: existingJob.enabled,
    functions: (existingJob.functions ?? []).map((f: any) => ({
      id: f.id,
      eventPayload: f.eventPayload ?? {},
      headersPayload: f.headersPayload ?? {},
      paramsPayload: f.paramsPayload ?? {},
    })),
  };

  if (localPayload.schedule !== undefined) {
    const localSchedule = localPayload.schedule as Record<string, unknown>;
    const remoteSchedule = existingJob.schedule as
      | Record<string, unknown>
      | undefined;
    payload.schedule = Object.fromEntries(
      Object.keys(localSchedule).map(key => [key, remoteSchedule?.[key]])
    );
  }

  if (localPayload.ownerUserId !== undefined) {
    payload.ownerUserId = existingJob.ownerUserId ?? null;
  }

  return payload;
}

/**
 * Create or update a job
 * Returns: 'created' | 'updated' | 'noop' | 'failed'
 */
async function syncJob(
  client: ReturnType<typeof createClient<paths>>,
  jobFile: JobFile,
  functions: any[],
  existingJobs: any[],
  dryRun: boolean = false,
  force: boolean = false
): Promise<'created' | 'updated' | 'noop' | 'failed'> {
  const { name } = jobFile.content;

  const resolvedFunctions = resolveFunctionRefs(jobFile, functions);
  if (!resolvedFunctions) {
    return 'failed';
  }

  const existingJob = existingJobs.find(j => j.name === name);
  const payload = buildJobPayload(jobFile, resolvedFunctions);

  if (existingJob) {
    if (
      !force &&
      areComparisonPayloadsEqual(
        payload,
        buildRemoteJobPayload(payload, existingJob)
      )
    ) {
      return 'noop';
    }

    if (dryRun) {
      return 'updated';
    }

    if (
      !validateEndpointPayload('UpdateJobDto', payload, {
        artifactType: 'Job',
        artifactName: name,
        filePath: jobFile.filePath,
      })
    ) {
      return 'failed';
    }

    try {
      const { error, response } = await client.PATCH('/jobs/{id}', {
        params: { path: { id: existingJob.id } },
        body: payload as UpdateJobDto,
      });

      if (error) {
        log.error(
          { name, status: (response as any)?.status, error },
          'Failed to update job'
        );
        return 'failed';
      }

      return 'updated';
    } catch (error) {
      log.error({ error, name }, 'Error updating job');
      return 'failed';
    }
  }

  if (dryRun) {
    return 'created';
  }

  if (
    !validateEndpointPayload('CreateJobDto', payload, {
      artifactType: 'Job',
      artifactName: name,
      filePath: jobFile.filePath,
    })
  ) {
    return 'failed';
  }

  try {
    const { error, response } = await client.POST('/jobs', {
      body: payload,
    });

    if (error) {
      log.error(
        { name, status: (response as any)?.status, error },
        'Failed to create job'
      );
      return 'failed';
    }

    return 'created';
  } catch (error) {
    log.error({ error, name }, 'Error creating job');
    return 'failed';
  }
}

/**
 * Synchronize jobs with the API
 */
export async function syncJobs(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindJobFileOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const jobFiles = findJobFiles(options.discoveryOptions);
  const allJobFiles = findJobFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });

  log.info(chalk.cyan(createHeader('JOBS')));

  if (jobFiles.length === 0) {
    log.info(chalk.gray('No job files found in src/**/artefacts/jobs/'));
    return;
  }

  log.info(chalk.gray(`Found ${jobFiles.length} local job file(s)`));

  // Resolve all server functions (jobs reference functions by name+context)
  const namespace = getRequiredNamespace();
  const allFunctions = await getExistingServerFunctions(client);
  const functionsInNamespace = allFunctions.filter((fn: any) =>
    fn.context?.startsWith(namespace)
  );
  log.info(
    chalk.gray(
      `Resolved ${functionsInNamespace.length} server function(s) in namespace "${namespace}"`
    )
  );

  // Get existing jobs from API
  const existingJobs = await getExistingJobs(client);
  log.info(
    chalk.gray(`Fetched ${existingJobs.length} existing job(s) from API`)
  );

  // Step 1: Identify orphaned jobs (exist remotely but not locally)
  if (options.detectOrphans === false) {
    log.info(chalk.gray('Skipping orphan detection for scoped job sync'));
  } else {
    const localJobNames = new Set(allJobFiles.map(jf => jf.content.name));
    const orphanCandidates = existingJobs.filter(
      (job: any) => !localJobNames.has(job.name)
    );

    if (orphanCandidates.length > 0) {
      if (deleteOrphans) {
        log.info(
          chalk.yellow(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${orphanCandidates.length} job(s) not in local files...`
          )
        );
        for (const job of orphanCandidates) {
          if (options.dryRun) {
            log.info(chalk.blue(`    [PLAN] Delete ${job.name}`));
            summary.planned++;
            continue;
          }

          const deleted = await deleteJob(client, job.id, job.name);
          if (deleted) {
            summary.deleted++;
          } else {
            summary.failed++;
          }
          await sleep(300);
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${orphanCandidates.length} orphaned job(s) (skipping deletion)`
          )
        );
        for (const job of orphanCandidates) {
          orphans.push({
            type: 'job',
            name: job.name,
            context: '',
            id: job.id,
          });
        }
      }
    } else {
      log.debug('No orphaned jobs');
    }
  }

  // Step 2: Create or update local jobs
  log.info(chalk.blue('Comparing local job payloads with API...'));
  for (const jobFile of jobFiles) {
    const { name } = jobFile.content;
    log.info(chalk.dim(`  → ${name}`));

    if (!validateJobArtifact(jobFile.content, jobFile.filePath, skipInvalid)) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    const result = await syncJob(
      client,
      jobFile,
      functionsInNamespace,
      existingJobs,
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
