import type createClient from 'openapi-fetch';
import type { components, paths } from '../sdk/schema';
import type { SchemaFile } from '../types';
import type { ArtifactSummary, OrphanedResource } from '../types/summary';
import { getDeleteHeaders, sleep } from '../utils/apiClient';
import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import {
  getSrcPath,
  isInArtefactDirectory,
  readJsonFile,
  type WalkDirOptions,
  walkDir,
} from '../utils/fileSystem';
import { chalk, createHeader, createLogger, warningColor } from '../utils/logger';
import { getRequiredNamespaces, matchesAnyRequiredNamespace, validateNamespace } from '../utils/namespace';
import { filterOrphansByContext } from '../utils/orphans';
import { areComparisonPayloadsEqual } from '../utils/payloadComparison';
import { validateSchemaArtifact } from '../utils/validation';

type SchemaDto = components['schemas']['SchemaDto'];
type SchemaDetailsDto = components['schemas']['SchemaDetailsDto'];
type CreateSchemaDto =
  paths['/schemas']['post']['requestBody']['content']['application/json'];
type UpdateSchemaDto =
  paths['/schemas/{id}']['patch']['requestBody']['content']['application/json'];

const log = createLogger('schemas');
type FindSchemaFileOptions = WalkDirOptions;

/**
 * Find all schema JSON files in the project
 */
export function findSchemaFiles(
  options: FindSchemaFileOptions = {}
): SchemaFile[] {
  const schemaFiles: SchemaFile[] = [];
  const srcPath = getSrcPath();

  walkDir(
    srcPath,
    (fullPath, file) => {
      if (
        file.endsWith('.json') &&
        !file.endsWith('.test.json') &&
        fullPath.includes('/schemas/') &&
        isInArtefactDirectory(fullPath)
      ) {
        const content = readJsonFile(fullPath);
        if (content) {
          schemaFiles.push({
            filePath: fullPath,
            fileName: file,
            content,
          });
        }
      }
    },
    options
  );

  return schemaFiles;
}

/**
 * Get all existing schemas from the API
 */
export async function getExistingSchemas(
  client: ReturnType<typeof createClient<paths>>
): Promise<SchemaDto[]> {
  try {
    const { data, error } = await client.GET('/schemas', {});

    if (error || !data) {
      return [];
    }

    return data;
  } catch (error) {
    log.warn({ error }, 'Failed to fetch schemas from API');
    return [];
  }
}

/**
 * Delete a schema by ID
 */
async function deleteSchema(
  client: ReturnType<typeof createClient<paths>>,
  schemaId: string,
  name: string,
  context: string
): Promise<boolean> {
  try {
    const { error, response } = await client.DELETE('/schemas/{id}', {
      params: { path: { id: schemaId } },
      headers: await getDeleteHeaders(),
    });

    if (error) {
      log.error(
        { name, context, status: (response as any)?.status },
        'Failed to delete schema'
      );
      return false;
    } else {
      log.info({ name, context }, 'Schema deleted');
      return true;
    }
  } catch (error) {
    log.error({ error, name, context }, 'Error deleting schema');
    return false;
  }
}

/**
 * POST or PATCH a schema to the API
 * Returns: 'created' | 'updated' | 'noop' | 'failed'
 */
function buildSchemaPayload(schema: SchemaFile): CreateSchemaDto {
  return {
    name: schema.content.name || 'N/A',
    context: schema.content.context || '',
    definition: schema.content.schema as CreateSchemaDto['definition'],
  };
}

function buildRemoteSchemaPayload(
  localPayload: CreateSchemaDto,
  schemaDetails: SchemaDetailsDto
): CreateSchemaDto {
  const definition = { ...schemaDetails.definition } as Record<string, unknown>;
  const localDefinition = localPayload.definition as Record<string, unknown>;

  if (!('$schema' in localDefinition)) {
    delete definition.$schema;
  }

  return {
    name: schemaDetails.name,
    context: schemaDetails.context,
    definition: definition as CreateSchemaDto['definition'],
  };
}

async function getExistingSchemaDetails(
  client: ReturnType<typeof createClient<paths>>,
  schemaId: string
): Promise<SchemaDetailsDto | null> {
  try {
    const { data, error, response } = await client.GET('/schemas/{id}', {
      params: { path: { id: schemaId } },
    });

    if (error || !data) {
      log.warn(
        { schemaId, status: (response as any)?.status },
        'Failed to fetch schema details'
      );
      return null;
    }

    return data as SchemaDetailsDto;
  } catch (error) {
    log.warn({ error, schemaId }, 'Error fetching schema details');
    return null;
  }
}

async function postSchema(
  client: ReturnType<typeof createClient<paths>>,
  schema: SchemaFile,
  existingSchemas: SchemaDto[],
  dryRun: boolean = false,
  force: boolean = false
): Promise<'created' | 'updated' | 'noop' | 'failed'> {
  try {
    const payload = buildSchemaPayload(schema);
    const schemaName = payload.name;
    const schemaContext = payload.context;

    // Check if schema already exists
    const existingSchema = existingSchemas.find(
      s => s.name === schemaName && s.context === schemaContext
    );

    if (existingSchema) {
      const schemaDetails = await getExistingSchemaDetails(
        client,
        existingSchema.id
      );
      if (
        !force &&
        schemaDetails &&
        areComparisonPayloadsEqual(
          payload,
          buildRemoteSchemaPayload(payload, schemaDetails)
        )
      ) {
        return 'noop';
      }

      if (dryRun) {
        return 'updated';
      }

      if (
        !validateEndpointPayload('UpdateSchemaDto', payload, {
          artifactType: 'Schema',
          artifactName: schemaName,
          filePath: schema.filePath,
        })
      ) {
        return 'failed';
      }

      const { error, response } = await client.PATCH('/schemas/{id}', {
        params: { path: { id: existingSchema.id } },
        body: payload as UpdateSchemaDto,
      });

      if (error) {
        log.error(
          {
            name: schemaName,
            context: schemaContext,
            status: (response as any)?.status,
            error,
          },
          'Failed to update schema'
        );
        return 'failed';
      } else {
        return 'updated';
      }
    } else {
      if (dryRun) {
        return 'created';
      }

      if (
        !validateEndpointPayload('CreateSchemaDto', payload, {
          artifactType: 'Schema',
          artifactName: schemaName,
          filePath: schema.filePath,
        })
      ) {
        return 'failed';
      }

      const { error, response } = await client.POST('/schemas', {
        body: payload,
      });

      if (error) {
        log.error(
          {
            name: schemaName,
            context: schemaContext,
            status: (response as any)?.status,
            error,
          },
          'Failed to create schema'
        );
        return 'failed';
      } else {
        return 'created';
      }
    }
  } catch (error) {
    log.error({ error }, 'Error processing schema');
    return 'failed';
  }
}

/**
 * Synchronize schemas with the API
 */
export async function syncSchemas(
  client: ReturnType<typeof createClient<paths>>,
  summary: ArtifactSummary,
  orphans: OrphanedResource[],
  deleteOrphans: boolean,
  skipInvalid: boolean = false,
  options: {
    dryRun?: boolean;
    force?: boolean;
    discoveryOptions?: FindSchemaFileOptions;
    detectOrphans?: boolean;
  } = {}
): Promise<void> {
  const schemaFiles = findSchemaFiles(options.discoveryOptions);
  const allSchemaFiles = findSchemaFiles({
    respectSkipPaths: false,
    includePaths: options.discoveryOptions?.includePaths,
  });

  log.info(chalk.cyan(createHeader('SCHEMAS')));

  if (schemaFiles.length === 0) {
    log.warn(
      warningColor(
        'No schema JSON files found in src/**/artefacts/schemas/ (legacy src/**/artifacts/schemas/ is also supported)'
      )
    );
    return;
  }

  log.info(chalk.gray(`Found ${schemaFiles.length} local schema file(s)`));

  // Step 1: Get existing schemas from API (filtered by namespace)
  const namespaces = getRequiredNamespaces();
  const allSchemas = await getExistingSchemas(client);
  const existingSchemas = allSchemas.filter(schema =>
    matchesAnyRequiredNamespace(schema.context)
  );
  log.info(
    chalk.gray(
      `Fetched ${existingSchemas.length} schema(s) from API in namespace(s) "${namespaces.join(", ")}"`
    )
  );

  // Step 2: Identify schemas that don't exist locally (orphans)
  const localSchemaKeys = new Set(
    allSchemaFiles.map(sf => `${sf.content.name}:${sf.content.context}`)
  );

  if (options.detectOrphans === false) {
    log.info(chalk.gray('Skipping orphan detection for scoped schema sync'));
  } else {
    const orphanCandidates = existingSchemas.filter(
      schema => !localSchemaKeys.has(`${schema.name}:${schema.context}`)
    );
    const { included: schemasToDelete, excluded: excludedSchemas } =
      filterOrphansByContext(orphanCandidates);
    if (excludedSchemas.length > 0) {
      log.info(
        chalk.gray(
          `Skipped ${excludedSchemas.length} schema orphan(s) excluded by POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS`
        )
      );
    }

    if (schemasToDelete.length > 0) {
      if (deleteOrphans) {
        log.info(
          warningColor(
            `${options.dryRun ? 'Planning deletion of' : 'Deleting'} ${schemasToDelete.length} schema(s) not in local files...`
          )
        );
        for (const schema of schemasToDelete) {
          if (options.dryRun) {
            log.info(
              chalk.blue(`    [PLAN] Delete ${schema.name} (${schema.context})`)
            );
            summary.planned++;
            continue;
          }

          const result = await deleteSchema(
            client,
            schema.id,
            schema.name,
            schema.context
          );
          if (result) summary.deleted++;
          else summary.failed++;
          await sleep(300);
        }
      } else {
        log.info(
          chalk.gray(
            `Found ${schemasToDelete.length} orphaned schema(s) (skipping deletion)`
          )
        );
        for (const schema of schemasToDelete) {
          orphans.push({
            type: 'schema',
            name: schema.name,
            context: schema.context,
            id: schema.id,
          });
        }
      }
    } else {
      log.debug('No schemas to delete');
    }
  }

  // Step 3: Create or update local schemas
  log.info(chalk.blue('Comparing local schema payloads with API...'));
  for (const schema of schemaFiles) {
    log.info(
      chalk.dim(`  → ${schema.content.name} (${schema.content.context})`)
    );

    // Validate artifact structure before syncing
    if (!validateSchemaArtifact(schema.content, schema.filePath, skipInvalid)) {
      log.info(chalk.red('    [FAIL] Validation failed'));
      summary.failed++;
      continue;
    }

    // Validate namespace
    try {
      validateNamespace(schema.content.context, 'Schema', schema.content.name);
    } catch (error) {
      log.error(
        { error: (error as Error).message },
        'Namespace validation failed'
      );
      log.info(chalk.red('    [FAIL] Failed (namespace)'));
      summary.failed++;
      continue;
    }

    const result = await postSchema(
      client,
      schema,
      existingSchemas,
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
