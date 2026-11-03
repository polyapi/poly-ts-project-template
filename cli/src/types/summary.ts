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
  jobs: ArtifactSummary;
  orphans: OrphanedResource[];
  startTime: number;
  endTime?: number;
}

export function createSummary(): SyncSummary {
  return {
    canopy: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    schemas: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    webhooks: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    functions: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    aiFunctions: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    mcpServers: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    triggers: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    subscriptions: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    variables: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    tables: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    jobs: {
      created: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      skipped: 0,
      planned: 0,
    },
    orphans: [],
    startTime: Date.now(),
  };
}

export function getTotalStats(summary: SyncSummary): ArtifactSummary {
  const total: ArtifactSummary = {
    created: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
    planned: 0,
  };

  for (const artifact of [
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
    'jobs',
  ] as const) {
    total.created += summary[artifact].created;
    total.updated += summary[artifact].updated;
    total.deleted += summary[artifact].deleted;
    total.failed += summary[artifact].failed;
    total.skipped += summary[artifact].skipped;
    total.planned += summary[artifact].planned;
  }

  return total;
}
