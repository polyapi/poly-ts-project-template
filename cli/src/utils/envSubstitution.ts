import type { TSchema } from '@sinclair/typebox';

const ENV_TOKEN_PATTERN = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
const EXACT_ENV_TOKEN_PATTERN = /^\{\{([A-Z_][A-Z0-9_]*)\}\}$/;
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

type ScalarSchemaFamily = 'boolean' | 'integer' | 'null' | 'number' | 'other';
type ScalarCoercionTarget = 'boolean' | 'integer' | 'number';

function isSchema(value: unknown): value is TSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Reflect.apply(Object.prototype.hasOwnProperty, value, [key]);
}

function getSchemaBranches(schema: TSchema): TSchema[] | undefined {
  if (!Array.isArray(schema.anyOf)) {
    return undefined;
  }

  const branches = schema.anyOf.filter(isSchema);
  return branches.length === schema.anyOf.length ? branches : undefined;
}

function getScalarSchemaFamilies(schema: TSchema): Set<ScalarSchemaFamily> {
  const branches = getSchemaBranches(schema);
  if (branches) {
    const families = new Set<ScalarSchemaFamily>();
    for (const branch of branches) {
      for (const family of getScalarSchemaFamilies(branch)) {
        families.add(family);
      }
    }
    return families;
  }

  switch (schema.type) {
    case 'boolean':
      return new Set(['boolean']);
    case 'integer':
      return new Set(['integer']);
    case 'null':
      return new Set(['null']);
    case 'number':
      return new Set(['number']);
    default:
      return new Set(['other']);
  }
}

function getScalarCoercionTarget(
  schema: TSchema | undefined
): ScalarCoercionTarget | undefined {
  if (!schema) {
    return undefined;
  }

  const families = [...getScalarSchemaFamilies(schema)].filter(
    family => family !== 'null'
  );

  if (families.length === 1 && families[0] === 'boolean') {
    return 'boolean';
  }

  if (
    families.length > 0 &&
    families.every(family => family === 'integer' || family === 'number')
  ) {
    return families.every(family => family === 'integer')
      ? 'integer'
      : 'number';
  }

  return undefined;
}

function substituteString(value: string): string {
  return value.replace(ENV_TOKEN_PATTERN, (match, envName: string) => {
    const envValue = process.env[envName];
    return envValue === undefined ? match : envValue;
  });
}

function substituteScalarString(
  value: string,
  schema: TSchema | undefined
): string | number | boolean {
  const tokenMatch = value.match(EXACT_ENV_TOKEN_PATTERN);
  if (!tokenMatch) {
    return substituteString(value);
  }

  const envValue = process.env[tokenMatch[1]];
  if (envValue === undefined) {
    return value;
  }

  const target = getScalarCoercionTarget(schema);
  if (target === 'boolean') {
    if (envValue === 'true') {
      return true;
    }
    if (envValue === 'false') {
      return false;
    }
    return envValue;
  }

  if (target === 'number' || target === 'integer') {
    if (!JSON_NUMBER_PATTERN.test(envValue)) {
      return envValue;
    }

    const numericValue = Number(envValue);
    if (!Number.isFinite(numericValue)) {
      return envValue;
    }
    if (target === 'integer' && !Number.isInteger(numericValue)) {
      return envValue;
    }
    return numericValue;
  }

  return envValue;
}

function literalPropertyMatches(
  propertySchema: TSchema,
  value: unknown
): boolean {
  if (!hasOwn(propertySchema, 'const')) {
    return true;
  }

  const substitutedValue =
    typeof value === 'string' ? substituteString(value) : value;
  return substitutedValue === propertySchema.const;
}

function objectMatchesSchemaShape(
  schema: TSchema,
  value: Record<string, unknown>
): boolean {
  if (schema.type !== 'object') {
    return false;
  }

  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {};

  if (
    Array.isArray(schema.required) &&
    schema.required.some(
      (key: unknown) => typeof key !== 'string' || !hasOwn(value, key)
    )
  ) {
    return false;
  }

  if (
    schema.additionalProperties === false &&
    Object.keys(value).some(key => !hasOwn(properties, key))
  ) {
    return false;
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (
      hasOwn(value, key) &&
      isSchema(propertySchema) &&
      !literalPropertyMatches(propertySchema, value[key])
    ) {
      return false;
    }
  }

  return true;
}

function resolveContainerSchema(
  schema: TSchema | undefined,
  value: unknown[] | Record<string, unknown>
): TSchema | undefined {
  if (!schema) {
    return undefined;
  }

  const branches = getSchemaBranches(schema);
  if (!branches) {
    return schema;
  }

  const matches = Array.isArray(value)
    ? branches.filter(branch => branch.type === 'array')
    : branches.filter(branch => objectMatchesSchemaShape(branch, value));

  return matches.length === 1 ? matches[0] : undefined;
}

function getObjectPropertySchema(
  schema: TSchema | undefined,
  key: string
): TSchema | undefined {
  if (!schema || schema.type !== 'object') {
    return undefined;
  }

  if (
    schema.properties &&
    typeof schema.properties === 'object' &&
    hasOwn(schema.properties, key) &&
    isSchema(schema.properties[key])
  ) {
    return schema.properties[key] as TSchema;
  }

  if (
    schema.patternProperties &&
    typeof schema.patternProperties === 'object'
  ) {
    for (const [pattern, patternSchema] of Object.entries(
      schema.patternProperties
    )) {
      if (!isSchema(patternSchema)) {
        continue;
      }

      try {
        if (new RegExp(pattern).test(key)) {
          return patternSchema;
        }
      } catch {
        // Invalid schema patterns cannot safely identify a property schema.
      }
    }
  }

  return isSchema(schema.additionalProperties)
    ? schema.additionalProperties
    : undefined;
}

function getArrayItemSchema(
  schema: TSchema | undefined,
  index: number
): TSchema | undefined {
  if (!schema || schema.type !== 'array') {
    return undefined;
  }

  if (Array.isArray(schema.prefixItems)) {
    const prefixSchema = schema.prefixItems[index];
    if (isSchema(prefixSchema)) {
      return prefixSchema;
    }
  }

  return isSchema(schema.items) ? schema.items : undefined;
}

function substituteEnvTokensWithSchema(
  value: unknown,
  schema: TSchema | undefined
): unknown {
  if (typeof value === 'string') {
    return substituteScalarString(value, schema);
  }

  if (Array.isArray(value)) {
    const resolvedSchema = resolveContainerSchema(schema, value);
    return value.map((item, index) =>
      substituteEnvTokensWithSchema(
        item,
        getArrayItemSchema(resolvedSchema, index)
      )
    );
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const resolvedSchema = resolveContainerSchema(schema, record);
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(record)) {
      const substitutedKey = substituteString(key);
      result[substitutedKey] = substituteEnvTokensWithSchema(
        nestedValue,
        getObjectPropertySchema(resolvedSchema, substitutedKey)
      );
    }

    return result;
  }

  return value;
}

/**
 * Substitute environment tokens recursively. Exact tokens are converted only
 * when the schema permits a single boolean or numeric family (plus null).
 */
export function substituteEnvTokens<T>(value: T, schema?: TSchema): T {
  return substituteEnvTokensWithSchema(value, schema) as T;
}
