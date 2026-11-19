import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type JobsRunClient,
  parseJobsRunArgs,
  resolveJob,
  runJobsRun,
} from './jobsRun';

function fakeClient(
  jobs: unknown,
  trigger: { data?: unknown; error?: unknown; status?: number } = {
    data: {
      jobId: 'job-id',
      runId: 'run-123',
      queuedAt: '2026-11-19T10:00:00.000Z',
    },
  }
) {
  const posts: Array<{ path: string; options: Record<string, unknown> }> = [];
  const client: JobsRunClient = {
    GET: async path => {
      assert.equal(path, '/jobs');
      return { data: jobs };
    },
    POST: async (path, options) => {
      posts.push({ path, options });
      return {
        data: trigger.data,
        error: trigger.error,
        response: { status: trigger.status ?? 202 },
      };
    },
  };
  return { client, posts };
}

test('parses jobs run arguments', () => {
  assert.equal(parseJobsRunArgs(['push']), null);
  assert.deepEqual(parseJobsRunArgs(['jobs', 'run', 'nightly']), {
    help: false,
    dryRun: false,
    name: 'nightly',
  });
  assert.deepEqual(parseJobsRunArgs(['jobs', 'run', 'nightly', '--dry-run']), {
    help: false,
    dryRun: true,
    name: 'nightly',
  });
  assert.equal(parseJobsRunArgs(['jobs'])?.help, true);
  assert.equal(parseJobsRunArgs(['jobs', 'run', '--help'])?.help, true);
  assert.throws(() => parseJobsRunArgs(['jobs', 'run']), /exactly one job/);
  assert.throws(() => parseJobsRunArgs(['jobs', 'stop', 'x']), /Unknown jobs/);
});

test('runs a job by name and prints the run ID', async () => {
  const { client, posts } = fakeClient([
    { id: 'job-id', name: 'nightly' },
    { id: 'other-id', name: 'hourly' },
  ]);
  const output: string[] = [];
  const result = await runJobsRun(
    { help: false, dryRun: false, name: 'nightly' },
    client,
    message => output.push(message)
  );
  assert.equal(result?.runId, 'run-123');
  assert.deepEqual(posts, [
    {
      path: '/jobs/{id}/trigger',
      options: { params: { path: { id: 'job-id' } } },
    },
  ]);
  assert.ok(output.includes('runId: run-123'));
});

test('dry run resolves the job without triggering it', async () => {
  const { client, posts } = fakeClient([{ id: 'job-id', name: 'nightly' }]);
  const output: string[] = [];
  assert.equal(
    await runJobsRun(
      { help: false, dryRun: true, name: 'nightly' },
      client,
      m => output.push(m)
    ),
    null
  );
  assert.deepEqual(posts, []);
  assert.deepEqual(output, ['[PLAN] Run job nightly (job-id) now']);
});

test('missing and ambiguous job names fail clearly', async () => {
  await assert.rejects(
    resolveJob(fakeClient([]).client, 'nightly'),
    /No job named "nightly"/
  );
  await assert.rejects(
    resolveJob(
      fakeClient([
        { id: 'a', name: 'nightly' },
        { id: 'b', name: 'nightly' },
      ]).client,
      'nightly'
    ),
    /2 jobs are named "nightly" \(a, b\)/
  );
  assert.deepEqual(
    await resolveJob(fakeClient([{ id: 'a', name: 'nightly' }]).client, 'a'),
    { id: 'a', name: 'nightly' }
  );
});

test('trigger errors are reported', async () => {
  const notFound = fakeClient([{ id: 'job-id', name: 'nightly' }], {
    error: { message: 'Not Found' },
    status: 404,
  });
  await assert.rejects(
    runJobsRun(
      { help: false, dryRun: false, name: 'nightly' },
      notFound.client,
      () => {}
    ),
    /R35 or later/
  );
  const failed = fakeClient([{ id: 'job-id', name: 'nightly' }], {
    error: { message: 'Job is disabled' },
    status: 400,
  });
  await assert.rejects(
    runJobsRun(
      { help: false, dryRun: false, name: 'nightly' },
      failed.client,
      () => {}
    ),
    /status 400\): Job is disabled/
  );
});
