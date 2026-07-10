import { readFileSync } from 'node:fs';
import type {
  CanopyFile,
  GraphQLSubscriptionFile,
  JobFile,
  SchemaFile,
  TableFile,
  TriggerFile,
  VariableFile,
  WebhookFile,
} from '../types';
import { getRelativePath } from './fileSystem';
import { chalk, logger } from './logger';

const ENV_ALERT_PATTERN = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

type JsonArtifactFile =
  | CanopyFile
  | SchemaFile
  | WebhookFile
  | TriggerFile
  | GraphQLSubscriptionFile
  | TableFile
  | VariableFile
  | JobFile;

export interface MissingEnvTokenRef {
  envName: string;
  filePath: string;
  lineNumber: number | null;
}

function findUnresolvedEnvTokens(value: unknown): Set<string> {
  const tokens = new Set<string>();

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const token of findUnresolvedEnvTokens(item)) {
        tokens.add(token);
      }
    }
    return tokens;
  }

  if (value && typeof value === 'object') {
    for (const [key, nestedValue] of Object.entries(
      value as Record<string, unknown>
    )) {
      for (const token of findUnresolvedEnvTokens(key)) {
        tokens.add(token);
      }
      for (const token of findUnresolvedEnvTokens(nestedValue)) {
        tokens.add(token);
      }
    }
    return tokens;
  }

  if (typeof value === 'string') {
    for (const match of value.matchAll(ENV_ALERT_PATTERN)) {
      tokens.add(match[1]);
    }
  }

  return tokens;
}

function findEnvTokenLineNumber(
  filePath: string,
  envName: string
): number | null {
  const token = `{{${envName}}}`;

  try {
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].includes(token)) {
        return index + 1;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function collectMissingEnvTokenRefs(
  files: JsonArtifactFile[]
): MissingEnvTokenRef[] {
  const refs: MissingEnvTokenRef[] = [];
  const seenRefs = new Set<string>();

  for (const file of files) {
    for (const envName of [...findUnresolvedEnvTokens(file.content)].sort()) {
      if (process.env[envName] !== undefined) {
        continue;
      }

      const key = `${envName}:${file.filePath}`;
      if (seenRefs.has(key)) {
        continue;
      }

      seenRefs.add(key);
      refs.push({
        envName,
        filePath: file.filePath,
        lineNumber: findEnvTokenLineNumber(file.filePath, envName),
      });
    }
  }

  return refs;
}

export function printMissingEnvTokenWarning(refs: MissingEnvTokenRef[]): void {
  const groupedRefs = new Map<string, MissingEnvTokenRef[]>();
  for (const ref of refs) {
    const group = groupedRefs.get(ref.envName) ?? [];
    group.push(ref);
    groupedRefs.set(ref.envName, group);
  }

  logger.info('');
  logger.info(
    chalk.bold('═══════════════════════════════════════════════════════════')
  );
  logger.info(
    chalk.yellow.bold('Missing env-file values for deploy placeholders')
  );
  logger.info(
    chalk.gray(
      'These {{ENV_NAME}} tokens appear in deployable JSON artifacts but are not defined.'
    )
  );
  logger.info(
    chalk.gray(
      'Set them in the selected env file first, or continue and leave those placeholders unchanged.'
    )
  );
  logger.info('');

  for (const envName of [...groupedRefs.keys()].sort()) {
    logger.info(chalk.yellow.bold(`  • ${envName}`));
    for (const ref of groupedRefs.get(envName) ?? []) {
      const fileRef =
        ref.lineNumber === null
          ? getRelativePath(ref.filePath)
          : `${getRelativePath(ref.filePath)}:${ref.lineNumber}`;
      logger.info(chalk.cyan(`    ${fileRef}`));
    }
  }

  logger.info(
    chalk.bold('═══════════════════════════════════════════════════════════')
  );
}
