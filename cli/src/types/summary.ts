/**
 * Summary tracking for synchronization results
 */

export interface ArtifactSummary {
  created: number;
  updated: number;
  deleted: number;
  failed: number;
  skipped: number;
  planned: number;
  /**
   * Changes withheld because the remote copy changed after the local file
   * (table rows changed in their table after their data file); --force
   * applies them.
   */
  blocked: number;
}

export interface OrphanedResource {
  type:
    | 'schema'
    | 'webhook'
    | 'function'
    | 'ai-function'
    | 'trigger'
    | 'subscription'
    | 'variable'
    | 'table'
    | 'job';
  name: string;
  context: string;
  id: string;
}

export interface SyncSummary {
  canopy: ArtifactSummary;
  schemas: ArtifactSummary;
  webhooks: ArtifactSummary;
  functions: ArtifactSummary;
  aiFunctions: ArtifactSummary;
  mcpServers: ArtifactSummary;
  triggers: ArtifactSummary;
  subscriptions: ArtifactSummary;
  variables: ArtifactSummary;
  tables: ArtifactSummary;
  tableData: ArtifactSummary;
  jobs: ArtifactSummary;
  orphans: OrphanedResource[];
  startTime: number;
  endTime?: number;
}

const ARTIFACT_KEYS = [
  'canopy',
  'schemas',
  'webhooks',
  'functions',
  'aiFunctions',
  'mcpServers',
  'triggers',
  'subscriptions',
  'variables',
  'tables',
  'tableData',
  'jobs',
] as const;

export function createArtifactSummary(): ArtifactSummary {
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
    planned: 0,
    blocked: 0,
  };
}

export function createSummary(): SyncSummary {
  return {
    canopy: createArtifactSummary(),
    schemas: createArtifactSummary(),
    webhooks: createArtifactSummary(),
    functions: createArtifactSummary(),
    aiFunctions: createArtifactSummary(),
    mcpServers: createArtifactSummary(),
    triggers: createArtifactSummary(),
    subscriptions: createArtifactSummary(),
    variables: createArtifactSummary(),
    tables: createArtifactSummary(),
    tableData: createArtifactSummary(),
    jobs: createArtifactSummary(),
    orphans: [],
    startTime: Date.now(),
  };
}

export function getTotalStats(summary: SyncSummary): ArtifactSummary {
  const total = createArtifactSummary();

  for (const artifact of ARTIFACT_KEYS) {
    total.created += summary[artifact].created;
    total.updated += summary[artifact].updated;
    total.deleted += summary[artifact].deleted;
    total.failed += summary[artifact].failed;
    total.skipped += summary[artifact].skipped;
    total.planned += summary[artifact].planned;
    total.blocked += summary[artifact].blocked;
  }

  return total;
}
