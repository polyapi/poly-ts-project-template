import poly, { type PolyClientFunction, vari } from 'polyapi';

// biome-ignore lint/correctness/noUnusedVariables: polyConfig is read by the PolyAPI platform
const polyConfig: PolyClientFunction = {
  name: 'log',
  context: 'example.utilities',
  description:
    'Emit structured diagnostic events with vari-controlled log level.',
  visibility: 'ENVIRONMENT',
};

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type ConfiguredLogLevel = LogLevel | 'silent';

const DEFAULT_LOG_LEVEL: ConfiguredLogLevel = 'debug';
const LOG_LEVEL_REFRESH_INTERVAL_MS = 60_000;
const VALID_LOG_LEVELS: ConfiguredLogLevel[] = [
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
];
const BLOCKED_CONTEXT_KEYS = new Set([
  'apikey',
  'appkey',
  'authorization',
  'clientsecret',
  'executionid',
  'password',
  'secret',
  'token',
  'xcorrelationid',
]);
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

let currentLogLevel: ConfiguredLogLevel = DEFAULT_LOG_LEVEL;
let isRefreshingLogLevel = false;
let lastLogLevelRefreshAt = 0;

function sanitizeContext(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeContext(item));
  }

  if (value && typeof value === 'object') {
    const sanitizedEntries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !BLOCKED_CONTEXT_KEYS.has(key.toLowerCase()))
      .map(([key, itemValue]) => [key, sanitizeContext(itemValue)]);

    return Object.fromEntries(sanitizedEntries);
  }

  return value;
}

function shouldLog(level: LogLevel): boolean {
  if (currentLogLevel === 'silent') {
    return false;
  }

  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLogLevel];
}

function serializeContext(value: unknown): string {
  const seenObjects = new WeakSet<object>();

  return JSON.stringify(value, (_key, itemValue) => {
    if (typeof itemValue === 'bigint') {
      return itemValue.toString();
    }

    if (itemValue instanceof Error) {
      const errorWithCause = itemValue as Error & { cause?: unknown };
      return {
        name: itemValue.name,
        message: itemValue.message,
        stack: itemValue.stack,
        cause: errorWithCause.cause,
      };
    }

    if (itemValue && typeof itemValue === 'object') {
      if (seenObjects.has(itemValue)) {
        return '[Circular]';
      }
      seenObjects.add(itemValue);
    }

    return itemValue;
  });
}

function refreshLogLevel(): void {
  const now = Date.now();
  if (
    isRefreshingLogLevel ||
    now - lastLogLevelRefreshAt < LOG_LEVEL_REFRESH_INTERVAL_MS
  ) {
    return;
  }

  isRefreshingLogLevel = true;
  lastLogLevelRefreshAt = now;

  void Promise.resolve(vari.example.configurations.logging.logLevel.get())
    .then((configuredValue: string) => {
      const normalizedLevel = configuredValue.trim().toLowerCase();
      if (VALID_LOG_LEVELS.includes(normalizedLevel as ConfiguredLogLevel)) {
        currentLogLevel = normalizedLevel as ConfiguredLogLevel;
      }
    })
    .catch(() => {
      currentLogLevel = DEFAULT_LOG_LEVEL;
    })
    .finally(() => {
      isRefreshingLogLevel = false;
    });
}

function getEmitter(level: LogLevel): (message: string) => void {
  if (level === 'warn') {
    return console.warn.bind(console);
  }

  if (level === 'error' || level === 'fatal') {
    return console.error.bind(console);
  }

  return console.info.bind(console);
}

function emitRuntimeLog(
  level: LogLevel,
  functionName: string,
  message: string,
  context?: Record<string, unknown>
): void {
  const messageWithPrefix = `[${level}][${functionName}] ${message}`;
  const emit = getEmitter(level);

  if (!context) {
    emit(messageWithPrefix);
    return;
  }

  const sanitizedContext = sanitizeContext(context);
  try {
    emit(
      `${messageWithPrefix} | context=${serializeContext(sanitizedContext)}`
    );
  } catch {
    emit(`${messageWithPrefix} | context=[unserializable-context]`);
  }
}

async function emitErrorAlert(
  level: LogLevel,
  functionName: string,
  message: string,
  context?: Record<string, unknown>
): Promise<void> {
  if (!['error', 'fatal'].includes(level)) {
    return;
  }

  await poly.example.utilities.slack.sendAlert({
    message: serializeContext({
      message: `[${level}][${functionName}] ${message}`,
      level,
      functionName,
      context: context ? sanitizeContext(context) : undefined,
    }),
  });
}

export default async function log(
  level: LogLevel,
  functionName: string,
  message: string,
  context?: Record<string, unknown>
): Promise<void> {
  refreshLogLevel();

  if (!shouldLog(level)) {
    return;
  }

  emitRuntimeLog(level, functionName, message, context);
  await emitErrorAlert(level, functionName, message, context);
}
