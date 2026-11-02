import { createPolyApiClient } from './apiClient';
import type { EnvLoadResult } from './deploymentConfig';

export interface RemoteEnvironment {
  environmentId: string;
  environmentName?: string;
}

export function getTargetEnvId(envFile: EnvLoadResult): string {
  if (!envFile.exists) {
    throw new Error(
      `${envFile.displayPath} does not exist, so its TARGET_ENV_ID pin cannot be read. Select the target's environment file with ENVPATH.`
    );
  }
  const target = envFile.declaredTargetEnvId?.trim();
  if (!target) {
    throw new Error(
      `TARGET_ENV_ID is not set in ${envFile.displayPath}. Add the environment ID returned by authenticated GET /whoami to that file. Exporting it in your shell does not count. Kickstart saves this pin automatically.`
    );
  }
  return target;
}

/** Read the actual environment bound to the resolved API key, without OTP. */
export async function fetchRemoteEnvironment(
  client = createPolyApiClient()
): Promise<RemoteEnvironment> {
  if (!process.env.API_KEY?.trim() || !process.env.BASE_URL?.trim()) {
    throw new Error(
      'Missing PolyAPI connection. Run `pnpm workflows exec poly setup` or supply API_KEY and BASE_URL overrides.'
    );
  }
  const result = await client
    .GET('/whoami', {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    .catch(() => {
      // Transport errors can contain request headers or credential-bearing URLs.
      throw new Error(
        'GET /whoami failed; the target environment could not be verified. Check your PolyAPI connection.'
      );
    });
  if (result.response.status !== 200) {
    throw new Error(
      `GET /whoami failed (HTTP ${result.response.status}); the target environment could not be verified.`
    );
  }
  // The generated contract has an empty 200 shape. Validate the runtime body:
  // an unauthenticated request can also return 200, without an environment ID.
  const payload: unknown = result.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('GET /whoami did not return an authenticated environment.');
  }
  const { environmentId, environmentName } = payload as Record<string, unknown>;
  if (
    typeof environmentId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(environmentId)
  ) {
    throw new Error(
      'GET /whoami returned no valid environment ID. Re-run `pnpm workflows exec poly setup` with a key for this instance.'
    );
  }
  return {
    environmentId,
    ...(typeof environmentName === 'string' ? { environmentName } : {}),
  };
}

/** Required before remote reads, deployment previews, training, or deletion. */
export async function enforceTargetEnvironment(
  envFile: EnvLoadResult
): Promise<RemoteEnvironment> {
  const expected = getTargetEnvId(envFile);
  const actual = await fetchRemoteEnvironment();
  if (actual.environmentId !== expected) {
    throw new Error(
      `${envFile.displayPath} is pinned to TARGET_ENV_ID=${expected}, but the configured PolyAPI key points at ${actual.environmentId}. Refusing to continue. Select the correct environment file or correct the PolyAPI connection.`
    );
  }
  return actual;
}
