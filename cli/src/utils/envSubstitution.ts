const ENV_TOKEN_PATTERN = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

function substituteString(value: string): string {
  return value.replace(ENV_TOKEN_PATTERN, (match, envName: string) => {
    const envValue = process.env[envName];
    return envValue === undefined ? match : envValue;
  });
}

export function substituteEnvTokens<T>(value: T): T {
  if (typeof value === 'string') {
    return substituteString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map(item => substituteEnvTokens(item)) as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      result[substituteString(key)] = substituteEnvTokens(nestedValue);
    }

    return result as T;
  }

  return value;
}
