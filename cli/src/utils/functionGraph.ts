/**
 * Poly function call graph (pure module, no I/O beyond the injected reader).
 *
 * Backs the `flow push-dynamic` command. Every
 * deployed function in this repo is a TypeScript file with an inline
 * `polyConfig`, identified on the platform by `<context>.<name>`. Functions
 * call each other exclusively through `poly.<context>.<name>(...)` on the
 * default `polyapi` import, so the call graph can be extracted statically:
 *
 *  - references are collected with the TypeScript AST (property/element
 *    access chains rooted at the `polyapi` default import, following
 *    `const x = poly.a.b` aliases, object destructuring, `poly`/`poly.a`
 *    objects handed to same-file functions as arguments (the parameter is
 *    tracked inside that function, transitively), and casts such as
 *    `(poly.a as any).b(...)` — the platform's own extractor silently drops
 *    edges through casts and through destructured call results such as
 *    `const { x } = await poly.a.b(...)`, which is why its dependency data
 *    cannot be relied on);
 *  - references resolve to local functions by exact, then longest-prefix,
 *    case-insensitive match (`poly.utilities.money.toCents(...)` is a member
 *    of the `utilities.money` return value, not a function of its own);
 *  - anything that resolves to no local function is external (OOB adapters,
 *    custom API functions, `vari`/`tabi`/`schemas` are never edges).
 *
 * Propagation rule (verified against the polyapi package source): a client
 * function's code is embedded in the generated poly library that a server
 * function bundles, nested CFX→CFX calls resolve inside that same library,
 * while SFX→SFX and CFX→SFX calls are HTTP at runtime. So a changed CFX
 * affects its transitive CFX callers up to the first server function on each
 * path, and propagation stops there.
 */

import ts from 'typescript';
import type { FunctionFile } from '../types';

export type FunctionType = FunctionFile['type'];

export interface GraphNode {
  key: string;
  name: string;
  context: string;
  type: FunctionType;
  filePath: string;
  /** Keys of local functions this function calls. */
  deps: Set<string>;
  /** Keys of local functions that call this function. */
  dependents: Set<string>;
}

export interface ExtractedReferences {
  /** `poly.` prefix stripped, e.g. `utilities.logging.logger`. */
  refs: string[];
  /**
   * Subset of `refs` recorded from arguments handed to a same-file function
   * whose parameter is tracked (`helper(poly.utilities)`): usually bare
   * namespaces, whose real uses are recorded inside that function instead.
   */
  forwarded: string[];
  warnings: string[];
}

export interface FunctionGraph {
  nodes: Map<string, GraphNode>;
  edgeCount: number;
  /** References matching no local function (OOB, custom API functions, ...) → files using them. */
  externalRefs: Map<string, string[]>;
  /** References that only prefix local function keys (possible dynamic dispatch) → files using them. */
  ambiguousRefs: Map<string, string[]>;
  warnings: string[];
}

export type ClosureReason = 'seed' | 'leaf' | 'intermediate';

export interface ClosureNode {
  key: string;
  type: FunctionType;
  reason: ClosureReason;
  /** Seeds this node was reached from (empty for seeds themselves). */
  via: string[];
}

export interface Closure {
  seeds: string[];
  nodes: Map<string, ClosureNode>;
}

export interface ClosureOptions {
  /** Keep expanding past server functions (report-only use; code never propagates through an SFX). */
  throughSfx?: boolean;
}

export interface DeployOrder {
  order: string[];
  /** Nodes that were part of a cycle and appended without a dependency order. */
  cyclic: string[];
}

export interface HubEntry {
  key: string;
  cfxCallers: number;
  sfxLeaves: number;
}

export function functionKey(context: string, name: string): string {
  return `${context}.${name}`;
}

function isWrapper(
  node: ts.Node
): node is
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.NonNullExpression
  | ts.TypeAssertion
  | ts.SatisfiesExpression {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (isWrapper(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Dotted path of a member-access chain rooted at an identifier, or null when
 * the chain is rooted at something else (a call result, `this`, a literal).
 * Casts and parentheses anywhere in the chain are transparent; a computed
 * element access contributes a `*` segment.
 */
function propertyPath(expression: ts.Expression): string | null {
  const parts: string[] = [];
  let current = unwrap(expression);

  while (true) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = unwrap(current.expression);
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      const argument = unwrap(current.argumentExpression);
      if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) {
        parts.unshift(argument.text);
      } else {
        parts.unshift('*');
      }
      current = unwrap(current.expression);
      continue;
    }
    if (ts.isIdentifier(current)) {
      parts.unshift(current.text);
      return parts.join('.');
    }
    return null;
  }
}

/** True when this access is the object of an enclosing member access (`poly.a` inside `poly.a.b`, casts transparent). */
function isInnerChainPart(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent && isWrapper(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) {
    return false;
  }
  if (
    ts.isPropertyAccessExpression(parent) ||
    ts.isElementAccessExpression(parent)
  ) {
    return parent.expression === current;
  }
  return false;
}

/** An identifier that is a value reference (not a declaration name, property name or type). */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (
    ts.isPropertyAccessExpression(parent) ||
    ts.isElementAccessExpression(parent) ||
    ts.isQualifiedName(parent)
  ) {
    return false;
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent)
  ) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  if (
    ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isTypeReferenceNode(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent)
  ) {
    return false;
  }
  return true;
}

function describeLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return `${sourceFile.fileName}:${line + 1}`;
}

type FunctionLike = ts.SignatureDeclaration & {
  parameters: ts.NodeArray<ts.ParameterDeclaration>;
};

function addAll(target: Set<string>, values: Iterable<string>): boolean {
  let changed = false;
  for (const value of values) {
    if (!target.has(value)) {
      target.add(value);
      changed = true;
    }
  }
  return changed;
}

/**
 * Collect every `poly.<path>` reference in a function file.
 *
 * Aliases are resolved to a fixed point: `const x = poly; const y = x.utilities`
 * works in any declaration order, and a `poly`/`poly.a` value passed to a
 * function declared in the same file binds that function's parameter for the
 * calls inside its body (`helper(poly.utilities)` + `u.money.toCents()` inside
 * `helper` yields `utilities.money.toCents`). A parameter that is declared but
 * never bound shadows any file-level alias of the same name.
 */
export function extractPolyReferences(
  source: string,
  filePath: string
): ExtractedReferences {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TS
  );
  const refs = new Set<string>();
  const forwarded = new Set<string>();
  const warnings: string[] = [];
  /** File-level aliases: local name → resolved poly paths (a name may collect several). */
  const aliases = new Map<string, Set<string>>();
  /** Initializers that only name a poly namespace for an alias — not references themselves. */
  const aliasInitializers = new Set<ts.Node>();
  /** Parameter bindings per same-file function: function node → parameter name → poly paths. */
  const parameterBindings = new Map<ts.Node, Map<string, Set<string>>>();
  /** Functions declared in this file, by name (declarations plus const-assigned arrow/function expressions). */
  const localFunctions = new Map<string, FunctionLike[]>();
  let polyIdentifier: string | null = null;

  const isPolyPath = (dottedPath: string): boolean =>
    polyIdentifier !== null &&
    (dottedPath === polyIdentifier ||
      dottedPath.startsWith(`${polyIdentifier}.`));

  const enclosingFunctions = (node: ts.Node): FunctionLike[] => {
    const result: FunctionLike[] = [];
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isFunctionLike(current)) {
        result.push(current as FunctionLike);
      }
      current = current.parent;
    }
    return result;
  };

  const parameterName = (
    parameter: ts.ParameterDeclaration | undefined
  ): string | null =>
    parameter && ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken
      ? parameter.name.text
      : null;

  /**
   * Poly paths a root identifier stands for at this position: the bindings of
   * the innermost enclosing function that declares a parameter of that name
   * (declared but unbound → shadowed → none), else the file-level aliases.
   */
  const resolveRoot = (root: string, node: ts.Node): string[] | null => {
    for (const fn of enclosingFunctions(node)) {
      if (
        fn.parameters.some(
          parameter =>
            ts.isIdentifier(parameter.name) && parameter.name.text === root
        )
      ) {
        const bound = parameterBindings.get(fn)?.get(root);
        return bound && bound.size > 0 ? [...bound] : null;
      }
    }
    const alias = aliases.get(root);
    return alias && alias.size > 0 ? [...alias] : null;
  };

  const resolvePaths = (dottedPath: string, node: ts.Node): string[] => {
    const [root, ...rest] = dottedPath.split('.');
    const targets = resolveRoot(root, node);
    return targets
      ? targets.map(target => [target, ...rest].join('.'))
      : [dottedPath];
  };

  const setAlias = (name: string, targets: string[]): boolean => {
    let set = aliases.get(name);
    if (!set) {
      set = new Set();
      aliases.set(name, set);
    }
    return addAll(set, targets);
  };

  const registerBindingPattern = (
    pattern: ts.ObjectBindingPattern,
    bases: string[]
  ): boolean => {
    let changed = false;
    for (const element of pattern.elements) {
      const propertyName = element.propertyName
        ? element.propertyName.getText(sourceFile)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (!propertyName) {
        continue;
      }
      const targets = bases.map(base => `${base}.${propertyName}`);
      if (ts.isIdentifier(element.name)) {
        changed = setAlias(element.name.text, targets) || changed;
      } else if (ts.isObjectBindingPattern(element.name)) {
        changed = registerBindingPattern(element.name, targets) || changed;
      }
    }
    return changed;
  };

  const registerAliases = (declaration: ts.VariableDeclaration): boolean => {
    if (!declaration.initializer) {
      return false;
    }
    const initializer = unwrap(declaration.initializer);
    const base = propertyPath(initializer);
    if (!base) {
      return false;
    }
    const bases = resolvePaths(base, initializer).filter(isPolyPath);
    if (bases.length === 0) {
      return false;
    }
    aliasInitializers.add(initializer);
    if (ts.isIdentifier(declaration.name)) {
      return setAlias(declaration.name.text, bases);
    }
    if (ts.isObjectBindingPattern(declaration.name)) {
      return registerBindingPattern(declaration.name, bases);
    }
    return false;
  };

  const collectLocalFunction = (node: ts.Node): void => {
    let name: string | null = null;
    let fn: ts.Node | null = null;
    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
      fn = node;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = unwrap(node.initializer);
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)
      ) {
        name = node.name.text;
        fn = initializer;
      }
    }
    if (name && fn) {
      const list = localFunctions.get(name) ?? [];
      list.push(fn as FunctionLike);
      localFunctions.set(name, list);
    }
  };

  /** `helper(poly.utilities)`: bind helper's parameter to the argument's poly path(s). */
  const bindCallArguments = (call: ts.CallExpression): boolean => {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee)) {
      return false;
    }
    const targets = localFunctions.get(callee.text);
    if (!targets) {
      return false;
    }
    let changed = false;
    call.arguments.forEach((argumentNode, index) => {
      if (ts.isSpreadElement(argumentNode)) {
        return;
      }
      const argument = unwrap(argumentNode);
      const dottedPath = propertyPath(argument);
      if (!dottedPath) {
        return;
      }
      const polyPaths = resolvePaths(dottedPath, argument).filter(isPolyPath);
      if (polyPaths.length === 0) {
        return;
      }
      for (const fn of targets) {
        const name = parameterName(fn.parameters[index]);
        if (!name) {
          continue;
        }
        let byName = parameterBindings.get(fn);
        if (!byName) {
          byName = new Map();
          parameterBindings.set(fn, byName);
        }
        let set = byName.get(name);
        if (!set) {
          set = new Set();
          byName.set(name, set);
        }
        changed = addAll(set, polyPaths) || changed;
      }
    });
    return changed;
  };

  // Pass 1: the default `polyapi` import and the functions declared in this file.
  const collect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'polyapi' &&
      node.importClause?.name
    ) {
      polyIdentifier = node.importClause.name.text;
    }
    collectLocalFunction(node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  if (!polyIdentifier) {
    return { refs: [], forwarded: [], warnings };
  }

  // Pass 2: aliases and parameter bindings feed each other — iterate to a fixed point.
  for (let round = 0; round < 16; round += 1) {
    let changed = false;
    const bind = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        changed = registerAliases(node) || changed;
      } else if (ts.isCallExpression(node)) {
        changed = bindCallArguments(node) || changed;
      }
      ts.forEachChild(node, bind);
    };
    bind(sourceFile);
    if (!changed) {
      break;
    }
  }

  /** Is this expression an argument to a same-file function whose matching parameter is tracked? */
  const isForwardedArgument = (node: ts.Node): boolean => {
    let current: ts.Node = node;
    while (current.parent && isWrapper(current.parent)) {
      current = current.parent;
    }
    const parent = current.parent;
    if (
      !parent ||
      !ts.isCallExpression(parent) ||
      parent.expression === current
    ) {
      return false;
    }
    const index = parent.arguments.indexOf(current as ts.Expression);
    const callee = unwrap(parent.expression);
    if (index < 0 || !ts.isIdentifier(callee)) {
      return false;
    }
    return (localFunctions.get(callee.text) ?? []).some(fn => {
      const name = parameterName(fn.parameters[index]);
      return (
        name !== null && Boolean(parameterBindings.get(fn)?.get(name)?.size)
      );
    });
  };

  const record = (dottedPath: string, node: ts.Node): void => {
    for (const resolved of resolvePaths(dottedPath, node)) {
      if (!isPolyPath(resolved)) {
        continue;
      }
      const ref = resolved.slice((polyIdentifier as string).length + 1);
      if (!ref) {
        continue;
      }
      if (ref.includes('*')) {
        warnings.push(
          `${describeLocation(sourceFile, node)}: computed access on poly.${ref} cannot be resolved statically`
        );
      }
      refs.add(ref);
      if (isForwardedArgument(node)) {
        forwarded.add(ref);
      }
    }
  };

  // Pass 3: record every member chain rooted at the import, an alias or a bound parameter.
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !isInnerChainPart(node) &&
      !aliasInitializers.has(node)
    ) {
      const dottedPath = propertyPath(node);
      if (dottedPath) {
        record(dottedPath, node);
      }
    } else if (
      ts.isIdentifier(node) &&
      isValueReference(node) &&
      resolveRoot(node.text, node) !== null
    ) {
      record(node.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { refs: [...refs].sort(), forwarded: [...forwarded].sort(), warnings };
}

/**
 * Resolve a reference to a local function key: exact match first, then the
 * longest key that is a segment-prefix of the reference (case-insensitive).
 */
export function resolveReference(
  ref: string,
  keysByLowerCase: Map<string, string>
): string | undefined {
  const parts = ref.toLowerCase().split('.');
  while (parts.length > 1) {
    const hit = keysByLowerCase.get(parts.join('.'));
    if (hit) {
      return hit;
    }
    parts.pop();
  }
  return undefined;
}

function isSegmentPrefix(prefix: string, value: string): boolean {
  return value.startsWith(`${prefix}.`);
}

function pushUnique(
  map: Map<string, string[]>,
  key: string,
  value: string
): void {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) {
    list.push(value);
  }
  map.set(key, list);
}

/**
 * Build the call graph over the given function files.
 * @throws when two files claim the same `<context>.<name>` identity
 */
export function buildFunctionGraph(
  files: FunctionFile[],
  readSource: (filePath: string) => string
): FunctionGraph {
  const nodes = new Map<string, GraphNode>();
  const warnings: string[] = [];

  for (const file of files) {
    const key = functionKey(file.metadata.context, file.metadata.name);
    const existing = nodes.get(key);
    if (existing) {
      throw new Error(
        `Duplicate function identity "${key}" in ${existing.filePath} and ${file.tsFilePath}`
      );
    }
    nodes.set(key, {
      key,
      name: file.metadata.name,
      context: file.metadata.context,
      type: file.type,
      filePath: file.tsFilePath,
      deps: new Set(),
      dependents: new Set(),
    });
  }

  const keysByLowerCase = new Map<string, string>();
  for (const key of nodes.keys()) {
    const lower = key.toLowerCase();
    const clash = keysByLowerCase.get(lower);
    if (clash && clash !== key) {
      warnings.push(
        `Function identities "${clash}" and "${key}" differ only by case; references resolve to "${clash}"`
      );
      continue;
    }
    keysByLowerCase.set(lower, key);
  }

  const sortedKeys = [...nodes.keys()].sort();
  for (const shorter of sortedKeys) {
    for (const longer of sortedKeys) {
      if (
        shorter !== longer &&
        isSegmentPrefix(shorter.toLowerCase(), longer.toLowerCase())
      ) {
        warnings.push(
          `Function identity "${shorter}" is a prefix of "${longer}": member access on the former cannot be told apart from calls to the latter`
        );
      }
    }
  }

  const externalRefs = new Map<string, string[]>();
  const ambiguousRefs = new Map<string, string[]>();
  let edgeCount = 0;

  for (const node of nodes.values()) {
    const extracted = extractPolyReferences(
      readSource(node.filePath),
      node.filePath
    );
    warnings.push(...extracted.warnings);
    const forwarded = new Set(extracted.forwarded);

    for (const ref of extracted.refs) {
      const target = resolveReference(ref, keysByLowerCase);
      if (target) {
        if (target !== node.key && !node.deps.has(target)) {
          node.deps.add(target);
          nodes.get(target)?.dependents.add(node.key);
          edgeCount += 1;
        }
        continue;
      }
      if (forwarded.has(ref)) {
        // A namespace handed to a same-file function: its uses were
        // recorded inside that function, so this is not dynamic dispatch.
        continue;
      }

      // Static prefix before the first computed segment: `*.foo` → "" (could be
      // any local function), `utilities.*` → "utilities", `OOB.*.foo` → "oob" (external).
      const staticPrefix = ref.toLowerCase().replace(/(^|\.)\*.*$/, '');
      const prefixesLocalKey =
        staticPrefix === '' ||
        [...keysByLowerCase.keys()].some(key =>
          isSegmentPrefix(staticPrefix, key)
        );
      pushUnique(
        prefixesLocalKey ? ambiguousRefs : externalRefs,
        ref,
        node.filePath
      );
    }
  }

  for (const [ref, files] of ambiguousRefs) {
    warnings.push(
      `poly.${ref} matches no function but prefixes local function identities (possible dynamic dispatch) in: ${files.join(', ')}`
    );
  }

  return { nodes, edgeCount, externalRefs, ambiguousRefs, warnings };
}

/**
 * Transitive callers of each seed, merged. Server functions are leaves: they
 * are collected but never expanded (unless `throughSfx`), and a server
 * function used as a seed propagates to nobody.
 */
export function computeClosure(
  graph: FunctionGraph,
  seeds: string[],
  options: ClosureOptions = {}
): Closure {
  const uniqueSeeds = [...new Set(seeds)];
  for (const seed of uniqueSeeds) {
    if (!graph.nodes.has(seed)) {
      throw new Error(`Unknown function "${seed}"`);
    }
  }

  const nodes = new Map<string, ClosureNode>();
  for (const seed of uniqueSeeds) {
    const node = graph.nodes.get(seed) as GraphNode;
    nodes.set(seed, { key: seed, type: node.type, reason: 'seed', via: [] });
  }

  for (const seed of uniqueSeeds) {
    const visited = new Set<string>([seed]);
    const queue = [seed];

    while (queue.length > 0) {
      const current = queue.shift() as string;
      const currentNode = graph.nodes.get(current) as GraphNode;
      if (currentNode.type === 'server' && !options.throughSfx) {
        continue;
      }

      for (const dependent of [...currentNode.dependents].sort()) {
        if (visited.has(dependent)) {
          continue;
        }
        visited.add(dependent);
        queue.push(dependent);

        const existing = nodes.get(dependent);
        if (existing) {
          if (existing.reason !== 'seed' && !existing.via.includes(seed)) {
            existing.via.push(seed);
          }
          continue;
        }

        const dependentNode = graph.nodes.get(dependent) as GraphNode;
        nodes.set(dependent, {
          key: dependent,
          type: dependentNode.type,
          reason: dependentNode.type === 'server' ? 'leaf' : 'intermediate',
          via: [seed],
        });
      }
    }
  }

  return { seeds: uniqueSeeds, nodes };
}

/**
 * Which closure nodes get deployed: seeds and server-function leaves always,
 * unchanged intermediate client functions only on request (their code is
 * byte-identical on the platform and is resolved inside each leaf's bundle).
 */
export function selectDeploySet(
  closure: Closure,
  includeIntermediate: boolean
): string[] {
  return [...closure.nodes.values()]
    .filter(node => node.reason !== 'intermediate' || includeIntermediate)
    .map(node => node.key);
}

function typeRank(graph: FunctionGraph, key: string): number {
  return graph.nodes.get(key)?.type === 'server' ? 1 : 0;
}

/**
 * Dependency order (callees before callers) restricted to the given keys.
 * Strongly connected components are found first (Tarjan), so only the members
 * of a real cycle are reported as `cyclic`; everything downstream of a cycle
 * still gets a callee-first position. Within the ready set the tie-break is
 * client-before-server, then alphabetical; members of a cycle are emitted in
 * that same order.
 */
export function orderForDeploy(
  graph: FunctionGraph,
  keys: Iterable<string>
): DeployOrder {
  const selected = new Set(keys);
  for (const key of selected) {
    if (!graph.nodes.has(key)) {
      throw new Error(`Unknown function "${key}"`);
    }
  }

  const compare = (left: string, right: string): number =>
    typeRank(graph, left) - typeRank(graph, right) || left.localeCompare(right);
  const depsOf = (key: string): string[] =>
    [...(graph.nodes.get(key)?.deps ?? [])].filter(dep => selected.has(dep));

  // Tarjan's strongly connected components over the selected subgraph.
  const componentOf = new Map<string, number>();
  const components: string[][] = [];
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;

  const strongConnect = (key: string): void => {
    index.set(key, counter);
    lowLink.set(key, counter);
    counter += 1;
    stack.push(key);
    onStack.add(key);

    for (const dep of depsOf(key)) {
      if (!index.has(dep)) {
        strongConnect(dep);
        lowLink.set(
          key,
          Math.min(lowLink.get(key) ?? 0, lowLink.get(dep) ?? 0)
        );
      } else if (onStack.has(dep)) {
        lowLink.set(key, Math.min(lowLink.get(key) ?? 0, index.get(dep) ?? 0));
      }
    }

    if (lowLink.get(key) === index.get(key)) {
      const members: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) {
          break;
        }
        onStack.delete(member);
        componentOf.set(member, components.length);
        members.push(member);
      } while (member !== key);
      components.push(members.sort(compare));
    }
  };

  for (const key of [...selected].sort(compare)) {
    if (!index.has(key)) {
      strongConnect(key);
    }
  }

  const cyclic = components
    .filter(
      members => members.length > 1 || depsOf(members[0]).includes(members[0])
    )
    .flat()
    .sort(compare);

  // Kahn's algorithm over the condensation (one node per component).
  const indegree = new Map<number, number>();
  const dependents = new Map<number, Set<number>>();
  components.forEach((_members, id) => {
    indegree.set(id, 0);
    dependents.set(id, new Set());
  });
  for (const [key, id] of componentOf) {
    for (const dep of depsOf(key)) {
      const depId = componentOf.get(dep);
      if (depId === undefined || depId === id) {
        continue;
      }
      const set = dependents.get(depId) as Set<number>;
      if (!set.has(id)) {
        set.add(id);
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
      }
    }
  }

  const componentCompare = (left: number, right: number): number =>
    compare(components[left][0], components[right][0]);
  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort(componentCompare);
    const id = ready.shift() as number;
    order.push(...components[id]);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
      }
    }
  }

  return { order, cyclic };
}

/** Blast radius per client function: transitive CFX callers and SFX leaves. */
export function computeHubs(graph: FunctionGraph): HubEntry[] {
  const entries: HubEntry[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type !== 'client') {
      continue;
    }
    const closure = computeClosure(graph, [node.key]);
    let cfxCallers = 0;
    let sfxLeaves = 0;
    for (const reached of closure.nodes.values()) {
      if (reached.reason === 'intermediate') {
        cfxCallers += 1;
      } else if (reached.reason === 'leaf') {
        sfxLeaves += 1;
      }
    }
    entries.push({ key: node.key, cfxCallers, sfxLeaves });
  }
  return entries.sort(
    (left, right) =>
      right.sfxLeaves - left.sfxLeaves ||
      right.cfxCallers - left.cfxCallers ||
      left.key.localeCompare(right.key)
  );
}

export interface ExplainedPaths {
  paths: string[][];
  /** True when more chains exist than `limit` allowed to list. */
  truncated: boolean;
}

/**
 * Seed → … → target chains (callee → caller), for `--why`. Paths stop at
 * server functions like the closure does; at most `limit` are returned and
 * `truncated` says whether any were left out.
 */
export function explainPaths(
  graph: FunctionGraph,
  seeds: string[],
  target: string,
  limit: number = 25
): ExplainedPaths {
  const paths: string[][] = [];
  const cap = limit + 1;

  const walk = (current: string, trail: string[]): void => {
    if (paths.length >= cap) {
      return;
    }
    if (current === target) {
      paths.push(trail);
      return;
    }
    const node = graph.nodes.get(current);
    if (!node || node.type === 'server') {
      return;
    }
    for (const dependent of [...node.dependents].sort()) {
      if (!trail.includes(dependent)) {
        walk(dependent, [...trail, dependent]);
      }
    }
  };

  for (const seed of seeds) {
    walk(seed, [seed]);
  }
  return { paths: paths.slice(0, limit), truncated: paths.length > limit };
}

export interface TreeRenderOptions {
  throughSfx?: boolean;
  /** Extra text per node (remote revision, MUST flags, ...). */
  annotate?: (key: string) => string;
}

/**
 * Text tree of callers per seed. Nodes reached from an earlier seed or branch
 * are marked "(already listed)"; server functions are not expanded unless
 * `throughSfx`.
 */
export function renderTree(
  graph: FunctionGraph,
  closure: Closure,
  options: TreeRenderOptions = {}
): string[] {
  const lines: string[] = [];
  const listed = new Set<string>();
  const label = (key: string): string => {
    const node = graph.nodes.get(key) as GraphNode;
    const suffix = options.annotate?.(key) ?? '';
    return `${key}  [${node.type === 'server' ? 'SFX' : 'CFX'}]${suffix ? `  ${suffix}` : ''}`;
  };

  const walk = (key: string, indent: string): void => {
    const node = graph.nodes.get(key) as GraphNode;
    const dependents = [...node.dependents]
      .filter(dependent => closure.nodes.has(dependent))
      .sort();
    dependents.forEach((dependent, index) => {
      const isLast = index === dependents.length - 1;
      const branch = isLast ? '└─ ' : '├─ ';
      const repeat = listed.has(dependent);
      lines.push(
        `${indent}${branch}${label(dependent)}${repeat ? '  (already listed)' : ''}`
      );
      if (repeat) {
        return;
      }
      listed.add(dependent);
      const dependentNode = graph.nodes.get(dependent) as GraphNode;
      if (dependentNode.type === 'server' && !options.throughSfx) {
        return;
      }
      walk(dependent, `${indent}${isLast ? '   ' : '│  '}`);
    });
  };

  for (const seed of closure.seeds) {
    lines.push(label(seed));
    listed.add(seed);
    walk(seed, '');
  }

  return lines;
}
