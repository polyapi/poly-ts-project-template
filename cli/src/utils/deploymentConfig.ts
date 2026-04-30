import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EnvLoadResult {
  displayPath: string;
  resolvedPath: string;
  exists: boolean;
  fromEnvPath: boolean;
}

export interface BranchEnvBinding {
  branch: string;
  envFile?: string;
}

export interface DeploymentPreflight {
  envFile: EnvLoadResult;
  productionBranch: string;
  currentBranch: string;
  productionSensitive: boolean;
  currentBranchParent?: string;
  sensitiveReason?: string;
  safeguardExemptionReason?: string;
  expectedEnvBranch?: string;
  expectedEnvFile?: string;
}

const DEFAULT_GIT_PROD_BRANCH = 'main';
const DEFAULT_GIT_PROD_BRANCH_ENV = 'prod.env';
const DEFAULT_GIT_PROD_SKIP_BRANCHES = ['develop:dev.env'];
const PRODUCTION_CONFIRMATION_VALUE = 'PROD';

function isRelativeTo(targetPath: string, candidateParent: string): boolean {
  const relativePath = path.relative(candidateParent, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function parseCsvEnv(name: string, defaultValues: string[]): string[] {
  const rawValue = process.env[name];
  if (!rawValue?.trim()) {
    return defaultValues;
  }

  return rawValue
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

export function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const normalizedValue = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`Invalid boolean value for ${name}: ${rawValue}`);
}

export function resolveConfiguredPath(
  projectRoot: string,
  configuredPath: string
): string {
  return path.resolve(projectRoot, configuredPath);
}

export function getDeploySkipPaths(projectRoot: string): string[] {
  return parseCsvEnv('POLY_DEPLOY_SKIP_PATHS', []).map(configuredPath =>
    resolveConfiguredPath(projectRoot, configuredPath)
  );
}

export function getDeployPriorityPaths(projectRoot: string): string[] {
  return parseCsvEnv('POLY_DEPLOY_PRIORITY_PATHS', []).map(configuredPath =>
    resolveConfiguredPath(projectRoot, configuredPath)
  );
}

export function pathIsExcluded(
  targetPath: string,
  projectRoot: string,
  respectSkipPaths: boolean = true
): boolean {
  if (!respectSkipPaths) {
    return false;
  }

  const resolvedTargetPath = path.resolve(targetPath);
  return getDeploySkipPaths(projectRoot).some(skipPath =>
    isRelativeTo(resolvedTargetPath, skipPath)
  );
}

export function pathPriorityRank(
  targetPath: string,
  projectRoot: string
): number {
  const resolvedTargetPath = path.resolve(targetPath);
  const priorityPaths = getDeployPriorityPaths(projectRoot);

  for (const [index, priorityPath] of priorityPaths.entries()) {
    if (
      isRelativeTo(resolvedTargetPath, priorityPath) ||
      isRelativeTo(priorityPath, resolvedTargetPath)
    ) {
      return index;
    }
  }

  return priorityPaths.length;
}

export function getExcludedOrphanContexts(): string[] {
  const rawValue =
    process.env.POLY_DEPLOY_EXCLUDE_ORPHAN_CONTEXTS ??
    process.env.EXCLUDE_ORPHANS ??
    '';

  return rawValue
    .split(',')
    .map(context => context.trim())
    .filter(Boolean);
}

function parseBranchEnvBinding(
  rawValue: string,
  envName: string,
  defaultEnvFile?: string
): BranchEnvBinding {
  const normalizedValue = rawValue.trim();
  const [rawBranch, rawEnvFile] = normalizedValue.split(':', 2);
  const branch = rawBranch?.trim();

  if (!branch) {
    throw new Error(`${envName} contains an empty branch entry.`);
  }

  if (normalizedValue.includes(':') && !rawEnvFile?.trim()) {
    throw new Error(
      `${envName} entry "${normalizedValue}" must include an env file after ":".`
    );
  }

  const envFile = rawEnvFile?.trim() || defaultEnvFile;
  return envFile ? { branch, envFile } : { branch };
}

export function getProductionBranchConfig(): BranchEnvBinding {
  const rawValue = process.env.GIT_PROD_BRANCH?.trim();
  if (!rawValue) {
    return {
      branch: DEFAULT_GIT_PROD_BRANCH,
      envFile: DEFAULT_GIT_PROD_BRANCH_ENV,
    };
  }

  return parseBranchEnvBinding(
    rawValue,
    'GIT_PROD_BRANCH',
    DEFAULT_GIT_PROD_BRANCH_ENV
  );
}

export function getProductionSkipBranchConfigs(
  productionBranch: string
): BranchEnvBinding[] {
  const configuredValues = parseCsvEnv(
    'GIT_PROD_SKIP_BRANCHES',
    DEFAULT_GIT_PROD_SKIP_BRANCHES
  );
  const bindings: BranchEnvBinding[] = [];
  const seenBranches = new Map<string, string | undefined>();

  for (const configuredValue of configuredValues) {
    const binding = parseBranchEnvBinding(
      configuredValue,
      'GIT_PROD_SKIP_BRANCHES'
    );

    if (binding.branch === productionBranch) {
      throw new Error(
        `GIT_PROD_SKIP_BRANCHES cannot include the configured production branch "${productionBranch}".`
      );
    }

    const existingEnvFile = seenBranches.get(binding.branch);
    if (existingEnvFile !== undefined) {
      if (existingEnvFile !== binding.envFile) {
        throw new Error(
          `GIT_PROD_SKIP_BRANCHES configures branch "${binding.branch}" more than once with different env files.`
        );
      }
      continue;
    }

    seenBranches.set(binding.branch, binding.envFile);
    bindings.push(binding);
  }

  return bindings;
}

function runGit(
  projectRoot: string,
  args: string[],
  check: boolean = true
): string {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  if (check && result.status !== 0) {
    const errorText =
      result.stderr?.trim() || result.stdout?.trim() || 'unknown git error';
    throw new Error(`git ${args.join(' ')} failed: ${errorText}`);
  }

  return result.stdout?.trim() ?? '';
}

function resolveGitProductionRef(
  projectRoot: string,
  productionBranch: string
): string {
  for (const candidate of [productionBranch, `origin/${productionBranch}`]) {
    const result = spawnSync('git', ['rev-parse', '--verify', candidate], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      return candidate;
    }
  }

  throw new Error(
    `Configured production branch "${productionBranch}" was not found locally.`
  );
}

export function getCurrentGitBranch(projectRoot: string): string {
  const branch = runGit(projectRoot, ['branch', '--show-current'], false);
  if (branch) {
    return branch;
  }

  const head = runGit(projectRoot, ['rev-parse', '--short', 'HEAD'], false);
  if (head) {
    return `DETACHED@${head}`;
  }

  throw new Error('Could not determine the current Git branch.');
}

function listLocalGitBranches(projectRoot: string): string[] {
  return runGit(projectRoot, [
    'for-each-ref',
    'refs/heads',
    '--format=%(refname:short)',
  ])
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean);
}

function resolveBranchBaseCommit(
  projectRoot: string,
  branchRef: string,
  headRef: string = 'HEAD'
): string | undefined {
  const forkPoint = runGit(
    projectRoot,
    ['merge-base', '--fork-point', branchRef, headRef],
    false
  );
  if (forkPoint) {
    return forkPoint;
  }

  const mergeBase = runGit(
    projectRoot,
    ['merge-base', branchRef, headRef],
    false
  );
  return mergeBase || undefined;
}

function commitsSinceBase(
  projectRoot: string,
  baseCommit: string,
  headRef: string = 'HEAD'
): number {
  const rawValue = runGit(projectRoot, [
    'rev-list',
    '--count',
    `${baseCommit}..${headRef}`,
  ]);

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`Unexpected git rev-list --count output: ${rawValue}`);
  }

  return Number(rawValue);
}

function nearestAncestorBranch(
  projectRoot: string,
  currentBranch: string,
  excludedBranches: string[] = [],
  maxDistance?: number,
  headRef: string = 'HEAD'
): string | undefined {
  let nearestBranch: string | undefined;
  let nearestDistance: number | undefined;

  for (const candidateBranch of listLocalGitBranches(projectRoot)) {
    if (
      candidateBranch === currentBranch ||
      excludedBranches.includes(candidateBranch)
    ) {
      continue;
    }

    const candidateBase = resolveBranchBaseCommit(
      projectRoot,
      candidateBranch,
      headRef
    );
    if (!candidateBase) {
      continue;
    }

    const candidateDistance = commitsSinceBase(
      projectRoot,
      candidateBase,
      headRef
    );
    if (maxDistance !== undefined && candidateDistance >= maxDistance) {
      continue;
    }

    if (nearestDistance === undefined || candidateDistance < nearestDistance) {
      nearestBranch = candidateBranch;
      nearestDistance = candidateDistance;
    }
  }

  return nearestBranch;
}

function branchAncestorChain(
  projectRoot: string,
  currentBranch: string,
  excludedBranches: string[] = []
): string[] {
  const ancestors: string[] = [];
  const seenBranches = new Set<string>([currentBranch]);
  let branchRef = currentBranch;

  while (true) {
    const parentBranch = nearestAncestorBranch(
      projectRoot,
      branchRef,
      excludedBranches,
      undefined,
      branchRef
    );

    if (!parentBranch || seenBranches.has(parentBranch)) {
      return ancestors;
    }

    ancestors.push(parentBranch);
    seenBranches.add(parentBranch);
    branchRef = parentBranch;
  }
}

function isBranchDirectlyDerivedFromProduction(
  projectRoot: string,
  currentBranch: string,
  productionBranch: string,
  productionRef: string
): boolean {
  const productionBase = resolveBranchBaseCommit(
    projectRoot,
    productionRef,
    currentBranch
  );
  if (!productionBase) {
    return false;
  }

  const productionDistance = commitsSinceBase(
    projectRoot,
    productionBase,
    currentBranch
  );
  const closerBranch = nearestAncestorBranch(
    projectRoot,
    currentBranch,
    [productionBranch],
    productionDistance,
    currentBranch
  );

  return closerBranch === undefined;
}

export function resolveBranchEnvFile(
  projectRoot: string,
  envFile: string
): string {
  if (path.isAbsolute(envFile)) {
    return path.resolve(envFile);
  }

  return path.resolve(projectRoot, envFile);
}

export function buildDeploymentPreflight(
  projectRoot: string,
  envFile: EnvLoadResult
): DeploymentPreflight {
  const productionBranchConfig = getProductionBranchConfig();
  const productionBranch = productionBranchConfig.branch;
  const productionSkipBranchConfigs =
    getProductionSkipBranchConfigs(productionBranch);
  const currentBranch = getCurrentGitBranch(projectRoot);
  const productionRef = resolveGitProductionRef(projectRoot, productionBranch);

  let currentBranchParent: string | undefined;
  let currentBranchAncestors: string[] = [];

  if (!currentBranch.startsWith('DETACHED@')) {
    currentBranchAncestors = branchAncestorChain(projectRoot, currentBranch);
    currentBranchParent = currentBranchAncestors[0];
  }

  if (currentBranch === productionBranch) {
    return {
      envFile,
      productionBranch,
      currentBranch,
      productionSensitive: true,
      currentBranchParent,
      sensitiveReason:
        'current branch matches the configured production branch',
      expectedEnvBranch: productionBranchConfig.branch,
      expectedEnvFile: productionBranchConfig.envFile,
    };
  }

  const exemptBinding = productionSkipBranchConfigs.find(binding =>
    [currentBranch, ...currentBranchAncestors].includes(binding.branch)
  );

  if (exemptBinding) {
    return {
      envFile,
      productionBranch,
      currentBranch,
      productionSensitive: false,
      currentBranchParent,
      safeguardExemptionReason:
        exemptBinding.branch === currentBranch
          ? `exempt via GIT_PROD_SKIP_BRANCHES (${exemptBinding.branch})`
          : `derived from exempt branch ${exemptBinding.branch}`,
      expectedEnvBranch: exemptBinding.branch,
      expectedEnvFile: exemptBinding.envFile,
    };
  }

  if (
    isBranchDirectlyDerivedFromProduction(
      projectRoot,
      currentBranch,
      productionBranch,
      productionRef
    )
  ) {
    return {
      envFile,
      productionBranch,
      currentBranch,
      productionSensitive: true,
      currentBranchParent,
      sensitiveReason:
        'current branch is directly derived from the configured production branch',
      expectedEnvBranch: productionBranchConfig.branch,
      expectedEnvFile: productionBranchConfig.envFile,
    };
  }

  return {
    envFile,
    productionBranch,
    currentBranch,
    productionSensitive: false,
    currentBranchParent,
  };
}

export function getPolyprodExecKey(): string | undefined {
  const rawValue = process.env.POLYPROD_EXEC_KEY;
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmedValue = rawValue.trim();
  if (!trimmedValue) {
    throw new Error(
      'POLYPROD_EXEC_KEY is set but empty. Provide a non-empty execution key.'
    );
  }

  return trimmedValue;
}

export function getProductionExecutionApiKeyOverride(
  projectRoot: string
): string | undefined {
  const polyprodExecKey = getPolyprodExecKey();
  if (!polyprodExecKey) {
    return undefined;
  }

  const preflight = buildDeploymentPreflight(projectRoot, {
    displayPath: '',
    resolvedPath: '',
    exists: false,
    fromEnvPath: false,
  });

  return preflight.productionSensitive ? polyprodExecKey : undefined;
}

export function getProductionConfirmationValue(): string {
  return PRODUCTION_CONFIRMATION_VALUE;
}

export function expectedBranchEnvFileExists(
  projectRoot: string,
  preflight: DeploymentPreflight
): boolean {
  if (!preflight.expectedEnvFile) {
    return false;
  }

  return fs.existsSync(
    resolveBranchEnvFile(projectRoot, preflight.expectedEnvFile)
  );
}
