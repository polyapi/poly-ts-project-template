/**
 * EXPERIMENTAL — wildcard expansion for computed poly access.
 *
 * Only active with `flow push-dynamic --experimental-wildcards`. Deliberately
 * self-contained so it can be removed by deleting this file,
 * `cli/src/utils/wildcardEdges.test.ts`, the flag in `cli/src/cli.ts`, the single
 * call in `cli/src/commands/pushDynamic.ts` and the section in
 * `cli/push-dynamic.md`.
 *
 * The extractor turns `poly.utilities[key].toCents(...)` into the reference
 * `utilities.*.toCents` and warns that it cannot be resolved statically. The
 * set of deployable functions is closed, though, so every possibility can be
 * enumerated: a function identity is a candidate when its segments match the
 * reference position by position, `*` standing for exactly one segment.
 *
 *  - an identity as long as the reference matches directly
 *    (`utilities.general.toCents` for `utilities.*.toCents`);
 *  - a shorter identity leaves the remaining segments as member access on the
 *    function's result (`utilities.money` + `.toCents`), and is kept only when
 *    the function's source mentions that member outside comments — a textual
 *    heuristic that errs towards deploying more, never less.
 *
 * Matching candidates become ordinary edges of the graph, so the closure,
 * ordering and plan treat them like any other call. Worst case is
 * over-deploying; the graph never drops a real edge because of this.
 */

import ts from 'typescript';
import type { FunctionGraph, GraphNode } from './functionGraph';

export type WildcardMatchReason = 'identity' | 'member';

export interface WildcardCandidate {
  key: string;
  reason: WildcardMatchReason;
}

export interface WildcardEdge {
  from: string;
  to: string;
  ref: string;
  reason: WildcardMatchReason;
}

export interface WildcardExpansion {
  added: WildcardEdge[];
  /** Computed references for which no function could match. */
  unmatched: Array<{ ref: string; file: string }>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The source with every comment (line, block and JSDoc) blanked out, so a
 * member name that only appears in a comment does not count as a mention.
 * Uses the parser's comment ranges rather than scanning for `//` and `/*`,
 * so a `//` inside a string or a regular expression is left alone.
 */
export function stripComments(
  source: string,
  fileName: string = 'source.ts'
): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS
  );
  const ranges = new Map<number, number>();
  const collect = (comments: ts.CommentRange[] | undefined): void => {
    for (const comment of comments ?? []) {
      ranges.set(comment.pos, comment.end);
    }
  };
  // Walk tokens as well as nodes: a comment inside an empty block is trivia
  // of the closing brace token, which a node-only walk never visits.
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) {
      visit(child);
    }
  };
  visit(sourceFile);
  collect(
    ts.getLeadingCommentRanges(source, sourceFile.endOfFileToken.getFullStart())
  );

  let stripped = source;
  for (const [pos, end] of [...ranges.entries()].sort(
    (left, right) => right[0] - left[0]
  )) {
    stripped = `${stripped.slice(0, pos)}${' '.repeat(end - pos)}${stripped.slice(end)}`;
  }
  return stripped;
}

/**
 * Functions a wildcard reference could stand for. `hasMember(key, member)`
 * decides whether a shorter identity's result plausibly exposes `member`.
 */
export function matchWildcardCandidates(
  ref: string,
  keys: Iterable<string>,
  hasMember: (key: string, member: string) => boolean
): WildcardCandidate[] {
  const parts = ref.split('.');
  const lowerParts = parts.map(part => part.toLowerCase());
  const candidates: WildcardCandidate[] = [];

  for (const key of keys) {
    const segments = key.toLowerCase().split('.');
    if (segments.length > parts.length) {
      continue;
    }
    const aligned = segments.every(
      (segment, index) =>
        lowerParts[index] === '*' || lowerParts[index] === segment
    );
    if (!aligned) {
      continue;
    }
    if (segments.length === parts.length) {
      candidates.push({ key, reason: 'identity' });
      continue;
    }
    const member = parts[segments.length];
    if (member !== '*' && hasMember(key, member)) {
      candidates.push({ key, reason: 'member' });
    }
  }

  return candidates.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Add an edge for every candidate of every computed reference in the graph.
 * Mutates the graph's `deps`/`dependents` sets and `edgeCount`.
 */
export function expandWildcardReferences(
  graph: FunctionGraph,
  readSource: (filePath: string) => string
): WildcardExpansion {
  const nodesByFile = new Map<string, GraphNode>(
    [...graph.nodes.values()].map(node => [node.filePath, node])
  );
  const sourceCache = new Map<string, string>();
  const hasMember = (key: string, member: string): boolean => {
    const node = graph.nodes.get(key);
    if (!node) {
      return false;
    }
    let source = sourceCache.get(node.filePath);
    if (source === undefined) {
      source = stripComments(readSource(node.filePath), node.filePath);
      sourceCache.set(node.filePath, source);
    }
    return new RegExp(`\\b${escapeRegExp(member)}\\b`).test(source);
  };

  const added: WildcardEdge[] = [];
  const unmatched: Array<{ ref: string; file: string }> = [];
  const computedRefs = [...graph.ambiguousRefs, ...graph.externalRefs].filter(
    ([ref]) => ref.includes('*')
  );

  for (const [ref, files] of computedRefs) {
    const candidates = matchWildcardCandidates(
      ref,
      graph.nodes.keys(),
      hasMember
    );
    for (const file of files) {
      const node = nodesByFile.get(file);
      if (!node) {
        continue;
      }
      const applicable = candidates.filter(
        candidate => candidate.key !== node.key
      );
      if (applicable.length === 0) {
        unmatched.push({ ref, file });
        continue;
      }
      for (const candidate of applicable) {
        if (node.deps.has(candidate.key)) {
          continue;
        }
        node.deps.add(candidate.key);
        graph.nodes.get(candidate.key)?.dependents.add(node.key);
        graph.edgeCount += 1;
        added.push({
          from: node.key,
          to: candidate.key,
          ref,
          reason: candidate.reason,
        });
      }
    }
  }

  return { added, unmatched };
}
