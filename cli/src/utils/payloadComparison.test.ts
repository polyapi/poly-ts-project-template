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

test('a hardcoded JSON value is compared whole, so removed properties update it', () => {
  const remoteTools = {
    toolFunctions: [
      {
        id: 'search-id',
        platformAdded: true,
        argumentConfig: [
          {
            key: 'options',
            source: 'hardcoded',
            value: { units: 'metric', legacy: { flag: true }, extra: 1 },
          },
        ],
      },
    ],
  };
  const removedTop = {
    toolFunctions: [
      {
        id: 'search-id',
        argumentConfig: [
          {
            key: 'options',
            source: 'hardcoded',
            value: { units: 'metric', legacy: { flag: true } },
          },
        ],
      },
    ],
  };
  // The whole changed field is sent, so the deployed value loses the property.
  assert.deepEqual(
    buildChangedFieldsPayload(removedTop, remoteTools).payload,
    removedTop
  );
  const removedNested = structuredClone(removedTop);
  removedNested.toolFunctions[0].argumentConfig[0].value = {
    units: 'metric',
    legacy: {},
    extra: 1,
  } as never;
  assert.deepEqual(
    buildChangedFieldsPayload(removedNested, remoteTools).payload,
    removedNested
  );
  // Equal values, and fields the platform adds outside them, are not changes.
  const same = structuredClone(remoteTools);
  delete (same.toolFunctions[0] as { platformAdded?: boolean }).platformAdded;
  assert.deepEqual(buildChangedFieldsPayload(same, remoteTools).payload, {});
});
