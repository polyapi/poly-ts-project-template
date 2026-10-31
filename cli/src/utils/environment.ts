import * as fs from 'node:fs';
import path from 'node:path';

const connectionAliases = [
  ['BASE_URL', 'POLY_API_BASE_URL', 'POLYAPI_BASE_URL'],
  ['API_KEY', 'POLY_API_KEY', 'POLYAPI_API_KEY'],
] as const;

/** Normalize each source before merging so aliases respect source priority. */
export function normalizeConnectionSettings(
  source: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const normalized = { ...source };
  for (const names of connectionAliases) {
    const selected = names.find(name => source[name] !== undefined);
    if (selected) {
      for (const name of names) normalized[name] = source[selected];
    }
  }
  return normalized;
}

export function mergeEnvironmentLayers(
  ...sources: NodeJS.ProcessEnv[]
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(
      normalizeConnectionSettings(source)
    )) {
      if (value !== undefined) merged[name] = value;
    }
  }
  return merged;
}

/** Resolve exactly the SDK used by `pnpm workflows exec poly setup`. */
export function resolveWorkflowPolyConfig(
  workspaceRoot: string,
  resolvePackage = (directory: string) =>
    require.resolve('polyapi/package.json', { paths: [directory] }),
  exists = fs.existsSync
): string | null {
  try {
    const pkg = resolvePackage(path.join(workspaceRoot, 'workflows'));
    // Works with flat node_modules and pnpm's real package directory.
    const candidate = path.join(
      path.dirname(path.dirname(pkg)),
      '.poly',
      '.config.env'
    );
    return exists(candidate) ? candidate : null;
  } catch {
    return null;
  }
}
