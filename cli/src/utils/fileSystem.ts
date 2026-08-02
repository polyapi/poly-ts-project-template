import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathIsExcluded, pathPriorityRank } from './deploymentConfig';
import { substituteEnvTokens } from './envSubstitution';
import { logger } from './logger';

export interface WalkDirOptions {
  respectSkipPaths?: boolean;
  includePaths?: string[];
}

function isRelativeTo(targetPath: string, candidateParent: string): boolean {
  const relativePath = path.relative(candidateParent, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function pathMatchesIncludedPaths(
  targetPath: string,
  includePaths: string[] | undefined
): boolean {
  if (!includePaths || includePaths.length === 0) {
    return true;
  }

  const resolvedTargetPath = path.resolve(targetPath);
  return includePaths.some(includePath => {
    const resolvedIncludePath = path.resolve(includePath);
    return (
      isRelativeTo(resolvedTargetPath, resolvedIncludePath) ||
      isRelativeTo(resolvedIncludePath, resolvedTargetPath)
    );
  });
}

/**
 * Recursively walk a directory and execute a callback for each file
 */
export function walkDir(
  dir: string,
  callback: (filePath: string, fileName: string, stat: fs.Stats) => void,
  options: WalkDirOptions = {}
): void {
  if (!fs.existsSync(dir)) {
    return;
  }

  const files = fs.readdirSync(dir).sort((left, right) => {
    const leftPath = path.join(dir, left);
    const rightPath = path.join(dir, right);
    const leftRank = pathPriorityRank(leftPath, getProjectRoot());
    const rightRank = pathPriorityRank(rightPath, getProjectRoot());

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return leftPath.localeCompare(rightPath);
  });

  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (
      pathIsExcluded(
        fullPath,
        getProjectRoot(),
        options.respectSkipPaths ?? true
      )
    ) {
      continue;
    }

    if (!pathMatchesIncludedPaths(fullPath, options.includePaths)) {
      continue;
    }

    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      walkDir(fullPath, callback, options);
    } else {
      callback(fullPath, file, stat);
    }
  }
}

/**
 * Get the project root directory
 */
export function getProjectRoot(): string {
  return process.cwd();
}

export function findWorkspaceRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    if (fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return startDir;
    }

    currentDir = parentDir;
  }
}

/**
 * Get the src directory path
 */
export function getSrcPath(): string {
  return path.join(getProjectRoot(), 'src');
}

/**
 * Check whether a path is inside the canonical artefacts directory or the
 * legacy artifacts compatibility alias.
 */
export function isInArtefactDirectory(filePath: string): boolean {
  return (
    isInNamedDirectory(filePath, 'artefacts') ||
    isInNamedDirectory(filePath, 'artifacts')
  );
}

/**
 * Check whether a path contains an exact directory segment on any platform.
 */
export function isInNamedDirectory(
  filePath: string,
  directoryName: string
): boolean {
  return filePath.split(/[\\/]+/).includes(directoryName);
}

/**
 * Get relative path from project root
 */
export function getRelativePath(filePath: string): string {
  return path.relative(getProjectRoot(), filePath);
}

/**
 * Strip JSONC comments from JSON string.
 * Handles single-line and multi-line style comments while preserving strings.
 */
function stripJsonComments(jsonString: string): string {
  let result = '';
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  let stringDelimiter = '';

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];
    const nextChar = jsonString[i + 1];
    const prevChar = i > 0 ? jsonString[i - 1] : '';

    // Toggle string state
    if (
      (char === '"' || char === "'") &&
      prevChar !== '\\' &&
      !inSingleLineComment &&
      !inMultiLineComment
    ) {
      if (!inString) {
        inString = true;
        stringDelimiter = char;
      } else if (char === stringDelimiter) {
        inString = false;
        stringDelimiter = '';
      }
    }

    // Skip comments but not inside strings
    if (!inString) {
      // Start of single-line comment
      if (char === '/' && nextChar === '/' && !inMultiLineComment) {
        inSingleLineComment = true;
        i++; // Skip next char
        continue;
      }

      // End of single-line comment
      if (inSingleLineComment && (char === '\n' || char === '\r')) {
        inSingleLineComment = false;
        result += char; // Keep the newline
        continue;
      }

      // Start of multi-line comment
      if (char === '/' && nextChar === '*' && !inSingleLineComment) {
        inMultiLineComment = true;
        i++; // Skip next char
        continue;
      }

      // End of multi-line comment
      if (inMultiLineComment && char === '*' && nextChar === '/') {
        inMultiLineComment = false;
        i++; // Skip next char
        continue;
      }

      // Skip characters inside comments
      if (inSingleLineComment || inMultiLineComment) {
        continue;
      }
    }

    result += char;
  }

  return result;
}

/**
 * Read and parse a JSON/JSONC file (supports comments)
 */
export function readJsonFile<T = any>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stripped = stripJsonComments(content);
    return substituteEnvTokens(JSON.parse(stripped)) as T;
  } catch (error) {
    logger.error({ error, filePath }, 'Failed to read JSON file');
    return null;
  }
}

/**
 * Check if a file exists
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Get the directory name of a file
 */
export function getDirname(filePath: string): string {
  return path.dirname(filePath);
}

/**
 * Join path segments
 */
export function joinPath(...segments: string[]): string {
  return path.join(...segments);
}
