import type createClient from 'openapi-fetch';
import type { paths } from '../sdk/schema';
import { createLogger } from '../utils/logger';

type PolyApiClient = ReturnType<typeof createClient<paths>>;
type ApiResult = {
  data?: unknown;
  error?: unknown;
  response?: Response;
};
type ReferenceApiClient = {
  GET(path: string, options?: Record<string, unknown>): Promise<ApiResult>;
};

export type ReferenceScope = 'environment' | 'tenant' | 'public';
export type ReferenceableFunction = {
  id: string;
  name: string;
  context: string;
  visibility?: string;
  functionType: 'api' | 'server' | 'client';
  referenceScope: ReferenceScope;
};
export type ReferenceableWebhook = {
  id: string;
  name: string;
  context: string;
  visibility?: string;
  referenceScope: ReferenceScope;
};

const log = createLogger('references');

const FUNCTION_PATHS = {
  api: {
    environment: '/functions/api',
    tenant: '/functions/api/tenant',
    public: '/functions/api/public',
  },
  server: {
    environment: '/functions/server',
    tenant: '/functions/server/tenant',
    public: '/functions/server/public',
  },
  client: {
    environment: '/functions/client',
    tenant: '/functions/client/tenant',
    public: '/functions/client/public',
  },
} as const;

const WEBHOOK_PATHS = {
  environment: '/webhooks',
  tenant: '/webhooks/tenant',
  public: '/webhooks/public',
} as const;

function getReferenceClient(client: PolyApiClient): ReferenceApiClient {
  return client as unknown as ReferenceApiClient;
}

function normalizeListResponse(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !Array.isArray(item)
    );
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  const record = data as Record<string, unknown>;
  for (const key of ['results', 'items', 'data']) {
    if (Array.isArray(record[key])) {
      return normalizeListResponse(record[key]);
    }
  }

  return [];
}

async function fetchReferenceList(
  client: PolyApiClient,
  path: string
): Promise<Record<string, unknown>[]> {
  try {
    const { data, error, response } = await getReferenceClient(client).GET(
      path,
      {}
    );
    if (error || !data) {
      log.debug(
        { path, status: response?.status },
        'Reference source unavailable'
      );
      return [];
    }

    return normalizeListResponse(data);
  } catch {
    log.debug({ path }, 'Failed to fetch reference source');
    return [];
  }
}

function toReferenceableFunction(
  item: Record<string, unknown>,
  functionType: ReferenceableFunction['functionType'],
  referenceScope: ReferenceScope
): ReferenceableFunction | null {
  if (
    typeof item.id !== 'string' ||
    typeof item.name !== 'string' ||
    typeof item.context !== 'string'
  ) {
    return null;
  }

  return {
    id: item.id,
    name: item.name,
    context: item.context,
    ...(typeof item.visibility === 'string'
      ? { visibility: item.visibility }
      : {}),
    functionType,
    referenceScope,
  };
}

function deduplicateFunctions(
  functions: ReferenceableFunction[]
): ReferenceableFunction[] {
  const unique = new Map<string, ReferenceableFunction>();
  for (const func of functions) {
    const key = `${func.functionType}:${func.id}`;
    if (!unique.has(key)) {
      unique.set(key, func);
    }
  }
  return [...unique.values()];
}

export async function getReferenceableFunctions(
  client: PolyApiClient,
  functionTypes: ReferenceableFunction['functionType'][] = [
    'api',
    'server',
    'client',
  ]
): Promise<ReferenceableFunction[]> {
  const requests = functionTypes.flatMap(functionType =>
    Object.entries(FUNCTION_PATHS[functionType]).map(
      async ([referenceScope, path]) => {
        const items = await fetchReferenceList(client, path);
        return items.flatMap(item => {
          const candidate = toReferenceableFunction(
            item,
            functionType,
            referenceScope as ReferenceScope
          );
          return candidate ? [candidate] : [];
        });
      }
    )
  );

  return deduplicateFunctions((await Promise.all(requests)).flat());
}

export async function getReferenceableServerFunctions(
  client: PolyApiClient
): Promise<ReferenceableFunction[]> {
  return getReferenceableFunctions(client, ['server']);
}

export async function getReferenceableWebhooks(
  client: PolyApiClient
): Promise<ReferenceableWebhook[]> {
  const requests = Object.entries(WEBHOOK_PATHS).map(
    async ([referenceScope, path]) => {
      const items = await fetchReferenceList(client, path);
      return items.flatMap(item => {
        if (
          typeof item.id !== 'string' ||
          typeof item.name !== 'string' ||
          typeof item.context !== 'string'
        ) {
          return [];
        }

        return [
          {
            id: item.id,
            name: item.name,
            context: item.context,
            ...(typeof item.visibility === 'string'
              ? { visibility: item.visibility }
              : {}),
            referenceScope: referenceScope as ReferenceScope,
          },
        ];
      });
    }
  );

  const unique = new Map<string, ReferenceableWebhook>();
  for (const webhook of (await Promise.all(requests)).flat()) {
    if (!unique.has(webhook.id)) {
      unique.set(webhook.id, webhook);
    }
  }
  return [...unique.values()];
}
