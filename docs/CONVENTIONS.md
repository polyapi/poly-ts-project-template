# Project Conventions

[Getting started](../README.md#getting-started) · [Setup](SETUP.md) ·
[Flow CLI](../cli/README.md)

This file is the human-readable conventions reference for a TypeScript PolyAPI
project created from this template. If this file drifts from the checked-in
implementation under `workflows/src/` or `cli/`, follow the implementation.

## Workflow Structure And Naming

Deployable workflows live under `workflows/src/<workflowName>/`. Shared
implementations live under `workflows/src/utilities/`; upstream design material
that is not owned by one workflow lives under `designs/`.

```text
workflows/src/<workflowName>/
  OVERVIEW.md
  README.md
  artefacts/
    ai-functions/
    canopy/
    jobs/
    mcp-servers/
    schemas/
    specs/
    tabi/
    triggers/
    vari/
    webhooks/
  client/
  server/
  types/
```

Document each workflow in its same-folder `OVERVIEW.md`. A workflow that doubles
as a tutorial starts its onboarding in a same-folder `README.md`; runtime
references and optional lessons stay in `OVERVIEW.md`.

Only create folders the workflow needs. Keep one workflow per folder, use
descriptive camelCase workflow and function names, and keep one primary server
or client function per TypeScript file. Place deployed integration tests beside
the relevant runtime boundary, normally under `server/`.

The checked-in spelling is `artefacts/`. Flow also reads legacy `artifacts/`
paths for compatibility, but new files must use `artefacts/`.

## Environment Files

- Keep real environment files out of Git.
- Commit only `*.env.example` files with placeholder values.
- Export `ENVPATH` once per terminal when selecting a Flow environment file;
  subsequent Flow commands inherit it.
- Keep `POLYAPI_NAMESPACE` and the verified `TARGET_ENV_ID` in the selected file.
- Flow uses the workflow SDK's saved setup for its connection. `BASE_URL` and
  `API_KEY` are optional overrides; SDK and older `POLYAPI_*` aliases also work.
- Kickstart saves the target pin automatically. For manual setup, obtain it
  with `pnpm flow target-env`. Remote Flow commands verify it using `/whoami`;
  shell exports and confirmation bypasses cannot replace this file's pin.
- Do not log environment values that may contain secrets.

Select the file once, then run Flow commands normally:

```bash
export ENVPATH=workflows/dev.env
pnpm workflows push --dry-run
```

## PolyAPI Patterns

The common request runtime is:

```text
schemas -> webhooks -> triggers -> functions
```

Flow currently synchronizes selected artefact types in this dependency-aware
order:

```text
variables -> canopy -> schemas -> tables -> functions -> ai-functions
          -> mcp-servers -> webhooks -> triggers -> jobs
```

- Use generated `schemas.*`, `vari.*`, and `tabi.*` namespaces directly when
  they represent the platform contract.
- Import runtime helpers directly from `polyapi`.
- Keep function `polyConfig` aligned with webhook and trigger artefacts.
- Treat `poly.*`, `vari.*`, `tabi.*`, environment variables, files, HTTP, and
  webhook payloads as boundaries.

## Namespaces And Portable References

- Set `POLYAPI_NAMESPACE` to the context root owned by this project.
- Every context belonging to a locally managed artefact, plus every TypeScript
  `polyConfig.context`, must equal that root or start with that root followed by
  a dot. For `POLYAPI_NAMESPACE=mycustomer`, `mycustomer.utilities` is valid;
  `example.utilities` and `mycustomer2.utilities` are not.
- Replace the template's `example` root consistently in artefact contexts,
  generated SDK paths, and trigger error-handler paths when adopting the
  template for another namespace.
- Portable references use exact names and contexts instead of remote IDs.
- API, server, and client function references—and webhook references—may point
  to any accessible environment, tenant, or public resource. Those external
  reference contexts do not need to start with `POLYAPI_NAMESPACE`.
- Variable references remain namespace-scoped.
- Use portable references instead of environment-specific resource IDs. For a
  webhook security function, `id: "{{mycustomer.sampleWorkflow.validateMotdPayload}}"`
  is a portable reference; a deployed function UUID is not.

Kickstart applies your chosen root to the starter workflows **and common
utilities**, including their `polyConfig`, generated SDK calls, JSON context
fields, portable security-function references, and namespace-based error
filters. The included `log` function uses `example.utilities` before setup;
choosing `mycustomer` makes it `mycustomer.utilities` and its calls use
`poly.mycustomer` / `vari.mycustomer`.

For a manual checkout, use the same root in the selected environment file and
all those source locations. Changing the environment variable alone does not
rename code or deployed resources. Keep external references such as
`OOB.polyapi.internal.alerting`, provider URLs, and HTTP webhook paths intact.
Kickstart also personalizes the copied documentation's namespace examples.
For a manual checkout, align the documented root with your code and selected
file before copying training commands or SDK calls.

The context root groups owned resources; it does not select a server or grant
access. The SDK/Flow connection selects the instance and environment, and
`TARGET_ENV_ID` verifies the authenticated target for remote Flow commands.
Keep that pin in the selected environment file; see
[pin the target environment](SETUP.md#pin-the-target-environment).
Advanced projects can explicitly configure multiple owned roots with
`POLYAPI_NAMESPACES`; this takes precedence over the single-root setting.

## Server Functions

- Server functions live under `workflows/src/<workflowName>/server/`.
- Give the primary function a name matching `polyConfig.name`; maintained
  examples use both named and default exports. Use `async` when the function
  awaits work; synchronous validators and error formatters do not require it.
- Flow identifies server and client functions from their `server/` and `client/`
  folders, and reads literal inline `polyConfig` metadata from each source file.
- Keep deployment metadata in the TypeScript file's inline `polyConfig`; do not
  create parallel server-function JSON metadata files.
- Set HTTP status explicitly only at webhook boundary handlers that own the
  response semantics.
- A returned object's `statusCode` field is application data. Set
  `polyCustom.responseStatusCode` when the boundary must control the HTTP status;
  do not assume returning `{ statusCode: 500 }` sets a transport failure.
- Fail fast on invalid external input.
- Keep the main path readable from top to bottom.

## Client Functions

- Client functions live under `workflows/src/<workflowName>/client/`.
- Keep deployment metadata in the TypeScript file's inline `polyConfig`; do not
  create parallel client-function JSON metadata files.
- Use client functions for reusable calls or transformations that are safe to
  invoke from other PolyAPI functions.
- A client function runs in its caller's process. Logs from a client function
  invoked inside a server function belong to that server function's execution.
- Do not hide platform calls behind broad wrappers unless the wrapper removes
  real duplication.

## AI Functions

- AI Function JSON artefacts live under `artefacts/ai-functions/`.
- Keep the prompt directly in `systemPrompt` by default. Use a prompt vari only
  when externally managed prompt content is explicitly required.
- Reference tools with `functionName` and `functionContext`; reference tool
  credentials with `variableName` and `variableContext`. Fix non-secret tool
  arguments, such as provider hosts or units, with `hardcoded` bindings.
- Use API, server, or client functions as tools only when they provide
  authoritative facts or bounded deterministic actions.
- Define focused arguments and a strict output schema. Keep authorization,
  persistence, destructive actions, and other consequential policy in
  deterministic code.
- Put credentials in `SECRET` vari artefacts without committing a value.
- Check tool bindings and the output schema against bundled specifications in
  an offline `*.test.ts` file.
- Test deployed AI Function behavior with an opt-in `.integration.test.ts`
  file so normal test runs do not incur model or external API cost.

## MCP Servers

- MCP server JSON artefacts live under `artefacts/mcp-servers/`.
- Expose only functions that are safe for an external model to call. Prefer
  read-only or bounded actions; keep authorization, destructive operations, and
  other consequential policy in deterministic code behind the tool.
- Reference tools with `functionName` and `functionContext`, and fix provider
  settings with `hardcoded` bindings or namespace-owned `variable` bindings.
- Give each server a name that is unique in the target environment. MCP servers
  have no namespace context, so Flow matches them by name and never deletes them
  as orphans.
- Keep `isPublic` false unless a public MCP endpoint is an explicit requirement.
  Store OAuth client secrets in `SECRET` vari artefacts without committing values.

## Webhooks And Triggers

- Use one webhook JSON file per public endpoint.
- Use one trigger JSON file to route a webhook or error handler to a server
  function.
- Keep webhook, trigger, function name, and function context aligned.
- Scoped syncs skip orphan detection to avoid false deletion reports.

## Artefacts

- `ai-functions/` contains AI Function contracts and portable tool references.
- `mcp-servers/` contains MCP server definitions that expose functions as tools.
- `schemas/` contains JSON Schema contracts.
- `specs/` contains OpenAPI or PolyAPI model source material.
- `webhooks/` contains public HTTP boundary definitions.
- `triggers/` connects webhooks, events, or error handlers to functions.
- `vari/` contains configuration, secret placeholders, retry policy, or token
  cache definitions.
- `tabi/` contains persisted workflow state or lookup tables.
- `jobs/` contains scheduled maintenance or lifecycle tasks.
- `canopy/` contains Canopy UI assets when a project uses them.

Use `vari` for configuration and `tabi` for persisted workflow state.

Scoped Flow pushes skip orphan detection. Full pushes report orphans but delete
them only when `--delete-orphans` is explicitly passed. External resources used
only as portable references must never widen namespace-owned orphan deletion.

Use `POLY_DEPLOY_SKIP_PATHS` to retain sample source without deploying it.
Paths are relative to `workflows/`, and `--paths` does not override exclusions.
Skipped local resources still count in orphan detection. See
[skip sample deployments](SETUP.md#skip-sample-deployments) for the example and
how to re-enable a tutorial.

## Tests

- Keep unit tests beside the code they verify as `*.test.ts`.
- Keep deployed runtime tests as `*.integration.test.ts`, normally in the
  workflow's `server/` folder.
- Gate integration tests that mutate remote state or incur model/provider cost
  behind an explicit environment flag.
- Validate TypeScript, JSON artefacts, and tests together whenever a runtime
  contract changes.
- The AVA runner does not load Flow's `ENVPATH` or enforce `TARGET_ENV_ID`.
  Direct SDK tests use the generated SDK connection; check that target before
  enabling a live test. `RUN_AI_INTEGRATION=true` opts into the weather AI test.
- Run kickstart namespace regression tests with
  `node --test kickstart/kickstart-namespace.test.cjs`; they use temporary copies
  and require no PolyAPI connection.

Current sample limitations and test prerequisites are documented in the
[message-of-the-day guide](../workflows/src/sampleWorkflow/README.md), its
[runtime reference](../workflows/src/sampleWorkflow/OVERVIEW.md),
[utility guide](../workflows/src/utilities/common/OVERVIEW.md), and
[setup guide](SETUP.md#commands). A passing mock-based test does not establish
platform behavior or delivery to an external service.

## Error Handling

- Throw explicit errors for invalid input or unrecoverable boundary failures.
- Catch `unknown` and extract safe messages.
- Log useful identifiers and redacted context.
- Never log secrets.
- Keep global error handlers best-effort and non-throwing.
- Inspect the [common utilities](../workflows/src/utilities/common/OVERVIEW.md)
  before reusing them. Their current implementation can propagate alert
  failures and only filters a fixed set of sensitive context keys; the global
  handler does not yet meet the non-throwing convention above. Choose an alert
  transport available to your tenant and avoid passing sensitive free text.

## Scripts And Tooling

- Use `pnpm` workspaces.
- Use Biome for formatting and linting.
- Use Flow CLI for PolyAPI sync.
- Keep workflow-local support scripts with their workflow. Shared operational
  commands belong in the Flow CLI under `cli/src/commands/`.
- Scripts should preview destructive actions and require explicit confirmation.

Useful commands after selecting the Flow file for this terminal:

```bash
pnpm install
pnpm workflows exec poly setup
pnpm workflows exec poly generate
pnpm check
pnpm workflows test
pnpm workflows test:integration
pnpm workflows push --dry-run
pnpm workflows push
pnpm workflows push:dynamic:dry-run -- src/<workflow>/client/<file>.ts
```

`push:dynamic` is `push` with a dependency-aware function step: a changed
client function is deployed together with every function that embeds it (its
code is bundled into the server functions that use it); everything else syncs
as with `push`. Naming a function, as in the example above, deploys just its
tree: other artefact types join only with `--paths`, `--types` or
`--seed-from`. Always read its dry-run plan first. See
[cli/push-dynamic.md](../cli/push-dynamic.md).

## OpenAPI Spec Training

- Store source specs under `designs/` or `artefacts/specs/`.
- Use `pnpm flow train-openapi` to generate and train PolyAPI models. The
  `train:openapi` command and `pnpm workflows train:openapi` shortcut remain aliases.
- Use context paths that start with `POLYAPI_NAMESPACE`.
- Use `{file}` in the context prompt when training multiple specs into
  file-based child contexts.
- Review generated model JSON before committing it.
- `--dry-run` is an offline preview of the training inputs. `--generate-only`
  calls the platform translator and writes a reviewable `.poly.json` model
  without registering resources; it is not an offline mode.
- Retry reviewed saved models with `pnpm flow train-model <model.poly.json>`.
  Use `--overwrite-model` only when intentionally regenerating existing models.
- Training registers outbound API Functions. A normal Flow push does not train
  specs, and training does not invoke the external provider. Follow the
  [training reference](../cli/README.md#openapi-training) for naming, target
  verification, and SDK generation.

## Agents And Skills

This template does not vendor skills. Kickstart installs the general, common,
and TypeScript skill folders, including `api-function-training`. For a manual
checkout, bring in relevant skills from:

<https://github.com/polyapi/poly-skills>

Keep skills generic unless the repository is no longer a template. If skill
guidance conflicts with checked-in code or artefacts, follow the checked-in
implementation and update stale docs.

## Development Workflow

1. Inspect a comparable workflow or utility.
2. Update TypeScript, artefacts, and tests together.
3. Run targeted tests.
4. Run `pnpm check`.
5. Run a dry-run Flow sync before applying remote changes.

## Pre-Commit Checks

Before committing, run these commands with your Flow file already selected:

```bash
pnpm check
pnpm workflows test
pnpm workflows push --dry-run
```

Skip the dry run only when the change is documentation-only or tooling-only and
does not affect deployable artefacts.

## Review Checklist

- Are locally owned contexts under `POLYAPI_NAMESPACE`?
- Do portable references use exact names and contexts without remote IDs?
- Are TypeScript, artefacts, and tests aligned?
- Does every webhook have an intentional trigger?
- Are secrets represented only as placeholders?
- Did destructive scripts require explicit confirmation?
- Did docs avoid project-specific assumptions?
