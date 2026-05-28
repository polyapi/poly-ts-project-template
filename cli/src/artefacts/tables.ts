import type createClient from 'openapi-fetch';
import type { components, paths } from '../sdk/schema';
import type { TableFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import {
  getSrcPath,
  readJsonFile,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import { chalk, createHeader, createLogger } from '../utils/logger';
import { getRequiredNamespace, validateNamespace } from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { areComparisonPayloadsEqual } from '../utils/payloadComparison';
import { validateTableArtifact } from '../utils/validation';

type TableResponseDto = components['schemas']['TableResponseDto'];
type PaginationDto = components['schemas']['PaginationDto'];

// The GET /tables response is paginated: { results: TableResponseDto[], pagination: PaginationDto }
type TableListResponse = {
  results: TableResponseDto[];
  pagination: PaginationDto;
};

const log = createLogger('tables');
type FindTableFileOptions = WalkDirOptions;

/**
 * Find all table JSON files in the project (artefacts/tabi/*.json)
 */
export function findTableFiles(
  options: FindTableFileOptions = {}
): TableFile[] {
  const tableFiles: TableFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        fullPath.includes('/tabi/') &&
        fullPath.includes('/artefacts/')
      ) {
        const content = readJsonFile(fullPath);
        if (content) {
          tableFiles.push({
            filePath: fullPath,
            fileName: file,
            content,
          });
        }
      }
    },
    options
  );

  return tableFiles;
}

/**
 * Get all existing tables from the API, following pagination to collect all results
 */
export async function getExistingTables(
  client: ReturnType<typeof createClient<paths>>
): Promise<TableResponseDto[]> {
  const allTables: TableResponseDto[] = [];

  try {
    // Fetch first page
    const { data, error } = await client.GET('/tables', {});

    if (error || !data) {
      return [];
    }

    const response = data as unknown as TableListResponse;
    if (!response.results || !Array.isArray(response.results)) {
      log.warn(
        { data },
        'Unexpected GET /tables response shape — returning empty list'
      );
      return [];
    }

    allTables.push(...response.results);

    // Follow pagination to fetch remaining pages
    if (
      response.pagination &&
      response.pagination.page < response.pagination.pages
    ) {
      let currentPage = response.pagination.page + 1;
      while (currentPage <= response.pagination.pages) {
        const { data: pageData, error: pageError } = await client.GET(
          '/tables',
          {
            params: { query: { page: currentPage } },
          }
        );

        if (pageError || !pageData) {
          log.warn(
            { page: currentPage, error: pageError },
            'Failed to fetch table page from API'
          );
          break;
        }

        const pageResponse = pageData as unknown as TableListResponse;
        if (pageResponse.results && Array.isArray(pageResponse.results)) {
          allTables.push(...pageResponse.results);
          currentPage++;
        } else {
          log.warn(
            { page: currentPage },
            'Unexpected pagination response shape'
          );
          break;
        }

        await sleep(300);
      }
    }

    return allTables;
  } catch (error) {
    log.warn({ error }, 'Failed to fetch tables from API');
    return [];
  }
}

/**
 * Check if a table already exists
 */
function tableExists(
  name: string,
  context: string | null | undefined,
  existingTables: TableResponseDto[]
): boolean {
  return existingTables.some(
    table => table.name === name && table.context === context
  );
}

/**
 * Delete a table by ID
 */
async function deleteTable(
  client: ReturnType<typeof createClient<paths>>,
  tableId: string,
  name: string,
  context: string | null | undefined
): Promise<boolean> {
  try {
    const { error, response } = await client.DELETE('/tables/{id}', {
      params: { path: { id: tableId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      log.error(
        { name, context, status: (response as any)?.status, error },
        'Failed to delete table'
      );
      return false;
    }

    log.info({ name, context }, 'Table deleted');
    return true;
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting table');
    return false;
  }
}

/**
 * POST or PATCH a table to the API
 */
function buildTablePayload(table: TableFile): TableFile['content'] {
  return { ...table.content };
}

async function getExistingTableDetails(
  client: ReturnType<typeof createClient<paths>>,
  tableId: string
): Promise<TableResponseDto | null> {
  try {
    const { data, error, response } = await client.GET('/tables/{id}', {
      params: { path: { id: tableId } },
    });

    if (error || !data) {
      log.warn(
        { tableId, status: (response as any)?.status },
        'Failed to fetch table details'
      );
      return null;
    }

    return data as TableResponseDto;
  } catch (error) {
    log.warn({ error, tableId }, 'Error fetching table details');
    return null;
  }
}

function buildRemoteTableColumns(
  localColumns: TableFile['content']['columns'],
  remoteColumns: TableResponseDto['columns']
): Record<string, unknown>[] {
  const remoteColumnList = remoteColumns as Array<{ name?: string }>;

  return localColumns.flatMap(localColumn => {
    const remoteColumn = remoteColumnList.find(
      column => column.name === localColumn.name
    );
    if (!remoteColumn) {
      return [];
    }

    return [
      Object.fromEntries(
        Object.keys(localColumn).map(key => [
          key,
          (remoteColumn as Record<string, unknown>)[key],
        ])
      ),
    ];
  });
}

function buildRemoteTablePayload(
  localPayload: TableFile['content'],
  remoteTable: TableResponseDto
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: remoteTable.name,
  };

  if (localPayload.context !== undefined) {
    payload.context = remoteTable.context ?? null;
  }
  if (localPayload.description !== undefined) {
    payload.description = remoteTable.description ?? null;
  }
  if (localPayload.ownerUserId !== undefined) {
    payload.ownerUserId = remoteTable.ownerUserId ?? null;
  }
  if (localPayload.visibility !== undefined) {
    payload.visibility = remoteTable.visibility;
  }
  if (localPayload.columns !== undefined) {
    payload.columns = buildRemoteTableColumns(
      localPayload.columns,
      remoteTable.columns
    );
  }

  return payload;
}

async function postTable(
  client: ReturnType<typeof createClient<paths>>,
  table: TableFile,
  existingTables: TableResponseDto[],
  dryRun: boolean = false,
  force: boolean = false
): Promise<'created' | 'updated' | 'noop' | 'failed'> {
  try {
    const tableName = table.content.name;
    const tableContext = table.content.context ?? null;

    const payload = buildTablePayload(table);

    const exists = tableExists(tableName, tableContext, existingTables);

    if (exists) {
      const existingTable = existingTables.find(
        t => t.name === tableName && t.context === tableContext
      );

      if (!existingTable) {
        log.error(
          { name: tableName, context: tableContext },
          'Table exists but not found in list'
        );
        return 'failed';
      }

      const existingTableDetails = await getExistingTableDetails(
        client,
        existingTable.id
      );
      if (
        !force &&
        existingTableDetails &&
        areComparisonPayloadsEqual(
          payload,
          buildRemoteTablePayload(payload, existingTableDetails)
        )
      ) {
        return 'noop';
      }

      if (dryRun) {
        return 'updated';
      }

      if (
        !validateEndpointPayload('UpdateTableDto', payload, {
          artifactType: 'Table',
          artifactName: tableName,
          filePath: table.filePath,
        })
      ) {
        return 'failed';
      }

      const { error, response } = await client.PATCH('/tables/{id}', {
        params: { path: { id: existingTable.id } },
        body: {
          ...payload,
          columns: payload.columns as components['schemas']['TableColumnDto'][],
        },
      });

      if (error) {
        log.error(
          {
            name: tableName,
            context: tableContext,
            status: (response as any)?.status,
            error,
          },
          'Failed to update table'
        );
        return 'failed';
      }

      return 'updated';
    }

    if (dryRun) {
      return 'created';
    }

    if (
      !validateEndpointPayload('CreateTableDto', payload, {
        artifactType: 'Table',
        artifactName: tableName,
        filePath: table.filePath,
      })
    ) {
      return 'failed';
    }

    const { error, response } = await client.POST('/tables', {
      body: {
        ...payload,
        columns: payload.columns as components['schemas']['TableColumnDto'][],
      },
    });

    if (error) {
      log.error(
        {
          name: tableName,
          context: tableContext,
          status: (response as any)?.status,
          error,
        },
        'Failed to create table'
      );
      return 'failed';
    }

    return 'created';
  } catch (error) {
    log.error({ error }, 'Error processing table');
    return 'failed';
  }
}

/**
 * Synchronize tables with the API
 */
export async function syncTables(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindTableFileOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const tableFiles = findTableFiles(options.discoveryOptions);
  const allTableFiles = findTableFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });

  log.info(chalk.cyan(createHeader('TABLES')));

  if (tableFiles.length === 0) {
    log.warn('No table JSON files found in src/**/artefacts/tabi/');
    return;
  }

  log.info(chalk.gray(`Found ${tableFiles.length} local table file(s)`));

  const namespace = getRequiredNamespace();
  const allTables = await getExistingTables(client);
  const existingTables = allTables.filter(table => {
    const context = table.context;
    return context === namespace || context?.startsWith(`${namespace}.`);
  });
  log.info(
    chalk.gray(
      `Fetched ${existingTables.length} table(s) from API in namespace "${namespace}"`
    )
  );

  if (options.detectOrphans === false) {
    log.info(chalk.gray('Skipping orphan detection for scoped table sync'));
  } else {
    const localTableKeys = new Set(
      allTableFiles.map(tf => `${tf.content.name}:${tf.content.context ?? ''}`)
    );

    const orphanCandidates = existingTables.filter(
      (table: any) =>
        !localTableKeys.has(`${table.name}:${table.context ?? ''}`)
    );
    const { included: tablesToDelete, excluded: excludedTables } =
      filterOrphansByContext(orphanCandidates);

    if (excludedTables.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excludedTables.length} table orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (tablesToDelete.length > 0) {
      if (deleteOrphans) {
        log.info(
          chalk.yellow(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${tablesToDelete.length} table(s) not in local files...`
          )
        );
        for (const table of tablesToDelete) {
          if (options.dryRun) {
            log.info(
              chalk.blue(
                `    [PLAN] Delete ${table.name} (${table.context ?? ''})`
              )
            );
            summary.planned++;
            continue;
          }

          const result = await deleteTable(
            client,
            table.id,
            table.name,
            table.context
          );
          if (result) summary.deleted++;
          else summary.failed++;
          await sleep(300);
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${tablesToDelete.length} orphaned table(s) (skipping deletion)`
          )
        );
        for (const table of tablesToDelete) {
          orphans.push({
            type: 'table',
            name: table.name,
            context: table.context ?? '',
            id: table.id,
          });
        }
      }
    } else {
      log.debug('No tables to delete');
    }
  }

  // Create or update local tables
  log.info(chalk.blue('Comparing local table payloads with API...'));
  for (const table of tableFiles) {
    const tableName = table.content.name;
    const tableContext = table.content.context ?? '';
    log.info(chalk.dim(`  → ${tableName} (${tableContext})`));

    if (!validateTableArtifact(table.content, table.filePath, skipInvalid)) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    try {
      validateNamespace(tableContext, 'Table', tableName);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'Namespace validation failed'
      );
      log.info(chalk.red('    [FAIL] Failed (namespace)'));
      summary.failed++;
      continue;
    }

    const result = await postTable(
      client,
      table,
      existingTables,
      options.dryRun,
      options.force
    );
    if (result === 'created') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Create'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Created'));
        summary.created++;
      }
    } else if (result === 'updated') {
      if (options.dryRun) {
        log.info(chalk.blue('    [PLAN] Update'));
        summary.planned++;
      } else {
        log.info(chalk.green('    [OK] Updated'));
        summary.updated++;
      }
    } else if (result === 'noop') {
      log.info(chalk.gray('    [SKIP] Unchanged'));
      summary.skipped++;
    } else {
      log.info(chalk.red('    [FAIL] Failed'));
      summary.failed++;
    }
    await sleep(500);
  }
}
