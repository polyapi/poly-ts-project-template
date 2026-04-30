import { getExcludedOrphanContexts } from './deploymentConfig';

export function isOrphanContextExcluded(context?: string | null): boolean {
  if (!context) {
    return false;
  }

  const excludedContexts = getExcludedOrphanContexts();
  if (excludedContexts.length === 0) {
    return false;
  }

  return excludedContexts.some(
    excludedContext =>
      context === excludedContext || context.startsWith(`${excludedContext}.`)
  );
}

export function filterOrphansByContext<T extends { context?: string | null }>(
  candidates: T[]
): { included: T[]; excluded: T[] } {
  const included: T[] = [];
  const excluded: T[] = [];

  for (const candidate of candidates) {
    if (isOrphanContextExcluded(candidate.context)) {
      excluded.push(candidate);
    } else {
      included.push(candidate);
    }
  }

  return { included, excluded };
}
