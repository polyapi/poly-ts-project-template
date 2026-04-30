# Project Conventions

This file is the human-readable conventions reference for a TypeScript PolyAPI
project created from this template. If this file drifts from the checked-in
implementation under `workflows/src/` or `cli/`, follow the implementation.

## Project Structure And Naming

- Deployable workflows live under `workflows/src/<workflowName>/`.
- Shared reusable implementations live under `workflows/src/utilities/`.
- Upstream design material and OpenAPI specs live under `designs/` or
  workflow-local `artefacts/specs/`.
- Keep one workflow per folder.
- Use descriptive camelCase workflow and function names.
- Keep one primary server or client function per TypeScript file.

Common workflow subfolders:

- `artefacts/`
- `client/`
- `server/`
- `types/`

Common artefact subfolders:

- `schemas/`
- `specs/`
- `webhooks/`
- `triggers/`
- `vari/`
- `tabi/`
- `jobs/`
- `canopy/`

Not every workflow needs every folder, but keep the structure aligned with
nearby maintained workflows.

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

PolyAPI runtime flow is:

```text
schemas -> webhooks -> triggers -> functions
```

- Use generated `schemas.*`, `vari.*`, and `tabi.*` namespaces directly when
  they represent the platform contract.
- Import runtime helpers directly from `polyapi`.
- Keep function `polyConfig` aligned with webhook and trigger artefacts.
- Treat `poly.*`, `vari.*`, `tabi.*`, environment variables, files, HTTP, and
  webhook payloads as boundaries.

## Server Functions

- Server functions live under `workflows/src/<workflowName>/server/`.
- Each server function should expose one default async entrypoint.
- Set HTTP status explicitly only at webhook boundary handlers that own the
  response semantics.
- Fail fast on invalid external input.
- Keep the main path readable from top to bottom.

## Client Functions

- Client functions live under `workflows/src/<workflowName>/client/`.
- Use client functions for reusable calls or transformations that are safe to
  invoke from other PolyAPI functions.
- Do not hide platform calls behind broad wrappers unless the wrapper removes
  real duplication.

## Webhooks And Triggers

- Use one webhook JSON file per public endpoint.
- Use one trigger JSON file to route a webhook or error handler to a server
  function.
- Keep webhook, trigger, function name, and function context aligned.
- Scoped syncs skip orphan detection to avoid false deletion reports.

## Artefacts

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

## Error Handling

- Throw explicit errors for invalid input or unrecoverable boundary failures.
- Catch `unknown` and extract safe messages.
- Log useful identifiers and redacted context.
- Never log secrets.
- Keep global error handlers best-effort and non-throwing.
- Add project-specific alerting integrations only in project code, not in this
  generic template.

## Scripts And Tooling

- Use `pnpm` workspaces.
- Use Biome for formatting and linting.
- Use Flow CLI for PolyAPI sync.
- Keep local support scripts under `workflows/src/utilities/scripts/`.
- Scripts should preview destructive actions and require explicit confirmation.

Useful commands:

```bash
pnpm check
pnpm workflows test
pnpm workflows push:dry-run
pnpm workflows push
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

- Are contexts under `POLYAPI_NAMESPACE`?
- Are TypeScript, artefacts, and tests aligned?
- Does every webhook have an intentional trigger?
- Are secrets represented only as placeholders?
- Did destructive scripts require explicit confirmation?
- Did docs avoid project-specific assumptions?
