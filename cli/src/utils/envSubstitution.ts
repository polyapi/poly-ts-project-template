const ENV_TOKEN_PATTERN = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
const EXACT_ENV_TOKEN_PATTERN = /^\{\{([A-Z_][A-Z0-9_]*)\}\}$/;

const ROOT_BOOLEAN_ATTRIBUTES = new Set([
  'cachePolyLibrary',
  'clientPromptEnabled',
  'clientPromptRequired',
  'enabled',
  'isPublic',
  'logsEnabled',
  'ohipMaintainOffset',
  'requirePolyApiKey',
  'secret',
  'server',
  'serverSideAsync',
  'waitForResponse',
]);

const NESTED_BOOLEAN_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  arguments: new Set([
    'payload',
    'removeIfNotPresentOnExecute',
    'required',
    'secure',
  ]),
  columns: new Set(['primary', 'required', 'unique']),
  xmlParserOptions: new Set([
    'enabled',
    'explicitArray',
    'explicitRoot',
    'mergeAttrs',
    'normalizeTags',
  ]),
};

function substituteString(value: string): string {
  return value.replace(ENV_TOKEN_PATTERN, (match, envName: string) => {
    const envValue = process.env[envName];
    return envValue === undefined ? match : envValue;
  });
}

function isBooleanAttribute(path: readonly string[]): boolean {
  if (path.length === 1) {
    return ROOT_BOOLEAN_ATTRIBUTES.has(path[0]);
  }

  const attribute = path[path.length - 1];
  const container = path[path.length - 2];
  return Boolean(
    attribute &&
      container &&
      NESTED_BOOLEAN_ATTRIBUTES[container]?.has(attribute)
  );
}

function substituteValue(value: string, path: readonly string[]): unknown {
  const exactToken = value.match(EXACT_ENV_TOKEN_PATTERN);
  const substituted = substituteString(value);

  if (exactToken && isBooleanAttribute(path)) {
    const normalized = substituted.toLowerCase();
    if (normalized === 'true' || substituted === '1') return true;
    if (normalized === 'false' || substituted === '0') return false;
  }

  return substituted;
}

export function substituteEnvTokens<T>(value: T, path: string[] = []): T {
  if (typeof value === 'string') {
    return substituteValue(value, path) as T;
  }

  if (Array.isArray(value)) {
    return value.map(item => substituteEnvTokens(item, path)) as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      const substitutedKey = substituteString(key);
      result[substitutedKey] = substituteEnvTokens(nestedValue, [
        ...path,
        substitutedKey,
      ]);
    }

    return result as T;
  }

  return value;
}
