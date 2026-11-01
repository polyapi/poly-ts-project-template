type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Adapt OpenAPI schema identifiers to PolyAPI without changing status codes or examples. */
export function normalizeOpenApiSchemaNames(document: JsonObject): {
  document: JsonObject;
  renames: string[];
} {
  const normalized: JsonObject = JSON.parse(JSON.stringify(document));
  const groups = [
    {
      container: isObject(normalized.components) ? normalized.components : {},
      key: 'schemas',
      prefix: '#/components/schemas/',
    },
    { container: normalized, key: 'definitions', prefix: '#/definitions/' },
  ];
  const mappings = new Map<string, Map<string, string>>();
  const renames: string[] = [];
  for (const { container, key, prefix } of groups) {
    const schemas = container[key];
    if (!isObject(schemas)) continue;
    const used = new Set(Object.keys(schemas));
    const names = new Map<string, string>();
    const replaced: JsonObject = {};
    for (const [name, schema] of Object.entries(schemas)) {
      let valid = name;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        let base = name.replace(/[^A-Za-z0-9_]/g, '_') || 'Schema';
        if (!/^[A-Za-z_]/.test(base) || !/[A-Za-z0-9]/.test(base))
          base = `Schema${base}`;
        valid = base;
        for (let suffix = 2; used.has(valid); suffix += 1)
          valid = `${base}_${suffix}`;
        used.add(valid);
        names.set(name, valid);
        renames.push(`${name} -> ${valid}`);
      }
      replaced[valid] = schema;
    }
    container[key] = replaced;
    mappings.set(prefix, names);
  }
  const rewriteRef = (ref: string): string => {
    for (const [prefix, names] of mappings) {
      if (!ref.startsWith(prefix)) continue;
      const [segment, ...remaining] = ref.slice(prefix.length).split('/');
      let original: string;
      try {
        original = decodeURIComponent(segment)
          .replace(/~1/g, '/')
          .replace(/~0/g, '~');
      } catch {
        return ref;
      }
      const renamed = names.get(original);
      if (renamed)
        return `${prefix}${renamed}${remaining.length ? `/${remaining.join('/')}` : ''}`;
    }
    return ref;
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isObject(value)) {
      if (typeof value.$ref === 'string') value.$ref = rewriteRef(value.$ref);
      const discriminator = value.discriminator;
      if (isObject(discriminator) && isObject(discriminator.mapping)) {
        for (const [key, target] of Object.entries(discriminator.mapping)) {
          if (typeof target !== 'string') continue;
          const shortName = [...mappings.values()]
            .map(names => names.get(target))
            .find(Boolean);
          discriminator.mapping[key] = shortName ?? rewriteRef(target);
        }
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(normalized);
  return { document: normalized, renames };
}
