import { readFileSync } from 'node:fs';

/**
 * PolyAPI R35 tracks the functions a server function calls dynamically only
 * when it was deployed with the TypeScript client `polyapi` 0.28.1 or later.
 */
export const MIN_DYNAMIC_TRACKING_POLYAPI_VERSION = '0.28.1';

/** Compares `major.minor.patch` versions; prerelease suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The installed workflow SDK version, or null when it cannot be read. */
export function readInstalledPolyapiVersion(
  searchPaths: string[]
): string | null {
  try {
    const packageJsonPath = require.resolve('polyapi/package.json', {
      paths: searchPaths,
    });
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * A warning for an installed SDK too old for dynamic dependency tracking, or
 * null when it is new enough or unknown (other checks report a missing SDK).
 */
export function getPolyapiVersionWarning(
  installedVersion: string | null
): string | null {
  if (
    !installedVersion ||
    compareVersions(installedVersion, MIN_DYNAMIC_TRACKING_POLYAPI_VERSION) >= 0
  ) {
    return null;
  }
  return `The workflows package uses polyapi ${installedVersion}. PolyAPI tracks the functions a server function calls dynamically only for functions deployed with polyapi ${MIN_DYNAMIC_TRACKING_POLYAPI_VERSION} or later. Update it with \`pnpm --filter workflows add polyapi@<instance-tag>\` (see docs/SETUP.md) and redeploy affected server functions.`;
}
