# Project Conventions

This file is the human-readable conventions reference for a TypeScript PolyAPI
project created from this template. If this file drifts from the checked-in
implementation under `workflows/src/` or `cli/`, follow the implementation.

## Workflow Structure And Naming

Deployable workflows live under `workflows/src/<workflowName>/`. Shared
implementations live under `workflows/src/utilities/`; upstream design material
that is not owned by one workflow lives under `designs/`.

```text
workflows/src/<workflowName>/
  OVERVIEW.md or README.md
  artefacts/
    ai-functions/
    canopy/
    jobs/
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

Only create folders the workflow needs. Keep one workflow per folder, use
descriptive camelCase workflow and function names, and keep one primary server
or client function per TypeScript file. Place deployed integration tests beside
the relevant runtime boundary, normally under `server/`.

The checked-in spelling is `artefacts/`. Flow also reads legacy `artifacts/`
paths for compatibility, but new files must use `artefacts/`.

## Environment Files

- Keep real environment files out of Git.
- Commit only `*.env.example` files with placeholder values.
- Use `ENVPATH` when running Flow against a specific environment file.
- Required values are `POLYAPI_NAMESPACE`, `BASE_URL`, and `API_KEY`.
- Do not log environment values that may contain secrets.

Example:

```bash
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
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
          -> webhooks -> triggers -> jobs
```

- Use generated `schemas.*`, `vari.*`, and `tabi.*` namespaces directly when
  they represent the platform contract.
- Import runtime helpers directly from `polyapi`.
- Keep function `polyConfig` aligned with webhook and trigger artefacts.
- Treat `poly.*`, `vari.*`, `tabi.*`, environment variables, files, HTTP, and
  webhook payloads as boundaries.

## Namespaces And Portable References

- `POLYAPI_NAMESPACE` is mandatory.
- Every context belonging to a locally managed artefact, plus every TypeScript
  `polyConfig.context`, must start with that namespace.
- Replace the template's `example` root consistently in artefact contexts,
  generated SDK paths, and trigger error-handler paths when adopting the
  template for another namespace.
- Portable references use exact names and contexts instead of remote IDs.
- API, server, and client function references—and webhook references—may point
  to any accessible environment, tenant, or public resource. Those external
  reference contexts do not need to start with `POLYAPI_NAMESPACE`.
- Variable references remain namespace-scoped.
- Never check in environment-specific `id`, `variableId`,
  `systemPromptVariableId`, or `contextName` fields in portable artefacts.

## Server Functions

- Server functions live under `workflows/src/<workflowName>/server/`.
- Each server function should expose one default async entrypoint.
- Keep deployment metadata in the TypeScript file's inline `polyConfig`; do not
  create parallel server-function JSON metadata files.
- Set HTTP status explicitly only at webhook boundary handlers that own the
  response semantics.
- Fail fast on invalid external input.
- Keep the main path readable from top to bottom.

## Client Functions

- Client functions live under `workflows/src/<workflowName>/client/`.
- Keep deployment metadata in the TypeScript file's inline `polyConfig`; do not
  create parallel client-function JSON metadata files.
- Use client functions for reusable calls or transformations that are safe to
  invoke from other PolyAPI functions.
- Do not hide platform calls behind broad wrappers unless the wrapper removes
  real duplication.

## AI Functions

- AI Function JSON artefacts live under `artefacts/ai-functions/`.
- Keep the prompt directly in `systemPrompt` by default. Use a prompt vari only
  when externally managed prompt content is explicitly required.
- Reference tools with `functionName` and `functionContext`; reference tool
  credentials with `variableName` and `variableContext`.
- Use API, server, or client functions as tools only when they provide
  authoritative facts or bounded deterministic actions.
- Define focused arguments and a strict output schema. Keep authorization,
  persistence, destructive actions, and other consequential policy in
  deterministic code.
- Put credentials in `SECRET` vari artefacts without committing a value.
- Test deployed AI Function behavior with an opt-in `.integration.test.ts`
  file so normal test runs do not incur model or external API cost.

## Webhooks And Triggers

- Use one webhook JSON file per public endpoint.
- Use one trigger JSON file to route a webhook or error handler to a server
  function.
- Keep webhook, trigger, function name, and function context aligned.
- Scoped syncs skip orphan detection to avoid false deletion reports.

## Artefacts

- `ai-functions/` contains AI Function contracts and portable tool references.
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

## Tests

- Keep unit tests beside the code they verify as `*.test.ts`.
- Keep deployed runtime tests as `*.integration.test.ts`, normally in the
  workflow's `server/` folder.
- Gate integration tests that mutate remote state or incur model/provider cost
  behind an explicit environment flag.
- Validate TypeScript, JSON artefacts, and tests together whenever a runtime
  contract changes.

## Error Handling

- Throw explicit errors for invalid input or unrecoverable boundary failures.
- Catch `unknown` and extract safe messages.
- Log useful identifiers and redacted context.
- Never log secrets.
- Keep global error handlers best-effort and non-throwing.
- Use the common template alerting utilities as the default; customize alert
  names or transports in project code when a workflow needs different routing.

## Scripts And Tooling

- Use `pnpm` workspaces.
- Use Biome for formatting and linting.
- Use Flow CLI for PolyAPI sync.
- Keep workflow-local support scripts with their workflow and shared scripts
  under `workflows/src/utilities/common/scripts/`.
- Scripts should preview destructive actions and require explicit confirmation.

Useful commands:

```bash
pnpm install
pnpm workflows exec poly setup
pnpm workflows exec poly generate
pnpm check
pnpm workflows test
ENVPATH=workflows/dev.env pnpm workflows test:integration
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
ENVPATH=workflows/dev.env pnpm workflows push
```

## OpenAPI Spec Training

- Store source specs under `designs/` or `artefacts/specs/`.
- Use `pnpm workflows train:openapi` to generate and train PolyAPI models.
- Use context paths that start with `POLYAPI_NAMESPACE`.
- Use `{file}` in the context prompt when training multiple specs into
  file-based child contexts.
- Review generated model JSON before committing it.

## Agents And Skills

This template intentionally does not vendor skills. Bring in relevant skills
from:

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

Before committing, run:

```bash
pnpm check
pnpm workflows test
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
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
