import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeJobIntervalProblem,
  parseJobIntervalToSeconds,
} from '../utils/jobInterval';
import {
  ValidationFailedError,
  validateJobArtifact,
} from '../utils/validation';
import { isJobUnchanged, normalizeJobComparisonPayload } from './jobs';

const job = (value: unknown) => ({
  name: 'poller',
  schedule: { type: 'interval', value },
  executionType: 'sequential',
  enabled: true,
  functions: [{ functionName: 'poll', functionContext: 'example.jobs' }],
});

const remoteJob = (value: unknown) => ({
  id: 'job-id',
  name: 'poller',
  schedule: { type: 'interval', value },
  executionType: 'sequential',
  enabled: true,
  functions: [{ id: 'fn-id' }],
});

const localPayload = (value: unknown) => ({
  name: 'poller',
  schedule: { type: 'interval', value },
  executionType: 'sequential',
  enabled: true,
  functions: [
    { id: 'fn-id', eventPayload: {}, headersPayload: {}, paramsPayload: {} },
  ],
});

test('interval values parse like the PolyAPI R35 parser', () => {
  assert.equal(parseJobIntervalToSeconds(5), 300);
  assert.equal(parseJobIntervalToSeconds('5'), 300);
  assert.equal(parseJobIntervalToSeconds('10s'), 10);
  assert.equal(parseJobIntervalToSeconds('90 s'), 90);
  assert.equal(parseJobIntervalToSeconds('2H'), 7200);
  assert.equal(parseJobIntervalToSeconds(1.5), null);
  assert.equal(parseJobIntervalToSeconds('10d'), null);
  assert.equal(parseJobIntervalToSeconds('0s'), null);
});

test('intervals under 10 seconds are rejected with a clear message', () => {
  assert.match(
    describeJobIntervalProblem('5s') ?? '',
    /5 seconds; PolyAPI jobs cannot repeat more often than every 10 seconds/
  );
  assert.equal(describeJobIntervalProblem('10s'), null);
  assert.equal(describeJobIntervalProblem(1), null);
});

test('job artefacts accept numbers, numeric strings and durations', () => {
  for (const value of [1, '15', '30s', '5m', '2h', '45 m']) {
    assert.equal(validateJobArtifact(job(value), 'poller.json', true), true);
  }
});

test('job artefacts reject malformed and too-short intervals', () => {
  assert.equal(validateJobArtifact(job('5x'), 'poller.json', true), false);
  assert.equal(validateJobArtifact(job(1.5), 'poller.json', true), false);
  assert.equal(validateJobArtifact(job('9s'), 'poller.json', true), false);
  assert.throws(
    () => validateJobArtifact(job('9s'), 'poller.json', false),
    (error: unknown) =>
      error instanceof ValidationFailedError &&
      error.errors[0].path === '/schedule/value' &&
      /every 10 seconds/.test(error.errors[0].message)
  );
});

test('equivalent interval spellings do not register as drift', () => {
  assert.equal(isJobUnchanged(localPayload('60s'), remoteJob(1)), true);
  assert.equal(isJobUnchanged(localPayload('1m'), remoteJob(1)), true);
  assert.equal(isJobUnchanged(localPayload('1'), remoteJob(1)), true);
  assert.equal(isJobUnchanged(localPayload('90s'), remoteJob('90s')), true);
  assert.equal(isJobUnchanged(localPayload('2h'), remoteJob(120)), true);
  assert.equal(isJobUnchanged(localPayload('30s'), remoteJob(1)), false);
  assert.equal(isJobUnchanged(localPayload(2), remoteJob(1)), false);
});

test('non-interval schedules are compared unchanged', () => {
  const payload = { schedule: { type: 'periodical', value: '*/5 * * * *' } };
  assert.deepEqual(normalizeJobComparisonPayload(payload), payload);
});
