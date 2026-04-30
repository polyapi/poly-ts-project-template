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
