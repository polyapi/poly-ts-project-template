import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FunctionFile } from '../types';
import { buildFunctionGraph, computeClosure } from './functionGraph';
import {
  expandWildcardReferences,
  matchWildcardCandidates,
  stripComments,
} from './wildcardEdges';

const POLY_IMPORT = "import poly from 'polyapi';\n";

function file(
  context: string,
  name: string,
  type: FunctionFile['type'],
  source: string
): [FunctionFile, string] {
  return [
    {
      tsFilePath: `/repo/${type}/${context}.${name}.ts`,
      type,
      metadata: { name, context, description: '' },
    },
    source,
  ];
}

function graphOf(entries: Array<[FunctionFile, string]>) {
  const sources = new Map(
    entries.map(([entry, source]) => [entry.tsFilePath, source])
  );
  const readSource = (filePath: string) => sources.get(filePath) ?? '';
  return {
    graph: buildFunctionGraph(
      entries.map(([entry]) => entry),
      readSource
    ),
    readSource,
  };
}

describe('matchWildcardCandidates', () => {
  const keys = [
    'utilities.money',
    'utilities.general.toCents',
    'utilities.general.sanitizeString',
    'utilities.ohip.reservations.getDetails',
    'services.x.run',
  ];
  const hasMember = (key: string, member: string) =>
    key === 'utilities.money' && member === 'toCents';

  it('matches identities position by position, one segment per wildcard', () => {
    assert.deepEqual(
      matchWildcardCandidates('utilities.*.toCents', keys, hasMember),
      [
        { key: 'utilities.general.toCents', reason: 'identity' },
        { key: 'utilities.money', reason: 'member' },
      ]
    );
    assert.deepEqual(
      matchWildcardCandidates('utilities.general.*', keys, hasMember).map(
        c => c.key
      ),
      ['utilities.general.sanitizeString', 'utilities.general.toCents']
    );
    assert.deepEqual(matchWildcardCandidates('utilities.*', keys, hasMember), [
      { key: 'utilities.money', reason: 'identity' },
    ]);
    assert.deepEqual(
      matchWildcardCandidates('utilities.*.round', keys, hasMember),
      []
    );
    assert.deepEqual(matchWildcardCandidates('*.x.run', keys, hasMember), [
      { key: 'services.x.run', reason: 'identity' },
    ]);
  });
});

describe('expandWildcardReferences', () => {
  it('turns computed access into edges to every plausible function', () => {
    const { graph, readSource } = graphOf([
      file(
        'utilities',
        'money',
        'client',
        'export function money() { return { toCents: (v: number) => v * 100 }; }'
      ),
      file(
        'utilities.general',
        'toCents',
        'client',
        'export const toCents = (v: number) => v;'
      ),
      file(
        'utilities.general',
        'sanitizeString',
        'client',
        'export const sanitizeString = (s: string) => s;'
      ),
      file(
        'services.s',
        'caller',
        'server',
        `${POLY_IMPORT}export const caller = (key: string) => poly.utilities[key].toCents(1);`
      ),
      file(
        'services.t',
        'oob',
        'server',
        `${POLY_IMPORT}export const oob = (x: string) => poly.OOB[x].foo();`
      ),
    ]);
    assert.equal(graph.edgeCount, 0);
    assert.deepEqual([...graph.ambiguousRefs.keys()], ['utilities.*.toCents']);

    const expansion = expandWildcardReferences(graph, readSource);
    assert.deepEqual(
      expansion.added.map(
        edge => `${edge.from} -> ${edge.to} (${edge.reason})`
      ),
      [
        'services.s.caller -> utilities.general.toCents (identity)',
        'services.s.caller -> utilities.money (member)',
      ]
    );
    assert.deepEqual(expansion.unmatched, [
      { ref: 'OOB.*.foo', file: '/repo/server/services.t.oob.ts' },
    ]);
    assert.equal(graph.edgeCount, 2);

    // The closure now reaches the caller from either candidate.
    assert.deepEqual(
      [...computeClosure(graph, ['utilities.money']).nodes.keys()],
      ['utilities.money', 'services.s.caller']
    );
    assert.deepEqual(
      [
        ...computeClosure(graph, [
          'utilities.general.sanitizeString',
        ]).nodes.keys(),
      ],
      ['utilities.general.sanitizeString']
    );
  });
});

describe('stripComments', () => {
  it('blanks line, block and JSDoc comments but keeps code and strings', () => {
    const source = [
      '/** returns toCents (jsdoc) */',
      'export function money() {',
      '  // toCents in a line comment',
      "  const url = 'http://example.com/toCents'; /* toCents in a block */",
      '  const pattern = /https?:\\/\\//;',
      '  return { fromCents: (v: number) => v / 100, url, pattern };',
      '}',
      'function empty() { /* toCents */ }',
      '// trailing toCents',
    ].join('\n');
    const stripped = stripComments(source);
    assert.equal(stripped.length, source.length);
    assert.ok(!stripped.includes('jsdoc'));
    assert.ok(!stripped.includes('line comment'));
    assert.ok(!stripped.includes('in a block'));
    assert.ok(!stripped.includes('trailing toCents'));
    assert.doesNotMatch(stripped, /empty\(\) \{\s*toCents/);
    assert.ok(stripped.includes("'http://example.com/toCents'"));
    assert.ok(stripped.includes('/https?:\\/\\//'));
    assert.ok(stripped.includes('fromCents'));
  });

  it('ignores members mentioned only in comments when matching wildcard candidates', () => {
    const { graph, readSource } = graphOf([
      file(
        'utilities',
        'money',
        'client',
        '/** provides toCents */\nexport function money() { // toCents\n return { round: (v: number) => v }; }'
      ),
      file(
        'utilities',
        'cents',
        'client',
        'export function cents() { return { toCents: (v: number) => v * 100 }; }'
      ),
      file(
        'services.s',
        'caller',
        'server',
        `${POLY_IMPORT}export const caller = (key: string) => poly.utilities[key].toCents(1);`
      ),
    ]);
    const expansion = expandWildcardReferences(graph, readSource);
    assert.deepEqual(
      expansion.added.map(edge => edge.to),
      ['utilities.cents']
    );
  });
});
