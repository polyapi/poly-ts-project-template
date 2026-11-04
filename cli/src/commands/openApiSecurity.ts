type ObjectValue = Record<string, unknown>;
interface Scheme {
  type?: string;
  in?: string;
  name?: string;
  scheme?: string;
  $ref?: string;
}
interface SecurityFunction {
  arguments?: ObjectValue[];
  source: {
    method: string;
    url: string;
    auth?: unknown;
    headers?: Header[];
    [key: string]: unknown;
  };
}

interface Header {
  key?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}

function resolveScheme(spec: ObjectValue, input: Scheme): Scheme {
  let scheme = input;
  const seen = new Set<string>();
  while (scheme.$ref !== undefined) {
    const reference = scheme.$ref;
    if (!reference.startsWith('#/'))
      throw new Error('Security scheme references must be local.');
    if (seen.has(reference))
      throw new Error('Cyclic security scheme reference.');
    seen.add(reference);
    let value: unknown = spec;
    for (const segment of reference.slice(2).split('/')) {
      value = object(value)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Unresolved security scheme reference.');
    scheme = value as Scheme;
  }
  return scheme;
}

function headerKey(scheme: Scheme): boolean {
  return scheme.type === 'apiKey' && scheme.in === 'header';
}

function nativeMatches(resource: SecurityFunction, scheme: Scheme): boolean {
  const auth = object(resource.source?.auth);
  if (scheme.type === 'apiKey') {
    const entries = Object.fromEntries(
      ((auth.apikey ?? []) as Header[]).map(entry => [entry.key, entry.value])
    );
    return (
      auth.type === 'apikey' &&
      entries.in === scheme.in &&
      (entries.key ?? '').toLowerCase() === (scheme.name ?? '').toLowerCase()
    );
  }
  if (scheme.type === 'http') return auth.type === scheme.scheme?.toLowerCase();
  if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect')
    return auth.type === 'bearer' || auth.type === 'oauth2';
  return scheme.type === 'basic' && auth.type === 'basic';
}

function hasHeader(resource: SecurityFunction, scheme: Scheme): boolean {
  return (
    nativeMatches(resource, scheme) ||
    ((resource.source.headers ?? []) as Header[]).some(
      header =>
        (header.key ?? header.name ?? '').toLowerCase() ===
          scheme.name?.toLowerCase() &&
        header.disabled !== true &&
        Boolean(header.value)
    )
  );
}

function normalizePath(value: string, generated = false): string {
  if (generated)
    return value
      .split('?')[0]
      .replace(/^\{\{hostUrl\}\}/, '')
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/\{\{[^{}]+\}\}/g, '{}')
      .replace(/(?: |%20)+$/, '');
  return value.replace(/ +$/, '').replace(/\{[^{}]+\}/g, '{}');
}

function requirements(
  resource: SecurityFunction,
  spec: ObjectValue
): ObjectValue[] | undefined {
  const source = resource.source;
  const url = normalizePath(source.url, true);
  const matches: { length: number; security: unknown }[] = [];
  for (const [route, item] of Object.entries(object(spec.paths))) {
    const operation = object(item)[source.method.toLowerCase()];
    if (!operation) continue;
    const candidate = normalizePath(route);
    if (url.endsWith(candidate))
      matches.push({
        length: candidate.length,
        security:
          Object.getOwnPropertyDescriptor(object(operation), 'security') !==
          undefined
            ? object(operation).security
            : spec.security,
      });
  }
  if (!matches.length)
    throw new Error('Cannot match generated function to an OpenAPI operation.');
  const longest = Math.max(...matches.map(match => match.length));
  const selected = matches
    .filter(match => match.length === longest)
    .map(match => match.security);
  // Object-key order does not distinguish equivalent security declarations.
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, child) =>
      child && typeof child === 'object' && !Array.isArray(child)
        ? Object.fromEntries(
            Object.entries(child).sort(([a], [b]) => a.localeCompare(b))
          )
        : child
    ) ?? 'undefined';
  if (new Set(selected.map(canonical)).size !== 1)
    throw new Error('Ambiguous OpenAPI operation security.');
  if (selected[0] === undefined) return undefined;
  if (!Array.isArray(selected[0]))
    throw new Error('Invalid OpenAPI security requirements.');
  return selected[0] as ObjectValue[];
}

function argumentName(header: string): string {
  const words = header.toLowerCase().match(/[a-z0-9]+/g) ?? ['apiKey'];
  let name =
    words[0] +
    words
      .slice(1)
      .map(word => word[0].toUpperCase() + word.slice(1))
      .join('');
  const reserved = new Set([
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'nonlocal',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'try',
    'while',
    'with',
    'yield',
    'default',
    'new',
    'delete',
    'function',
    'switch',
    'case',
    'var',
    'let',
    'const',
    'catch',
    'debugger',
    'do',
    'this',
    'eval',
    'arguments',
    'execute',
    'dict',
    'constructor',
    'prototype',
    'enum',
    'export',
    'extends',
    'false',
    'true',
    'null',
    'super',
    'throw',
    'typeof',
    'void',
    'instanceof',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
    'static',
  ]);
  if (/^[0-9]/.test(name) || reserved.has(name))
    name = `header${name[0].toUpperCase()}${name.slice(1)}`;
  return name;
}

function restoreHeader(resource: SecurityFunction, scheme: Scheme): void {
  if (hasHeader(resource, scheme)) return;
  if (!scheme.name) throw new Error('Header API-key scheme needs a name.');
  resource.arguments ??= [];
  const args = resource.arguments as ObjectValue[];
  const source = resource.source;
  const base = argumentName(scheme.name);
  const sourceText = JSON.stringify(source);
  const unused = args.find(
    arg =>
      arg.name === base &&
      arg.type === 'string' &&
      !sourceText.includes(`{{${base}}}`)
  );
  let name = base;
  if (unused)
    Object.assign(unused, {
      required: true,
      removeIfNotPresentOnExecute: false,
    });
  else {
    const names = new Set(args.map(arg => arg.name));
    for (let suffix = 2; names.has(name); suffix++) name = `${base}${suffix}`;
    args.push({
      name,
      type: 'string',
      required: true,
      removeIfNotPresentOnExecute: false,
      description: `API key for the ${scheme.name} request header.`,
    });
  }
  // Generated Python/TypeScript signatures require required parameters first.
  args.sort(
    (a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required))
  );
  source.headers = [
    ...((source.headers ?? []) as Header[]).filter(
      header =>
        (header.key ?? header.name ?? '').toLowerCase() !==
        scheme.name?.toLowerCase()
    ),
    { key: scheme.name, value: `{{${name}}}` },
  ];
}

/** Restore only header keys from one effective security alternative; retain translated auth. */
export function reconcileSecurity<Model>(
  model: Model,
  spec: ObjectValue
): Model {
  const definitions = object(
    object(spec.components).securitySchemes ?? spec.securityDefinitions
  );
  const schemes = Object.fromEntries(
    Object.entries(definitions).map(([name, value]) => [
      name,
      resolveScheme(spec, object(value) as Scheme),
    ])
  );
  const result = structuredClone(model);
  if (!Object.values(schemes).some(headerKey)) return result;
  const resources = object(result).functions ?? [];
  if (!Array.isArray(resources)) throw new Error('Invalid model functions.');
  for (const item of resources) {
    const source = object(object(item).source);
    if (typeof source.method !== 'string' || typeof source.url !== 'string')
      throw new Error('Invalid generated function source.');
    const resource = item as SecurityFunction;
    const security = requirements(resource, spec);
    if (security === undefined) continue;
    const alternatives = security.map((requirement, index) => {
      const required = Object.keys(requirement).map(name => {
        if (!Object.getOwnPropertyDescriptor(schemes, name))
          throw new Error('Undefined OpenAPI security scheme.');
        return schemes[name];
      });
      const represented = required.filter(
        scheme =>
          nativeMatches(resource, scheme) ||
          (headerKey(scheme) && hasHeader(resource, scheme))
      ).length;
      return {
        required,
        represented,
        missing: required.length - represented,
        index,
      };
    });
    alternatives.sort(
      (a, b) =>
        b.represented - a.represented ||
        a.missing - b.missing ||
        a.index - b.index
    );
    const required = alternatives[0]?.required ?? [];
    if (!required.length) resource.source.auth = { type: 'noauth' };
    for (const scheme of required)
      if (headerKey(scheme)) restoreHeader(resource, scheme);
  }
  return result;
}
