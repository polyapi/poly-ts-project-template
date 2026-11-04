import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChangedFieldsPayload } from './payloadComparison';

const remote = {
  id: 'remote-id',
  createdAt: '2026-11-01T00:00:00Z',
  tools: [
    { id: 'search-id', extra: 'platform default' },
    { id: 'current-id', extra: 'platform default' },
  ],
};

test('fields the platform adds are not local changes', () => {
  const local = { tools: [{ id: 'search-id' }, { id: 'current-id' }] };
  assert.deepEqual(buildChangedFieldsPayload(local, remote).payload, {});
});

test('removing or clearing array entries is a change, as in Python Flow', () => {
  const removed = { tools: [{ id: 'search-id' }] };
  assert.deepEqual(buildChangedFieldsPayload(removed, remote).payload, removed);
  const cleared = { tools: [] };
  assert.deepEqual(buildChangedFieldsPayload(cleared, remote).payload, cleared);
  const added = {
    tools: [{ id: 'search-id' }, { id: 'current-id' }, { id: 'new-id' }],
  };
  assert.deepEqual(buildChangedFieldsPayload(added, remote).payload, added);
});
