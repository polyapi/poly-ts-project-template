export function canonicalizeComparisonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeComparisonValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [
          key,
          canonicalizeComparisonValue(nestedValue),
        ])
    );
  }

  return value;
}

export function areComparisonPayloadsEqual(
  left: unknown,
  right: unknown
): boolean {
  return (
    JSON.stringify(canonicalizeComparisonValue(left)) ===
    JSON.stringify(canonicalizeComparisonValue(right))
  );
}

/**
 * Shape a remote value like its local counterpart so fields the API adds
 * (IDs, timestamps, defaults) do not register as local changes.
 */
export function projectRemoteValue(local: unknown, remote: unknown): unknown {
  if (Array.isArray(local)) {
    // Keep length changes visible, as Python Flow does: removing a tool or an
    // argument binding must cause an update.
    if (!Array.isArray(remote) || remote.length !== local.length) {
      return remote;
    }
    return local.map((item, index) => projectRemoteValue(item, remote[index]));
  }

  if (local && typeof local === 'object') {
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
      return remote;
    }
    const localRecord = local as Record<string, unknown>;
    const remoteRecord = remote as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(localRecord).map(([key, value]) => [
        key,
        // A hardcoded binding's value is the user's own data, compared whole:
        // projecting it would hide properties removed from a JSON value.
        key === 'value' && localRecord.source === 'hardcoded'
          ? remoteRecord[key]
          : projectRemoteValue(value, remoteRecord[key]),
      ])
    );
  }

  return remote;
}

/**
 * Build a PATCH body containing only the local fields that differ remotely.
 * Changed create-only fields are reported instead of being patched.
 */
export function buildChangedFieldsPayload(
  localPayload: Record<string, unknown>,
  remote: Record<string, unknown>,
  createOnlyFields: ReadonlySet<string> = new Set()
): { payload: Record<string, unknown>; immutableChanges: string[] } {
  const payload: Record<string, unknown> = {};
  const immutableChanges: string[] = [];

  for (const [key, localValue] of Object.entries(localPayload)) {
    if (
      areComparisonPayloadsEqual(
        localValue,
        projectRemoteValue(localValue, remote[key])
      )
    ) {
      continue;
    }

    if (createOnlyFields.has(key)) {
      immutableChanges.push(key);
      continue;
    }

    payload[key] = localValue;
  }

  return { payload, immutableChanges };
}
