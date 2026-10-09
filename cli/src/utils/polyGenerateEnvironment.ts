/** Preserve SDK configuration while excluding pnpm's npm-incompatible flag. */
export function getPolyGenerateEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name.toLowerCase() !== 'npm_config_recursive'
    )
  );
}
