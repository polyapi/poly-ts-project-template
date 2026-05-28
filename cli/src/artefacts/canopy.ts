import type { CanopyFile } from '../types';
import type { ArtifactSummary } from '../types/summary';
import { getBaseUrl } from '../utils/apiClient';
import {
  getSrcPath,
  readJsonFile,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import { chalk, createHeader, createLogger } from '../utils/logger';

type FindCanopyFileOptions = WalkDirOptions;

type ApplicationRecord = {
  id?: string;
  name?: string;
  subpath?: string;
};

type CanopySyncOptions = {
  dryRun?: boolean;
  force?: boolean;
};

const log = createLogger('canopy');

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeJson(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    return Object.fromEntries(
      entries.map(([key, item]) => [key, normalizeJson(item)])
    );
  }

  return value;
}

function payloadEquals(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right))
  );
}

function projectRemoteToLocalShape(
  localValue: unknown,
  remoteValue: unknown
): unknown {
  if (Array.isArray(localValue)) {
    if (!Array.isArray(remoteValue)) {
      return remoteValue;
    }

    return localValue.map((localItem, index) =>
      projectRemoteToLocalShape(localItem, remoteValue[index])
    );
  }

  if (
    localValue &&
    typeof localValue === 'object' &&
    !Array.isArray(localValue)
  ) {
    if (!remoteValue || typeof remoteValue !== 'object') {
      return remoteValue;
    }

    const localRecord = localValue as Record<string, unknown>;
    const remoteRecord = remoteValue as Record<string, unknown>;
    const projected: Record<string, unknown> = {};

    for (const key of Object.keys(localRecord)) {
      projected[key] = projectRemoteToLocalShape(
        localRecord[key],
        remoteRecord[key]
      );
    }

    return projected;
  }

  return remoteValue;
}

function buildAuthHeaders(): Record<string, string> {
  const apiKey = process.env.API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('API_KEY is required to synchronize Canopy artifacts.');
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function getCanopyOverrideMap(): Map<string, string> {
  const raw = process.env.CANOPY_APP_IDS?.trim();
  const map = new Map<string, string>();

  if (!raw) {
    return map;
  }

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof key === 'string' && typeof value === 'string') {
          map.set(key.trim(), value.trim());
        }
      }
      return map;
    } catch (error) {
      throw new Error(
        `Invalid CANOPY_APP_IDS JSON value: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  for (const pair of raw.split(',')) {
    const [subpath, id] = pair.split('=').map(item => item?.trim());
    if (subpath && id) {
      map.set(subpath, id);
    }
  }
  return map;
}

async function fetchJson(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const url = `${getBaseUrl().replace(/\/+$/, '')}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...buildAuthHeaders(),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = text;
  }

  return {
    status: response.status,
    data,
  };
}

async function listApplications(): Promise<ApplicationRecord[]> {
  const primary = await fetchJson('/applications', { method: 'GET' });
  if (
    primary.status >= 200 &&
    primary.status < 300 &&
    Array.isArray(primary.data)
  ) {
    return primary.data as ApplicationRecord[];
  }

  const fallback = await fetchJson('/applications?limit=1000', {
    method: 'GET',
  });
  if (
    fallback.status >= 200 &&
    fallback.status < 300 &&
    Array.isArray(fallback.data)
  ) {
    return fallback.data as ApplicationRecord[];
  }

  throw new Error(
    `Failed to fetch applications. Status ${primary.status}${fallback.status !== primary.status ? `/${fallback.status}` : ''}.`
  );
}

function selectApplicationId(
  canopy: CanopyFile,
  applications: ApplicationRecord[],
  overrides: Map<string, string>
): string {
  const subpath = canopy.content.subpath?.trim();
  const name = canopy.content.name?.trim();
  const inlineId = canopy.content.id?.trim();

  if (subpath && overrides.has(subpath)) {
    const overrideId = overrides.get(subpath);
    if (overrideId) {
      return overrideId;
    }
  }

  if (inlineId) {
    return inlineId;
  }

  if (subpath) {
    const bySubpath = applications.find(
      app => app.subpath?.trim() === subpath && typeof app.id === 'string'
    );
    if (bySubpath?.id) {
      return bySubpath.id;
    }
  }

  if (name) {
    const byName = applications.find(
      app => app.name?.trim() === name && typeof app.id === 'string'
    );
    if (byName?.id) {
      return byName.id;
    }
  }

  throw new Error(
    `Unable to resolve Canopy application id for "${canopy.fileName}"${subpath ? ` (subpath "${subpath}")` : ''}. Set CANOPY_APP_IDS, for example CANOPY_APP_IDS="${subpath || 'example-app'}=<application-id>".`
  );
}

export function findCanopyFiles(
  options: FindCanopyFileOptions = {}
): CanopyFile[] {
  const canopyFiles: CanopyFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        fullPath.includes('/artefacts/') &&
        fullPath.includes('/canopy/')
      ) {
        const content = readJsonFile<CanopyFile['content']>(fullPath);
        if (!content) {
          return;
        }
        canopyFiles.push({
          filePath: fullPath,
          fileName: file,
          content,
        });
      }
    },
    options
  );

  return canopyFiles;
}

export async function syncCanopy(
  summary: ArtifactSummary,
  options: CanopySyncOptions = {},
  files?: CanopyFile[]
): Promise<void> {
  log.info(chalk.cyan(createHeader('CANOPY')));

  const canopyFiles = files ?? findCanopyFiles();
  if (canopyFiles.length === 0) {
    log.warn('No canopy JSON files found in src/**/artefacts/canopy/');
    return;
  }

  log.info(chalk.gray(`Found ${canopyFiles.length} local canopy file(s)`));

  const applications = await listApplications();
  const appOverrides = getCanopyOverrideMap();
  log.info(
    chalk.gray(`Fetched ${applications.length} application(s) from API`)
  );

  for (const canopy of canopyFiles) {
    const name = canopy.content.name || canopy.fileName;
    const subpath = canopy.content.subpath || '(no subpath)';

    try {
      const appId = selectApplicationId(canopy, applications, appOverrides);
      log.info(`  → ${name} (${subpath})`);

      const remoteConfigResponse = await fetchJson(
        `/applications/${encodeURIComponent(appId)}/config`,
        { method: 'GET' }
      );

      if (
        remoteConfigResponse.status < 200 ||
        remoteConfigResponse.status >= 300
      ) {
        summary.failed++;
        log.info(
          chalk.red(
            `    [FAIL] Failed to fetch remote config (status ${remoteConfigResponse.status})`
          )
        );
        continue;
      }

      const comparableRemoteConfig = projectRemoteToLocalShape(
        canopy.content,
        remoteConfigResponse.data
      );

      if (!options.force && payloadEquals(comparableRemoteConfig, canopy.content)) {
        summary.skipped++;
        log.info(chalk.gray('    [SKIP] Unchanged'));
        continue;
      }

      if (options.dryRun) {
        summary.planned++;
        log.info(chalk.blue('    [PLAN] Would update'));
        continue;
      }

      const putResponse = await fetchJson(
        `/applications/${encodeURIComponent(appId)}/config`,
        {
          method: 'PUT',
          body: JSON.stringify(canopy.content),
        }
      );

      if (putResponse.status >= 200 && putResponse.status < 300) {
        summary.updated++;
        log.info(chalk.green('    [OK] Updated'));
      } else {
        summary.failed++;
        log.info(
          chalk.red(
            `    [FAIL] Failed to update (status ${putResponse.status})`
          )
        );
      }
    } catch (error) {
      summary.failed++;
      log.error(
        { error, filePath: canopy.filePath },
        `Failed to sync canopy app "${name}"`
      );
      log.info(chalk.red('    [FAIL] Error'));
    }
  }
}
