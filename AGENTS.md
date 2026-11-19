# AGENTS.md

**Generic PolyAPI TypeScript workspace** with workflow code under
`workflows/` and sync tooling under `cli/`.

Docs: <https://docs.polyapi.io/platform_overview.html>

## Scope

- Applies to all work started from this repo.
- Covers repo-wide source-of-truth order, runtime model, environment, and task
  routing.
- Optional local implementation guidance can live under `./.agents/skills/`.

## Source Of Truth

1. This `AGENTS.md` for repo-wide rules
2. Checked-in executable code and JSON artefacts under `workflows/src/`, plus
   checked-in tooling under `cli/`
3. `docs/CONVENTIONS.md`
4. Relevant installed skills under `./.agents/skills/`
5. `README.md`
6. Same-folder `OVERVIEW.md` files and maintained project docs

If docs or skills conflict with checked-in code or artefacts, follow the
checked-in implementation and call out the drift clearly.

## Runtime Model

- PolyAPI runtime flow is: schemas -> webhooks -> triggers -> functions.
- Keep TypeScript, JSON artefacts, and tests aligned in the same change.
- `workflows/src/` holds workflows and shared utilities.
- `cli/` holds Flow CLI validation, generation, and sync tooling.
- `designs/` holds upstream specs and schema source material.
- This repo uses the checked-in `artefacts/` folder spelling.
- `POLYAPI_NAMESPACE` is mandatory. All deployed artefacts must keep a
  `context` starting with that namespace, for example `example.workflow`.

## Environment And Tooling

- Package manager: `pnpm` workspaces.
- Formatter and linter: Biome.
- SDK dependency lives in `workflows/package.json`. Do not upgrade casually.
- The default workflow SDK uses the `na1` package tag, with its resolved release
  recorded in `pnpm-lock.yaml`. Kickstart installs the tag for the user's chosen
  instance instead; SDK selection does not select credentials or the target pin.
- Never commit secrets or log them.
- Required settings in the selected Flow environment file:

```env
POLYAPI_NAMESPACE=example
TARGET_ENV_ID=replace-with-environment-id
```

- Flow uses the connection saved by the workflow SDK's `poly setup` by default.
  `BASE_URL` and `API_KEY` (or SDK aliases) are optional per-field overrides.
- Kickstart saves the authenticated `/whoami` environment ID automatically.
  `pnpm flow target-env` prints it for manual setup without editing files.
- Preserve the selected file's target pin and live identity check for all remote
  Flow commands, including deployment dry runs, deletion previews, and logs.
  Shell exports, production exemptions, and confirmation bypasses must not
  bypass target verification. Offline training previews need no live identity.

- Common command path:

```bash
pnpm install
pnpm workflows exec poly setup
pnpm workflows exec poly generate
pnpm check
pnpm workflows test
ENVPATH=workflows/dev.env pnpm workflows test:integration
ENVPATH=workflows/dev.env RUN_MUTATING_INTEGRATION=true pnpm workflows test:integration:mutating
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
ENVPATH=workflows/dev.env pnpm workflows push
```

## Skill Entry Points

This template does not include skills by default. Install them from
<https://github.com/polyapi/poly-skills> with `pnpm flow skills add`, choosing
Coding in TypeScript, and refresh them with `pnpm flow skills update`. Flow
records the selection in `.agents/flow-skills.json`.

The TypeScript setup covers these skill categories:

- TypeScript coding conventions
- PolyAPI SDK usage
- Artefact layout and sync
- PolyAPI runtime testing
- Markdown documentation
- Overview generation

## Change Workflow

1. Inspect a comparable maintained workflow or utility before inventing new
   patterns.
2. Edit code, artefacts, and tests together.
3. Run the relevant checked-in verification path.
   - Use local unit tests for branch logic.
   - Use deployed integration tests for platform runtime behavior.
   - Gate integration tests that mutate external systems behind an explicit
     environment flag.
4. Update same-folder `OVERVIEW.md` when runtime behaviour changes.
5. Keep changes deterministic, reviewable, and easy to verify.

## Repo Guardrails

- Flow's version lives in `cli/package.json`, independently of the workflow SDK.
  Starting with the versioned 1.1.0 baseline, bump the patch for fixes, the minor
  version for backward-compatible features, and the major version for breaking
  changes when preparing the next release. Group related unreleased changes in
  one release; do not bump again for every edit to that release. Keep version
  commands and upgrade reports reading that single source of truth. Creating
  release commits, tags, or pushes still requires the user's instruction.
- Do not loosen schemas or webhook contracts just to make a change pass.
- Version breaking contract changes instead of silently mutating existing
  behaviour.
- Do not add a new workflow without the aligned artefact set and tests.
- Do not create ad hoc documentation files unless they are useful to maintain.
  Same-folder `OVERVIEW.md` files are the default workflow documentation.
- Call out documentation drift when skills or prose no longer match the
  checked-in implementation.

## Security Constraints

- Never read, copy, commit, or summarize `.env`, `.env.*`, `*.env`, or files
  containing secrets or credentials.
- Never access files with extensions such as `.key`, `.pem`, `.p12`, `.pfx`,
  or `.crt`.
- Do not log secrets, tokens, API keys, connection strings, or raw credentials.
- Use placeholder values only in example environment files.
- Require human approval before changing dependency versions, CI/CD, or
  production deployment safeguards.
