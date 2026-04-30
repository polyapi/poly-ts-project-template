/**
 * Namespace validation utilities
 *
 * Enforces that all artifacts (schemas, webhooks, functions, triggers)
 * are properly namespaced within the required POLYAPI_NAMESPACE.
 */

import chalk from 'chalk';
import { logger } from './logger';

/**
 * Get the required namespace from environment variable
 * @throws Error if POLYAPI_NAMESPACE is not set
 */
export function getRequiredNamespace(): string {
  const namespace = process.env.POLYAPI_NAMESPACE;

  if (!namespace || namespace.trim() === '') {
    throw new Error(
      'POLYAPI_NAMESPACE environment variable is required but not set. ' +
        'Please set it in your .env file (e.g., POLYAPI_NAMESPACE=example)'
    );
  }

  return namespace.trim();
}

/**
 * Validate that a context string starts with the required namespace
 * @param context - The context string to validate (e.g., "example.workflow")
 * @param artifactType - The type of artifact being validated (for error messages)
 * @param artifactName - The name of the artifact being validated (for error messages)
 * @returns true if valid, throws error if invalid
 * @throws Error if context doesn't start with namespace
 */
export function validateNamespace(
  context: string,
  artifactType: string,
  artifactName: string
): boolean {
  const namespace = getRequiredNamespace();

  if (!context || typeof context !== 'string') {
    throw new Error(
      `${artifactType} "${artifactName}" has invalid context: context must be a non-empty string`
    );
  }

  // Allow either the required namespace or the internal namespace
  const validPattern = new RegExp(`^${escapeRegExp(namespace)}(\\.|$)`);

  if (!validPattern.test(context)) {
    throw new Error(
      `${artifactType} "${artifactName}" has invalid context "${context}". ` +
        `All contexts must start with namespace "${namespace}" ` +
        `(e.g., "${namespace}.module.submodule")`
    );
  }

  logger.debug(
    {
      artifactType,
      artifactName,
      context,
      namespace,
    },
    'Namespace validation passed'
  );

  return true;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Print namespace enforcement banner
 */
export function printNamespaceBanner(): void {
  const namespace = getRequiredNamespace();
  logger.info(chalk.gray(`Namespace: ${chalk.cyan(namespace)}`));
}
