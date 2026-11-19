/**
 * `flow jobs run <name>`: run a deployed job once, now, through
 * `POST /jobs/{id}/trigger` (PolyAPI R35). The schedule is not changed.
 */
import { parseArgs } from 'node:util';

type ApiResult = {
  data?: unknown;
  error?: unknown;
  response?: { status?: number };
};

export interface JobsRunClient {
  GET(path: string, options?: Record<string, unknown>): Promise<ApiResult>;
  POST(path: string, options: Record<string, unknown>): Promise<ApiResult>;
}

export interface JobsRunArgs {
  help: boolean;
  dryRun: boolean;
  name?: string;
}

export interface JobTriggerResult {
  jobId: string;
  runId: string;
  queuedAt?: string;
}

export const JOBS_RUN_HELP = `Usage: flow jobs run <job-name> [--dry-run]

Runs a deployed job once, immediately, without changing its schedule. The job
is found by its exact name in the environment verified by TARGET_ENV_ID; a job
ID is also accepted. Prints the run ID returned by PolyAPI.

Options:
  --dry-run   Resolve the job and show what would run, without triggering it.
  -h, --help  Show this help.`;

/**
 * Returns null when argv is not a `jobs` command, so other commands keep
 * their own parsing.
 */
export function parseJobsRunArgs(argv: string[]): JobsRunArgs | null {
  const args = argv.filter(argument => argument !== '--');
  if (args[0] !== 'jobs') {
    return null;
  }
  if (args[1] === undefined || args[1] === '--help' || args[1] === '-h') {
    return { help: true, dryRun: false };
  }
  if (args[1] !== 'run') {
    throw new Error(
      `Unknown jobs subcommand "${args[1]}". Use "flow jobs run <job-name>".`
    );
  }
  const { values, positionals } = parseArgs({
    args: args.slice(2),
    options: {
      help: { type: 'boolean', short: 'h' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    return { help: true, dryRun: false };
  }
  if (positionals.length !== 1 || !positionals[0].trim()) {
    throw new Error('flow jobs run needs exactly one job name.');
  }
  return {
    help: false,
    dryRun: values['dry-run'] === true,
    name: positionals[0].trim(),
  };
}

function toJobList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === 'object'
    );
  }
  if (data && typeof data === 'object') {
    for (const key of ['results', 'items', 'data']) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return toJobList(value);
    }
  }
  return [];
}

/** Find exactly one job by name (or ID); ambiguity and absence are errors. */
export async function resolveJob(
  client: JobsRunClient,
  nameOrId: string
): Promise<{ id: string; name: string }> {
  const { data, error, response } = await client.GET('/jobs', {});
  if (error || !data) {
    throw new Error(
      `Could not list jobs (status ${response?.status ?? 'n/a'}).`
    );
  }
  const jobs = toJobList(data).filter(
    (job): job is { id: string; name: string } =>
      typeof job.id === 'string' && typeof job.name === 'string'
  );
  const byName = jobs.filter(job => job.name === nameOrId);
  if (byName.length > 1) {
    throw new Error(
      `${byName.length} jobs are named "${nameOrId}" (${byName
        .map(job => job.id)
        .join(', ')}). Run one by its ID instead.`
    );
  }
  const match = byName[0] ?? jobs.find(job => job.id === nameOrId);
  if (!match) {
    throw new Error(
      `No job named "${nameOrId}" in the target environment. Deploy it first with "flow push --types jobs".`
    );
  }
  return { id: match.id, name: match.name };
}

export async function triggerJob(
  client: JobsRunClient,
  jobId: string
): Promise<JobTriggerResult> {
  const { data, error, response } = await client.POST('/jobs/{id}/trigger', {
    params: { path: { id: jobId } },
  });
  if (error) {
    const status = response?.status;
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : JSON.stringify(error);
    throw new Error(
      status === 404
        ? 'PolyAPI did not find the job trigger endpoint or the job. Job runs need PolyAPI R35 or later.'
        : `Failed to run job (status ${status ?? 'n/a'}): ${message}`
    );
  }
  const record = (data ?? {}) as Record<string, unknown>;
  if (typeof record.runId !== 'string') {
    throw new Error('PolyAPI accepted the run but returned no runId.');
  }
  return {
    jobId: typeof record.jobId === 'string' ? record.jobId : jobId,
    runId: record.runId,
    ...(typeof record.queuedAt === 'string'
      ? { queuedAt: record.queuedAt }
      : {}),
  };
}

export async function runJobsRun(
  args: JobsRunArgs,
  client: JobsRunClient,
  print: (message: string) => void
): Promise<JobTriggerResult | null> {
  if (!args.name) {
    throw new Error('flow jobs run needs a job name.');
  }
  const job = await resolveJob(client, args.name);
  if (args.dryRun) {
    print(`[PLAN] Run job ${job.name} (${job.id}) now`);
    return null;
  }
  const result = await triggerJob(client, job.id);
  print(
    `Queued job ${job.name} (${result.jobId})${
      result.queuedAt ? ` at ${result.queuedAt}` : ''
    }`
  );
  print(`runId: ${result.runId}`);
  return result;
}
