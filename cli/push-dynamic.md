# flow push-dynamic

`flow push-dynamic` is `flow push` with a dependency-aware function step. It
runs the same pipeline as `push` — discovery, validation, every artefact type
in the same order (variables, canopy, schemas, tables, functions, AI
functions, webhooks, triggers, jobs), the scope prompt, the production
safeguards, the summary and the post-push `poly generate` — and accepts the
same options. Only the function step differs: given the functions that changed
(or that you name), it works out every function that embeds them and deploys
exactly that set in the right order. You can use it instead of `push`
altogether.

It exists because a client function (CFX) never runs on its own. Its code is
embedded into the poly library that every server function (SFX) bundles, so
after a CFX changes, the SFXs that use it (directly or through other CFXs)
have to be rebuilt before they run the new code. Working out that set by hand
is error-prone; this command computes it from the source.

## Quick start

Always look at the plan first. Nothing below touches the platform until you run
a command without `--dry-run` and confirm the prompt. Like `push`, an
interactive run without `--paths` first asks for a scope (not when it only
deploys the trees of named functions), and a scope typed there counts as
`--paths`. A run on a production-sensitive branch asks you to type `PROD` (or
`--skip-validation "I know what am doing"`).

```bash
# Force one CFX (even when its code is unchanged) plus every function that embeds it
# (named functions without --paths/--types: only their trees, no other artefact types)
pnpm dyn:dev:dry -- ./workflows/src/utilities/common/client/log.ts

# Everything that differs from dev (all artefact types, like push), functions expanded through the graph
pnpm dyn:dev:dry

# One workflow: its artefacts and only its changed functions, plus whatever those reach
pnpm dyn:dev:dry -- --paths sampleWorkflow

# Functions only, like push --types functions
pnpm dyn:dev:dry -- --types functions

# Deploy the plan (asks y/N; FLOW_EXECUTION_API_KEY is optional, as for flow push)
pnpm dyn:dev -- ./workflows/src/utilities/common/client/log.ts

# Production plan (prod.env). A real `pnpm dyn:prod` on the production branch additionally
# demands POLYPROD_EXEC_KEY and a typed "PROD".
pnpm dyn:prod:dry -- ./workflows/src/utilities/common/client/log.ts
```

Long form, useful when you want a different env file:

```bash
ENVPATH=workflows/dev.env pnpm workflows push:dynamic:dry-run -- <args>
ENVPATH=workflows/dev.env pnpm workflows push:dynamic -- <args>
```

Paths, for named functions and `--paths` alike, may be relative to where you
run the command, to `workflows/`, or to the repository root, so
`./workflows/src/x.ts`, `workflows/src/x.ts`, `src/x.ts` and absolute paths all
work, as does a bare workflow name such as `sampleWorkflow` (meaning
`workflows/src/sampleWorkflow`). Directories select every file under them.
`.` and `./…` mean the directory you run the command from, and a scope must
lie inside `workflows/`. A named function can also be given as its deployed
identity, such as `example.utilities.log`.

`--paths` never forces anything. It means the same as for `flow push`: it
scopes which artefacts are synced and which function files are compared for
changes, so only the functions under it whose code differs from the target
become seeds. The closure is never scoped, so a changed CFX still pulls in
every SFX that embeds it, wherever that SFX lives. To deploy a function even
when it is unchanged, name it as an argument or with `--seeds`.

The examples use `example.utilities.log` because it has callers in the sample
graph. The sample `motdServer` calls `poly.sample.sampleWorkflow.*` while the
sample's `polyConfig` context is `example.sampleWorkflow`, so the graph treats
those calls as external and `motdClient` has no callers.

## How it works

### The graph

Every file under `workflows/src/**/{client,server}/*.ts` with an inline
`polyConfig` is a node. The node's identity is `context + "." + name`, which is
exactly what the platform uses, and the folder decides whether it is a CFX
(`client/`) or an SFX (`server/`).

Edges come from a TypeScript syntax walk of each file: every member chain
rooted at the default `polyapi` import (`poly.utilities.logging.logger(...)`)
becomes a reference. A reference is matched against the node identities
case-insensitively, exact match first, then the longest identity that is a
prefix of the reference. The prefix rule is what makes
`poly.utilities.money.toCents(...)` an edge to the `utilities.money` function
rather than a lookup for a function called `toCents`. References that match
nothing are external (OOB adapters, custom API functions) and ignored.

The graph is rebuilt in memory on every run (about a second for a few hundred
files) and is never saved, so it always reflects the working tree.

### Seeds

Seeds are the functions treated as changed.

- Named on the command line (as arguments or via `--seeds`): forced, deployed
  even when unchanged. Naming anything switches automatic detection off unless
  `--seed-from` or `--paths` is passed; with `--paths`, the functions under it
  are compared as well. Naming functions without `--paths`, `--types` or
  `--seed-from` also leaves the other artefact types out: the run deploys just
  the named trees, the way `flow push --paths <file>` syncs just that file.
  A run that names functions never detects or deletes orphans.
- `--seed-from remote` (the default when nothing is named): every function file
  is compared, code only, with what is deployed in the target environment. One
  `GET` per function; a few hundred requests take 10 to 20 seconds. A function
  missing remotely is a `create` seed.
- `--seed-from specs`: the same comparison, offline, against the generated SDK's
  `specs.json` (written by `npx poly generate`). Instant, but only as fresh as
  the last generate and specific to the environment it was generated for; the
  plan prints which.
- `--seed-from none`: only the named functions.

Whatever the source, the intermediate CFXs inside the trees that were not
compared yet (forced trees, or intermediates outside `--paths`) are compared
with the target as well, and promoted to seeds when their code differs.

### Closure

From each seed the command walks the callers. A CFX caller is an intermediate
and is expanded further; an SFX caller is a leaf and is not expanded, because
SFX-to-SFX and CFX-to-SFX calls go over HTTP at runtime and nothing propagates
through them. An SFX used as a seed propagates to nobody. Trees from several
seeds are merged, so a function reached from two seeds appears once.

### What gets deployed

The deploy set is the whole tree: the seeds, the intermediate CFXs between
them and their leaves, and the SFX leaves. `--skip-unchanged-cfx` leaves out
intermediates whose deployed code is byte-identical (each leaf's bundle
resolves them from their own spec, so re-adding them changes nothing on the
platform); when the deployed functions could not be listed for comparison,
they are re-added regardless.

Leaves flagged `MUST` are `alwaysOn` or `cachePolyLibrary` on the platform.
Their pod never recycles, so a redeploy is the only way new CFX code reaches
them.

### Order

Callees are deployed before callers (a topological sort over the whole
closure, CFX before SFX on ties, then alphabetical), so a CFX seed always
precedes the SFX leaves that embed it. Functions that call each other in a
cycle are deployed together in that order, and everything that depends on them
comes after. After the last deploy the pipeline runs `poly generate` once.

## Usages

### Force a function you know you want redeployed

```bash
pnpm dyn:dev:dry -- ./workflows/src/utilities/common/client/log.ts
```

The plan lists the seed, the intermediate CFXs between it and its leaves, and
every SFX that embeds it (for the sample: `log`, `slack.sendAlert`, which it
forms a cycle with, and the `diagnostics.services.errorAlerts` SFX). Add `--skip-unchanged-cfx` to leave out the
intermediates whose deployed code is identical. Several arguments merge into
one plan.

### Deploy everything that differs from the target

```bash
pnpm dyn:dev:dry
```

Compares every function file with the target environment and plans the
changed functions plus the functions that embed the changed CFXs. Restrict the
comparison to one workflow with `--paths sampleWorkflow`: only the changed
functions under it become seeds, while the tree still reaches every function
that embeds them. Combine with forced seeds by naming them and adding
`--seed-from remote`: that run syncs every artefact type as `push` does
(asking for a scope when interactive) and adds the named trees.

### Export the plan

```bash
pnpm -s dyn:dev:dry -- <seeds> --json > plan.json   # plan on stdout, logs on stderr (-s keeps pnpm's banners off stdout)
```

`--json` cannot be combined with `--build-schema`, whose code generation also
writes to stdout.

### Inspect

```bash
pnpm dyn:dev:dry -- --hubs                                              # CFXs by blast radius
pnpm dyn:dev:dry -- example.utilities.log --why example.diagnostics.services.errorAlerts   # every seed → … → function chain
pnpm dyn:dev:dry -- <seeds> --through-sfx                               # tree expanded past SFXs (report only)
```

`--hubs`, `--why` and `--json` imply `--dry-run`. `--through-sfx` only widens
the printed tree; the deploy set is unchanged.

### Real run

Without `--dry-run` the command validates the artefacts in scope and every
function the plan deploys, in scope or not (a function in the plan that fails
validation stops the run; `--skip-invalid` does not apply to the tree, where
leaving one out would deploy its callers on top of stale code), prints the
function plan, and then:

1. Resolves the execution API key for the SFXs in the plan
   (`POLYPROD_EXEC_KEY` on production-sensitive branches, else
   `--execution-api-key`, else `FLOW_EXECUTION_API_KEY`, else the function's
   `polyConfig.executionApiKey`). It is optional, exactly as for `flow push`:
   without one the server functions are deployed without a key, and the plan
   says so.
2. Asks `y/N` for the whole run (the function deploys and the other selected
   artefacts, also when `--types` leaves functions out).
   Above `--max-leaves` (default 10) SFX leaves it also asks you to type the
   leaf count. `--yes` skips both prompts and is required in a non-interactive
   terminal. The typed `PROD` confirmation on production-sensitive branches is
   only bypassed by `--skip-validation "I know what am doing"`, exactly as for
   `flow push`.
3. Syncs the artefact types in `push` order; at the functions slot it deploys
   the plan sequentially through the same `poly function add` path as
   `flow push`. On the first failure it stops, so no dependent is built on top
   of a failed deploy, lists what did not run, and prints a resume command that
   starts with the failed function. The remaining artefact types still sync.
4. Prints the usual synchronization summary (function orphans included) and
   runs `poly generate` once (skip with `--skip-generate`).

## Reading the plan

```text
[GRAPH]   N functions (x CFX / y SFX) · E edges · M external poly.* references ignored
[SEEDS]   + create (not deployed) · ~ update (code differs) · ! forced (--seeds)
[TREE]    callers of each seed (expansion stops at server functions)
[PLAN]    N deploy(s) in dependency order (seed · leaf · MUST · intermediate skipped · outside the closure)
```

Labels in the tree:

| Label | Meaning |
| --- | --- |
| `seed (forced / update / create)` | Why this function is a seed |
| `leaf` | SFX that embeds a seed; deployed |
| `leaf, MUST (alwaysOn)` | Leaf whose pod never recycles; always deployed |
| `intermediate, unchanged → re-added (whole tree)` | CFX between a seed and its leaves, identical on the platform, deployed anyway (default) |
| `intermediate, not compared → re-added` | Same, but deployed functions could not be listed |
| `intermediate, unchanged → skipped` | `--skip-unchanged-cfx` is on and the code is identical; not deployed |
| `reached through an SFX → not deployed` | Only with `--through-sfx`: beyond an HTTP boundary |
| `rev N` / `not deployed` | Platform revision, or absent in the target environment |
| `(already listed)` | Reached from an earlier seed or branch |

Warnings to take seriously:

- `computed access on poly.x.* cannot be resolved statically` — a call the
  graph cannot follow; add the functions it could reach as seeds yourself.
- `poly.x matches no function but prefixes local function identities` — a
  namespace object escapes to code the graph cannot see (see below).
- `has no caller in this repo` — an intermediate nothing in the repo calls; it
  may be dead, or used by a local harness or a function outside the repo.
- `dependency cycle among …` — client functions that call each other (the
  sample's `example.utilities.log` and `example.utilities.slack.sendAlert` are
  one such pair). Only the members of the cycle are listed; they are emitted
  in name order, and everything that depends on them still comes after them.

## What the extractor detects

Everything below was verified with unit tests in
`cli/src/utils/functionGraph.test.ts` and `cli/src/utils/wildcardEdges.test.ts`.

| Pattern | Example | Detected |
| --- | --- | --- |
| Plain call | `poly.utilities.logging.logger('x')` | yes |
| Member access on a CFX result | `poly.utilities.money.toCents(1)` → `utilities.money` | yes |
| Alias | `const res = poly.utilities.ohip.reservations; res.getDetails()` | yes |
| Chained aliases, any order | `const z = y.money.toCents; const y = x.utilities; const x = poly; z()` | yes |
| Destructuring, nested too | `const { utilities: { money } } = poly; money()` | yes |
| Destructured call result | `const { data } = await poly.utilities.x.y()` | yes |
| Casts and parentheses in the chain | `(poly.aiKnowledgeHub as any).getHotels()` | yes |
| Renamed default import | `import p from 'polyapi'; p.services.x.y()` | yes |
| Function reference as an argument | `withHttpCheck(poly.utilities.slack.sendAlert)` | yes (both) |
| Namespace forwarded to a same-file function | `helper(poly.utilities)` + `u.money.toCents()` inside `helper` | yes |
| Whole `poly` forwarded | `helper(poly)` + `p.utilities.x.y()` inside `helper` | yes |
| Forwarding chains | `outer(poly.utilities)` → `inner(ns)` → `v.logging.logger()` | yes |
| Parameter shadowing an alias | `function f(z) { z() }` with a file-level alias `z`, `f` never called with poly | correctly ignored |
| Computed access | `poly.utilities[name]()` | no, warned; see the experimental wildcard expansion below |
| Forwarding to a function in another file or a callback | `items.map(u => u.money())` with `u` from elsewhere | no |
| Namespace stored in an object or class field | `this.poly = poly.utilities` | no |
| Path built from strings | `poly["utilities." + x]` | no, warned |
| `require('polyapi')` or `import * as` | | no |
| Callers outside this repo | functions deployed from another repository that embed these CFXs | no |
| Type-only coupling | `Utilities.Ohip.Reservations.GetDetails.ReturnType` | no (not an edge) |
| SFX signature changes | An SFX's return shape changed; its SFX callers | no (HTTP boundary; use `--through-sfx` to see them) |

Write the natural `poly.<context>.<name>(...)` call whenever possible. Only
computed access and paths built from strings produce a warning in the plan;
the other "no" rows are silent, so a call written that way is simply missing
from the graph.

## Experimental: wildcard expansion

`--experimental-wildcards` turns computed access into edges instead of a
warning. It lives in `cli/src/utils/wildcardEdges.ts` and is wired in at one
place; removing the file, its test, the flag and that call site removes the
feature.

The set of deployable functions is closed, so every possibility can be
enumerated. For `poly.utilities[key].toCents(...)` the extractor records
`utilities.*.toCents`; a function identity is a candidate when its segments
match position by position, `*` standing for exactly one segment:

| Identity | Match | Kept because |
| --- | --- | --- |
| `utilities.general.toCents` | identity | as long as the reference, every segment aligns |
| `utilities.money` | member | shorter; the rest (`toCents`) is member access on its result, and its source mentions `toCents` outside comments |
| `utilities.general.sanitizeString` | none | third segment is `sanitizeString`, not `toCents` |
| `utilities.ohip.reservations.getDetails` | none | longer than the reference |

`poly.utilities.general[key]()` therefore maps to every function directly under
`utilities.general`, and `poly[ctx].foo()` to every two-segment identity ending
in `foo`. Candidates become ordinary edges, so the closure, ordering and plan
treat them like real calls; the plan lists each added edge under
`[EXPERIMENTAL]`, and `--json` carries them as `experimentalWildcards`.

Limits: the "mentions the member" test is textual — comments (line, block,
JSDoc) are stripped first, but a string literal or an unrelated identifier of
the same name still counts, so it over-approximates; a computed segment that resolves to
something outside the repo (`poly.OOB[x]`) matches nothing and stays a warning;
and a reference whose static prefix names no local function at all cannot be
narrowed. Worst case is deploying more than needed, never less.

## Options

| Option | Effect |
| --- | --- |
| `<file\|directory\|context.name> …` / `--seeds <csv>` | Forced seeds; turns automatic detection off unless `--paths`/`--seed-from` is given; without `--paths`/`--types`/`--seed-from` syncs no other artefact type; never detects or deletes orphans |
| `--paths <csv>` | Scope, as for `flow push`: artefacts under these paths are synced and only functions under them are compared; a bare workflow name means `src/<workflow>`; the closure is never scoped |
| `--types <csv>` | Artefact types to sync, as for `flow push` (function sub-types select the function step) |
| `--force`, `--delete-orphans`, `--build-schema`, `--skip-invalid`, `--show-config` | As for `flow push` (`--force` does not affect functions, seeds do; `--skip-invalid` does not apply to functions in the plan; `--show-config` masks the execution API key) |
| `--seed-from remote\|specs\|none` | Where automatic seeds come from (default `remote`, or `none` when something is named and `--paths` is not given) |
| `--skip-unchanged-cfx` | Leave out intermediate CFXs whose deployed code is identical (default: whole tree) |
| `--through-sfx` | Expand the printed tree past SFXs (report only) |
| `--dry-run` | Plan only |
| `--json` | Plan as JSON on stdout, logs on stderr; implies `--dry-run`; not with `--build-schema` or a `--types` without functions. Use `pnpm -s …` when piping |
| `--why <context.name>` | Print the seed chains to that function and exit (`--types` must include functions) |
| `--hubs` | Print CFXs by blast radius and exit (`--types` must include functions) |
| `--experimental-wildcards` | Expand computed access to every matching function (experimental, over-approximates) |
| `--yes`, `-y` | Skip the y/N and leaf-count prompts (not the typed `PROD`) |
| `--max-leaves <n>` | Typed confirmation above n SFX leaves (default 10) |
| `--execution-api-key <key>` | Execution API key for server functions |
| `--skip-generate` | Skip the final `poly generate` |
| `--skip-validation "I know what am doing"` | Bypass the branch/env and production confirmations non-interactively (as for `push`) |
| `--verbose` | Debug logging |

## Caveats

- **Whether non-alwaysOn SFXs really need the redeploy is unverified.** Poly's
  documentation says a server function loads the poly library on each
  invocation unless `cachePolyLibrary=true` (leaves with that flag are marked
  MUST in the plan and always redeployed).
  If that holds, a changed CFX reaches most SFXs at their next cold start and
  leaf redeploys are only about immediacy. The command keeps them on as a safe
  superset. To settle it for your environment: deploy a diagnostics CFX returning a constant marker
  and an SFX that returns it, change only the CFX marker and `poly function add`
  the CFX alone, give the SFX an explicit `sleepCycleInterval`, wait past it and
  execute the SFX. A new marker means non-alwaysOn leaves need no redeploy.
- **Seeds are code-only.** An npm-pin or `polyConfig` flag change without a
  code change is not a seed; force the function.
- **Deploys are not atomic.** Between the CFX add and the last leaf add the
  catalog holds new CFX code while some bundles are old. Hub changes are large
  (use `--hubs` to see the blast radius) and every SFX redeploy terminates a
  running instance, so avoid job windows.
- **Named functions deploy only their trees.** Every artefact type is synced
  as in `flow push`, except when functions are named without `--paths`,
  `--types` or `--seed-from`. A new SFX named that way gets no job, trigger or
  webhook; add `--types functions,jobs,triggers,webhooks` or
  `--paths <its workflow>`. Runs that name functions never touch orphans.
- **The specs cache belongs to one environment.** After a Flow `poly generate`
  the command knows which; after a manual `npx poly generate` it can only
  guess from the poly CLI config and says so.
- **Flow fixes that shipped with this command also apply to `flow push`:** the
  spawned poly CLI and the post-push `poly generate` are pinned to the ENVPATH
  environment (they used to run against whatever `poly setup` last wrote), and
  both the deploy and the change comparator run from the package that declares
  `polyapi` (`workflows/` here), which is where the npm pins of your functions'
  imports and the tsconfig are resolved from.

## Where the code lives

- `cli/src/utils/functionGraph.ts` — pure graph: extraction, resolution,
  closure, ordering, hubs, `--why`, tree rendering.
- `cli/src/commands/pushDynamic.ts` — the command: seeds, plan, confirmations,
  deploy loop, exports.
- `cli/src/cli.ts` — dispatch, argument parsing, help, banner.
- `cli/src/utils/functionGraph.test.ts`, `cli/src/utils/wildcardEdges.test.ts`
  — `node:test` unit tests, including one over the checked-in workflow graph
  (`pnpm flow exec tsx --test src/utils/functionGraph.test.ts`).
