import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import type { FunctionFile } from '../types';

const IMAGES_SETTING = 'POLY_DEPLOY_SERVER_FUNCTION_IMAGES';
const SCRIPTS_SETTING = 'POLY_DEPLOY_SERVER_FUNCTION_SCRIPT';
const FUNCTION_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

type FunctionIdentity = {
  type: FunctionFile['type'];
  metadata: Pick<FunctionFile['metadata'], 'context' | 'name'>;
};

export interface ServerFunctionDeploymentConfig {
  images: Map<string, string>;
  scripts: Map<string, string>;
}

function parseMappings(
  raw: string | undefined,
  setting: string
): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const entry of (raw ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(':');
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (
      separator < 0 ||
      !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(key) ||
      !value
    ) {
      throw new Error(`${setting} entries must use <context>.<name>:<value>.`);
    }
    if (mappings.has(key)) {
      throw new Error(`Duplicate function key in ${setting}: ${key}`);
    }
    mappings.set(key, value);
  }
  return mappings;
}

export function readServerFunctionDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env
): ServerFunctionDeploymentConfig {
  const images = parseMappings(env[IMAGES_SETTING], IMAGES_SETTING);
  for (const [key, image] of images) {
    // The platform's image field is a name, not a registry URL (Swagger: no '/').
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:@-]*$/.test(image)) {
      throw new Error(
        `${IMAGES_SETTING}: ${key} requires a slash-free image name, not a registry URL.`
      );
    }
  }
  return {
    images,
    scripts: parseMappings(env[SCRIPTS_SETTING], SCRIPTS_SETTING),
  };
}

export function getServerFunctionDeployment(
  func: FunctionIdentity,
  config: ServerFunctionDeploymentConfig = readServerFunctionDeploymentConfig()
): { image?: string; script?: string } {
  if (func.type !== 'server') return {};
  const key = `${func.metadata.context}.${func.metadata.name}`;
  return { image: config.images.get(key), script: config.scripts.get(key) };
}

/** Plan output deliberately omits shell commands, which can contain credentials. */
export function getServerFunctionDeploymentPlan(func: FunctionIdentity): {
  image?: string;
  postDeployScript: boolean;
} {
  const { image, script } = getServerFunctionDeployment(func);
  return { image, postDeployScript: Boolean(script) };
}

export function parseDeployedFunctionId(output: string): string {
  const ids = new Set(
    stripVTControlCharacters(output)
      .split(/\r?\n/)
      .filter(line => line.startsWith('Function ID:'))
      .map(line => line.slice('Function ID:'.length).trim())
  );
  const [id] = ids;
  if (ids.size !== 1 || !FUNCTION_ID_PATTERN.test(id)) {
    throw new Error(
      'Successful function deployment did not return one valid Function ID; post-deploy script was not run.'
    );
  }
  return id;
}

export async function runServerFunctionPostDeployScript(options: {
  functionKey: string;
  command: string;
  functionId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { functionKey, command, functionId, cwd, env } = options;
  if (!FUNCTION_ID_PATTERN.test(functionId)) {
    throw new Error(
      `Invalid function ID for post-deploy script: ${functionKey}`
    );
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'bash' : '/bin/bash',
      ['-c', command.replace(/<id>/g, functionId)],
      {
        cwd,
        env: {
          ...env,
          FUNCTION_ID: functionId,
          SERVICE_NAME: `function-${functionId}`,
        },
        // Keep script progress and hidden-input prompts usable. JSON plans are dry runs.
        stdio: 'inherit',
      }
    );
    child.on('error', () =>
      reject(
        new Error(
          `Could not start post-deploy script for ${functionKey}; Bash must be installed.`
        )
      )
    );
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Post-deploy script failed for ${functionKey} (${signal ? `signal ${signal}` : `exit code ${code}`}). The function was deployed; review the hook before retrying.`
          )
        );
    });
  });
}
