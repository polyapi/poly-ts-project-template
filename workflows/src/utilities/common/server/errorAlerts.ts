import type { PolyServerFunction } from 'polyapi';

// biome-ignore lint/correctness/noUnusedVariables: polyConfig is read by the PolyAPI platform
const polyConfig: PolyServerFunction = {
  name: 'errorAlerts',
  context: 'example.utilities',
  description: 'Generic global error handler for uncaught PolyAPI errors',
};

export type ErrorEventInput = {
  message?: string;
  data?: unknown;
  status?: number;
  statusText?: string;
  functionId?: string;
  applicationId?: string;
  userId?: string;
};

const BLOCKED_KEYS = new Set([
  'authorization',
  'apiKey',
  'apikey',
  'password',
  'secret',
  'token',
]);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitize(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        BLOCKED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : sanitize(item),
      ])
    );
  }

  return value;
}

function normalizeMessage(error: ErrorEventInput): string {
  return error.message?.trim() || 'Unhandled PolyAPI error';
}

export default async function errorAlerts(
  error: ErrorEventInput
): Promise<void> {
  try {
    const payload = {
      message: normalizeMessage(error),
      status: error.status,
      statusText: error.statusText,
      functionId: error.functionId,
      applicationId: error.applicationId,
      userId: error.userId,
      data: sanitize(error.data),
    };

    console.error(`[errorAlerts] ${JSON.stringify(payload)}`);
  } catch {
    // Global error handlers must not create secondary failures.
  }
}
