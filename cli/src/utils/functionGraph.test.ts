import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FunctionFile } from '../types';
import {
  buildFunctionGraph,
  computeClosure,
  computeHubs,
  explainPaths,
  extractPolyReferences,
  orderForDeploy,
  renderTree,
  resolveReference,
  selectDeploySet,
} from './functionGraph';

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
  return buildFunctionGraph(
    entries.map(([entry]) => entry),
    filePath => sources.get(filePath) ?? ''
  );
}

const POLY_IMPORT = "import poly, { vari } from 'polyapi';\n";

describe('extractPolyReferences', () => {
  it('collects plain calls and member access on the default polyapi import', () => {
    const { refs, warnings } = extractPolyReferences(
      `${POLY_IMPORT}
       export async function run() {
         await poly.utilities.logging.logger('x');
         const r = await poly.OOB.ohip.reservations.search({});
         const cents = poly.utilities.money.toCents(1.5);
         return r;
       }`,
      'a.ts'
    );
    assert.deepEqual(refs, [
      'OOB.ohip.reservations.search',
      'utilities.logging.logger',
      'utilities.money.toCents',
    ]);
    assert.deepEqual(warnings, []);
  });

  it('follows aliases and destructuring', () => {
    const { refs } = extractPolyReferences(
      `${POLY_IMPORT}
       const res = poly.utilities.ohip.reservations;
       const { getChainCodeFromHotelCode: chain } = poly.utilities.general;
       const money = poly.utilities.money;
       export function run() { res.getDetails(1); chain('X'); money(); }`,
      'a.ts'
    );
    assert.deepEqual(refs, [
      'utilities.general.getChainCodeFromHotelCode',
      'utilities.money',
      'utilities.ohip.reservations.getDetails',
    ]);
  });

  it('sees through casts and parentheses inside the chain', () => {
    const { refs } = extractPolyReferences(
      `${POLY_IMPORT}
       export async function run() {
         await (poly.aiKnowledgeHub as any).getHotels({});
         await (
           poly.aiKnowledgeHub as any
         ).resolveInternalReservationIds([]);
         const money = await (poly as any).utilities.money();
         return (poly.utilities.general.sanitizeString as any)!('x');
       }`,
      'a.ts'
    );
    assert.deepEqual(refs, [
      'aiKnowledgeHub.getHotels',
      'aiKnowledgeHub.resolveInternalReservationIds',
      'utilities.general.sanitizeString',
      'utilities.money',
    ]);
  });

  it('warns on computed access and records the static prefix', () => {
    const { refs, warnings } = extractPolyReferences(
      `${POLY_IMPORT}
       export function run(name: string) { return poly.utilities.general[name](); }`,
      'a.ts'
    );
    assert.deepEqual(refs, ['utilities.general.*']);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('computed access'));
  });

  it('returns nothing without a polyapi default import', () => {
    assert.deepEqual(
      extractPolyReferences(
        "import { vari } from 'polyapi';\nexport const x = vari.a.b.get();",
        'a.ts'
      ).refs,
      []
    );
    assert.deepEqual(
      extractPolyReferences(
        'const poly = { a: { b: 1 } };\nexport const x = poly.a.b;',
        'a.ts'
      ).refs,
      []
    );
  });

  it('follows destructured call results and nested namespace destructuring', () => {
    const { refs } = extractPolyReferences(
      `${POLY_IMPORT}
       const { utilities: { money } } = poly;
       export async function run() {
         const { data } = await poly.utilities.general.normalizeEmailList([]);
         const { count } = poly.utilities.general.sanitizeString('x');
         return money.toCents(data + count);
       }`,
      'a.ts'
    );
    assert.deepEqual(refs, [
      'utilities.general.normalizeEmailList',
      'utilities.general.sanitizeString',
      'utilities.money.toCents',
    ]);
  });

  it('resolves an alias declared after its use', () => {
    const { refs } = extractPolyReferences(
      `${POLY_IMPORT}
       export function run() { return res.getDetails(1); }
       const res = poly.utilities.ohip.reservations;`,
      'a.ts'
    );
    assert.deepEqual(refs, ['utilities.ohip.reservations.getDetails']);
  });

  it('resolves chained aliases in any declaration order', () => {
    const { refs } = extractPolyReferences(
      `${POLY_IMPORT}
       export function run() {
         const z = y.money.toCents;
         const y = x.utilities;
         const x = poly;
         return z(150);
       }`,
      'a.ts'
    );
    assert.deepEqual(refs, ['utilities.money.toCents']);
  });

  it('tracks poly namespaces handed to same-file functions as arguments', () => {
    const { refs, forwarded } = extractPolyReferences(
      `${POLY_IMPORT}
       function helper(u: any) { return u.money.toCents(150); }
       const arrow = (p: any) => p.utilities.general.sanitizeString('x');
       function outer(ns: any) { return inner(ns); }
       function inner(v: any) { return v.logging.logger('x'); }
       export async function run() {
         helper(poly.utilities);
         arrow(poly);
         return outer(poly.utilities);
       }`,
      'a.ts'
    );
    assert.deepEqual(refs, [
      'utilities',
      'utilities.general.sanitizeString',
      'utilities.logging.logger',
      'utilities.money.toCents',
    ]);
    assert.deepEqual(forwarded, ['utilities']);
  });

  it('lets an unbound parameter shadow a file-level alias', () => {
    const { refs } = extractPolyReferences(
      `${POLY_IMPORT}
       const z = poly.utilities.money.toCents;
       function other(z: any) { return z(); }
       export function run() { return other(() => 1); }`,
      'a.ts'
    );
    assert.deepEqual(refs, []);
  });

  it('honours a renamed default import', () => {
    const { refs } = extractPolyReferences(
      "import p from 'polyapi';\nexport const run = () => p.services.x.y();",
      'a.ts'
    );
    assert.deepEqual(refs, ['services.x.y']);
  });
});

describe('resolveReference', () => {
  const keys = new Map([
    ['utilities.money', 'utilities.money'],
    [
      'utilities.ohip.reservations.getdetails',
      'utilities.ohip.reservations.getDetails',
    ],
  ]);

  it('matches exactly, case-insensitively, then by longest prefix', () => {
    assert.equal(
      resolveReference('utilities.ohip.reservations.GetDetails', keys),
      'utilities.ohip.reservations.getDetails'
    );
    assert.equal(
      resolveReference('utilities.money.toCents', keys),
      'utilities.money'
    );
    assert.equal(
      resolveReference('utilities.general.sanitizeString', keys),
      undefined
    );
    assert.equal(resolveReference('utilities', keys), undefined);
  });
});

describe('buildFunctionGraph / computeClosure / orderForDeploy', () => {
  // seed CFX ← mid CFX ← sfxA ; seed ← sfxB ; sfxB ← sfxC (HTTP) ; unrelated SFX
  const entries = [
    file(
      'utilities.core',
      'seed',
      'client',
      `${POLY_IMPORT}export const seed = () => poly.utilities.logging.logger('s');`
    ),
    file(
      'utilities.logging',
      'logger',
      'client',
      `${POLY_IMPORT}export const logger = () => 1;`
    ),
    file(
      'utilities.core',
      'mid',
      'client',
      `${POLY_IMPORT}export const mid = () => poly.utilities.core.seed();`
    ),
    file(
      'services.a',
      'sfxA',
      'server',
      `${POLY_IMPORT}export const sfxA = () => poly.utilities.core.mid();`
    ),
    file(
      'services.b',
      'sfxB',
      'server',
      `${POLY_IMPORT}export const sfxB = () => poly.utilities.core.seed();`
    ),
    file(
      'services.c',
      'sfxC',
      'server',
      `${POLY_IMPORT}export const sfxC = () => poly.services.b.sfxB();`
    ),
    file(
      'services.d',
      'other',
      'server',
      `${POLY_IMPORT}export const other = () => poly.OOB.x.y();`
    ),
  ];
  const graph = graphOf(entries);

  it('builds edges only between local functions', () => {
    assert.equal(graph.nodes.size, 7);
    assert.equal(graph.edgeCount, 5);
    assert.deepEqual(
      [...(graph.nodes.get('utilities.core.seed')?.dependents ?? [])].sort(),
      ['services.b.sfxB', 'utilities.core.mid']
    );
    assert.deepEqual([...graph.externalRefs.keys()], ['OOB.x.y']);
    assert.equal(graph.ambiguousRefs.size, 0);
  });

  it('stops the closure at server functions and classifies nodes', () => {
    const closure = computeClosure(graph, ['utilities.core.seed']);
    assert.deepEqual([...closure.nodes.keys()].sort(), [
      'services.a.sfxA',
      'services.b.sfxB',
      'utilities.core.mid',
      'utilities.core.seed',
    ]);
    assert.equal(
      closure.nodes.get('utilities.core.mid')?.reason,
      'intermediate'
    );
    assert.equal(closure.nodes.get('services.a.sfxA')?.reason, 'leaf');
    assert.deepEqual(closure.nodes.get('services.b.sfxB')?.via, [
      'utilities.core.seed',
    ]);
    // sfxC calls sfxB over HTTP: never part of the closure
    assert.equal(closure.nodes.has('services.c.sfxC'), false);
  });

  it('does not propagate from a server-function seed unless --through-sfx', () => {
    assert.deepEqual(
      [...computeClosure(graph, ['services.b.sfxB']).nodes.keys()],
      ['services.b.sfxB']
    );
    const through = computeClosure(graph, ['services.b.sfxB'], {
      throughSfx: true,
    });
    assert.deepEqual([...through.nodes.keys()].sort(), [
      'services.b.sfxB',
      'services.c.sfxC',
    ]);
  });

  it('merges overlapping trees from several seeds', () => {
    const closure = computeClosure(graph, [
      'utilities.logging.logger',
      'utilities.core.seed',
    ]);
    assert.deepEqual(closure.nodes.get('services.a.sfxA')?.via.sort(), [
      'utilities.core.seed',
      'utilities.logging.logger',
    ]);
    assert.equal(closure.nodes.get('utilities.core.seed')?.reason, 'seed');
  });

  it('selects the deploy set and orders callees first', () => {
    const closure = computeClosure(graph, ['utilities.core.seed']);
    assert.deepEqual(selectDeploySet(closure, false).sort(), [
      'services.a.sfxA',
      'services.b.sfxB',
      'utilities.core.seed',
    ]);

    const whole = orderForDeploy(graph, selectDeploySet(closure, true));
    assert.deepEqual(whole.cyclic, []);
    assert.deepEqual(whole.order, [
      'utilities.core.seed',
      'utilities.core.mid',
      'services.a.sfxA',
      'services.b.sfxB',
    ]);
  });

  it('reports cycles instead of hanging', () => {
    const cyclic = graphOf([
      file(
        'utilities.x',
        'a',
        'client',
        `${POLY_IMPORT}export const a = () => poly.utilities.x.b();`
      ),
      file(
        'utilities.x',
        'b',
        'client',
        `${POLY_IMPORT}export const b = () => poly.utilities.x.a();`
      ),
    ]);
    const { order, cyclic: stuck } = orderForDeploy(cyclic, [
      'utilities.x.a',
      'utilities.x.b',
    ]);
    assert.deepEqual(stuck, ['utilities.x.a', 'utilities.x.b']);
    assert.equal(order.length, 2);
  });

  it('reports only the members of a cycle and still orders what depends on it', () => {
    // a <-> b form a cycle; c depends on b; d is independent.
    const withCycle = graphOf([
      file(
        'utilities.x',
        'a',
        'client',
        `${POLY_IMPORT}export const a = () => poly.utilities.x.b();`
      ),
      file(
        'utilities.x',
        'b',
        'client',
        `${POLY_IMPORT}export const b = () => poly.utilities.x.a();`
      ),
      file(
        'services.x',
        'c',
        'server',
        `${POLY_IMPORT}export const c = () => poly.utilities.x.b();`
      ),
      file('utilities.x', 'd', 'client', 'export const d = 1;'),
    ]);
    const { order, cyclic } = orderForDeploy(withCycle, withCycle.nodes.keys());
    assert.deepEqual(cyclic, ['utilities.x.a', 'utilities.x.b']);
    assert.ok(order.indexOf('services.x.c') > order.indexOf('utilities.x.b'));
    assert.equal(order.length, 4);
  });

  it('rejects duplicate identities and warns on prefix identities', () => {
    assert.throws(
      () =>
        graphOf([
          file('utilities.x', 'a', 'client', 'export const a = 1;'),
          file('utilities.x', 'a', 'server', 'export const a = 1;'),
        ]),
      /Duplicate function identity/
    );

    const prefixed = graphOf([
      file('utilities', 'money', 'client', 'export const money = 1;'),
      file('utilities.money', 'round', 'client', 'export const round = 1;'),
    ]);
    assert.ok(
      prefixed.warnings.some(warning => warning.includes('is a prefix of'))
    );
  });

  it('flags bare context references as ambiguous', () => {
    const ambiguous = graphOf([
      file('utilities.general', 'a', 'client', 'export const a = 1;'),
      file(
        'services.s',
        'caller',
        'server',
        `${POLY_IMPORT}export const caller = (h: any) => h(poly.utilities.general);`
      ),
    ]);
    assert.deepEqual(
      [...ambiguous.ambiguousRefs.keys()],
      ['utilities.general']
    );
    assert.equal(ambiguous.edgeCount, 0);
  });

  it('creates edges through namespaces forwarded to same-file functions', () => {
    const forwardedGraph = graphOf([
      file('utilities', 'money', 'client', 'export const money = 1;'),
      file(
        'services.s',
        'caller',
        'server',
        `${POLY_IMPORT}
         function helper(u: any) { return u.money.toCents(1); }
         export const caller = () => helper(poly.utilities);`
      ),
    ]);
    assert.deepEqual(
      [...(forwardedGraph.nodes.get('services.s.caller')?.deps ?? [])],
      ['utilities.money']
    );
    assert.equal(forwardedGraph.ambiguousRefs.size, 0);
    assert.equal(forwardedGraph.externalRefs.size, 0);
  });

  it('treats a computed root segment as ambiguous, not external', () => {
    const computed = graphOf([
      file('utilities.general', 'a', 'client', 'export const a = 1;'),
      file(
        'services.s',
        'caller',
        'server',
        `${POLY_IMPORT}export const caller = (ctx: string) => (poly as any)[ctx].foo();`
      ),
      file(
        'services.t',
        'oob',
        'server',
        `${POLY_IMPORT}export const oob = (x: string) => poly.OOB[x].foo();`
      ),
    ]);
    assert.deepEqual([...computed.ambiguousRefs.keys()], ['*.foo']);
    assert.deepEqual([...computed.externalRefs.keys()], ['OOB.*.foo']);
    assert.equal(
      computed.warnings.filter(warning => warning.includes('computed access'))
        .length,
      2
    );
  });

  it('reports when --why chains are truncated', () => {
    const fan = graphOf([
      file('utilities.x', 'seed', 'client', 'export const seed = 1;'),
      ...['a', 'b', 'c'].map(name =>
        file(
          'utilities.x',
          name,
          'client',
          `${POLY_IMPORT}export const ${name} = () => poly.utilities.x.seed();`
        )
      ),
      file(
        'services.x',
        'sfx',
        'server',
        `${POLY_IMPORT}export const sfx = () => [poly.utilities.x.a(), poly.utilities.x.b(), poly.utilities.x.c()];`
      ),
    ]);
    const limited = explainPaths(
      fan,
      ['utilities.x.seed'],
      'services.x.sfx',
      2
    );
    assert.equal(limited.paths.length, 2);
    assert.equal(limited.truncated, true);
    assert.equal(
      explainPaths(fan, ['utilities.x.seed'], 'services.x.sfx', 3).truncated,
      false
    );
  });

  it('keeps callee-first order between seeds linked only through a skipped intermediate', () => {
    const chain = graphOf([
      file('utilities.x', 'zeta', 'client', 'export const zeta = 1;'),
      file(
        'utilities.x',
        'mid',
        'client',
        `${POLY_IMPORT}export const mid = () => poly.utilities.x.zeta();`
      ),
      file(
        'utilities.x',
        'alpha',
        'client',
        `${POLY_IMPORT}export const alpha = () => poly.utilities.x.mid();`
      ),
    ]);
    const closure = computeClosure(chain, [
      'utilities.x.zeta',
      'utilities.x.alpha',
    ]);
    const deploySet = new Set(selectDeploySet(closure, false));
    const order = orderForDeploy(chain, closure.nodes.keys()).order.filter(
      key => deploySet.has(key)
    );
    assert.deepEqual(order, ['utilities.x.zeta', 'utilities.x.alpha']);
  });

  it('computes hubs, explains paths and renders the tree', () => {
    const hubs = computeHubs(graph);
    assert.deepEqual(hubs[0], {
      key: 'utilities.logging.logger',
      cfxCallers: 2,
      sfxLeaves: 2,
    });

    assert.deepEqual(
      explainPaths(graph, ['utilities.logging.logger'], 'services.a.sfxA'),
      {
        paths: [
          [
            'utilities.logging.logger',
            'utilities.core.seed',
            'utilities.core.mid',
            'services.a.sfxA',
          ],
        ],
        truncated: false,
      }
    );

    const closure = computeClosure(graph, ['utilities.core.seed']);
    const tree = renderTree(graph, closure, {
      annotate: key => (key.startsWith('services.') ? 'leaf' : ''),
    });
    assert.deepEqual(tree, [
      'utilities.core.seed  [CFX]',
      '├─ services.b.sfxB  [SFX]  leaf',
      '└─ utilities.core.mid  [CFX]',
      '   └─ services.a.sfxA  [SFX]  leaf',
    ]);
  });
});

describe('repository graph', () => {
  const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
  const functionsRoot = path.join(workspaceRoot, 'workflows', 'src');

  function walk(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, out);
      } else if (
        entry.endsWith('.ts') &&
        !entry.endsWith('.test.ts') &&
        /\/(client|server)\//.test(full.replace(/\\/g, '/'))
      ) {
        out.push(full);
      }
    }
    return out;
  }

  const files: FunctionFile[] = walk(functionsRoot, []).flatMap(tsFilePath => {
    const source = readFileSync(tsFilePath, 'utf8');
    const config =
      source.match(/const polyConfig[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
    const name = config.match(/\bname:\s*['"]([^'"]+)['"]/)?.[1];
    const context = config.match(/\bcontext:\s*['"]([^'"]+)['"]/)?.[1];
    if (!name || !context) {
      return [];
    }
    const type: FunctionFile['type'] = tsFilePath
      .replace(/\\/g, '/')
      .includes('/server/')
      ? 'server'
      : 'client';
    return [{ tsFilePath, type, metadata: { name, context, description: '' } }];
  });

  it('builds a graph over the checked-in sample functions without ambiguity', () => {
    const graph = buildFunctionGraph(files, filePath =>
      readFileSync(filePath, 'utf8')
    );
    assert.equal(graph.nodes.size, files.length);
    assert.ok(graph.nodes.size > 0);
    assert.deepEqual([...graph.ambiguousRefs.keys()], []);
    assert.deepEqual(
      graph.warnings.filter(warning => warning.includes('computed access')),
      []
    );
  });
});
