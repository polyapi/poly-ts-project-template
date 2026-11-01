# Flow CLI

Flow is the workspace-local CLI used to validate and sync TypeScript PolyAPI
functions and JSON artefacts.

## Commands

Run commands from the repository root. For dependency setup and the full local
check/test command list, see [setup and development](../docs/SETUP.md).

```bash
pnpm --filter flow-cli run build
pnpm --filter flow-cli run generate
flow push
flow push --dry-run
flow push --paths exampleWorkflow
flow push --types canopy,functions,ai-functions,webhooks,triggers,subscriptions
flow push --delete-orphans
flow push --skip-validation "I know what am doing"
flow train-openapi designs/ --context 'example.apis.{file}'
flow delete-content --type api --context example.apis --dry-run
flow logs <function-id> --keyword error
```

When called through the workflows package, select the Flow file once for the
terminal session:

```bash
export ENVPATH=workflows/dev.env
pnpm workflows push --dry-run
pnpm workflows push
```

From the workspace root, the operational commands also have package shortcuts
that build Flow before running it:

```bash
pnpm flow train-openapi [spec-file-or-folder] --context 'example.apis.{file}'
pnpm flow delete-content --type api --context example.apis --dry-run
pnpm flow logs <function-id> --logs-page-size 100 --keyword error
```

The existing `pnpm workflows train:openapi` and `pnpm workflows delete:content`
shortcuts remain supported; `pnpm workflows logs` is also available. Use
`--help` on any of these commands for options. The old common shell scripts
are no longer needed.

### Self-update

Update the CLI from `polyapi/poly-ts-project-template` using your existing
GitHub SSH access:

```bash
pnpm flow run self-update --check
pnpm flow run self-update
```

`--check` downloads and compares the template without changing your project.
The update command shows the replacement plan and asks for confirmation. Use
`--yes` to authorize it without an interactive prompt. Keep `run` in these
commands because `self-update` is also a pnpm command.

The updater records the exact template commit, saves your current CLI source
under `.flow/updates/<update-id>/`, replaces the source, and runs local build
and test checks. Added and uncommitted custom source is included in the backup.
Backups include checked-in schemas and type declarations; dependencies,
compiled output, and credentials are excluded. Unsupported files
or links stop the update before replacement.

Installed dependencies are preserved. If the old and incoming CLI dependency
declarations differ, the updater stops before replacement and reports the
required changes. Review them with your coding agent and approve dependency
changes before retrying. Flow does not run package installation, replace the
project's root package configuration or lockfile, or invoke Poly setup,
generation, or deployment during an update.

After a successful update, copy the printed compatibility prompt into your
coding agent. The prompt includes the backup and change-report paths so the
agent can inspect extensions inside and outside `cli/`, adapt intended
customizations, preserve upstream fixes and environment safeguards, and run
local checks. The updater does not automatically merge custom code. Without
an original template baseline, differences cannot all be classified as user
customizations; the agent should flag ambiguous changes for clarification.
Changes remain uncommitted for review.

#### Recovery

A failed build or local verification restores the previous source. To undo a
completed update, restore the latest backup or select its ID:

```bash
pnpm flow run self-update --rollback
pnpm flow run self-update --rollback UPDATE_ID
```

Rollback asks for confirmation; `--yes` also applies to rollback. Each backup
contains an independent `restore.cjs` script. Use the exact recovery command
printed by the updater if Flow itself can no longer run:

```bash
node .flow/updates/UPDATE_ID/restore.cjs
```

Replace `UPDATE_ID` with the printed backup ID. Keep the backup until you have
completed the compatibility review. Backups are local recovery files and
should remain ignored by Git.

Rollback restores source and preserves installed dependencies. Rebuild with
`pnpm --filter flow-cli run build` afterward. Source edited after an update is
saved in the recovery folder before rollback.

#### Existing projects and template revisions

The updater runs directly with Node.js, even when Flow has not been built.
For a project that does not yet contain the updater, run it from a fresh
template checkout:

```bash
node /absolute/path/to/poly-ts-project-template/cli/bin/self-update.cjs --project /absolute/path/to/project
```

The default source is `git@github.com:polyapi/poly-ts-project-template.git`,
and the default revision is `main`. Select a branch, tag, or commit with
`--ref`. To test an unpublished template revision, use a local Git checkout:

```bash
pnpm flow run self-update --check --source /absolute/path/to/template --ref main
```

`--source` reads committed Git content; uncommitted template edits are not
included. The downloaded template is temporary, and `gh` is not required.

### Workflow operations

The Flow CLI validates and synchronizes the artefact types documented in
[CONVENTIONS.md](../docs/CONVENTIONS.md#artefacts). It supports scoped `--paths` and
`--types` pushes, dry runs, production safeguards, and explicit orphan
deletion. See the command reference below for payload details.

Flow also provides OpenAPI training, scoped content deletion, and function logs:

```bash
pnpm flow train-openapi designs/ --context 'demo.apis.{file}'
pnpm flow delete-content --types api-functions,schemas --context demo.apis
pnpm flow logs <function-id> --keyword error
```

These commands use the same Flow environment configuration (`ENVPATH` when
specified). Training and deletion retain branch/environment and production
confirmations. Deletion previews matching resources and requires typing
`DELETE`; use `--dry-run` to preview without deleting. The existing
`pnpm workflows train:openapi` and `pnpm workflows delete:content` shortcuts
remain available and now invoke Flow.

### OpenAPI training

Keep upstream specifications under `designs/` or a workflow-local
`artefacts/specs/` folder. For an interactive spec/context prompt, run:

```bash
pnpm flow train-openapi
```

```bash
pnpm flow train-openapi designs/crm.json --context example.crm --operation-id validatePhone --operation-id getProfile
pnpm flow train-openapi designs/crm.json --context example.crm --generate-only
pnpm flow train-model designs/crm.poly.json
```

Training accepts OpenAPI 3 and Swagger 2 JSON/YAML, a file or recursively searched
folder, and `{file}` in the target context. Omit source/context to be prompted.
Repeat `--operation-id ID` to select original specification operation IDs before
translation and AI enrichment. Each ID must match exactly once in each input
specification; only selected operations and their referenced schemas are retained.
Selection requires bundled local references; bundle external `$ref` files first.
Omitting the option trains all operations. `hostUrl` remains a function argument.

Descriptions become readable plain text, including argument and schema metadata,
after AI enrichment. Source specifications, request payloads, examples and defaults
stay unchanged. Invalid schema identifiers such as `200` become `Schema200` in a
temporary copy with references updated. `--disable-ai` keeps translated names and
metadata; repeat `--rename FROM TO` to explicitly rename generated identifiers.

`--generate-only` writes `*.poly.json` models without training resources. Existing
models require `--overwrite-model`; saved models can be retried with `train-model`,
including legacy `*.poly-model.json` files. `--dry-run` previews inputs without
provider calls or writes; for `train-model` it validates and previews resources.
Flow validates all models and cross-file identities before writing resources,
orders schemas by dependency, preserves valid recursive references, and verifies resource existence
after training. Writes run in bounded batches; an error prevents later batches.
Saved models remain available for retry after partial failure. SDK generation runs
after successful training unless `--skip-generate` is supplied.

The `train:openapi` command and workflows shortcut remain aliases. New models use
`*.poly.json`; both model suffixes are excluded from specification discovery.

### Function logs

`flow logs <function-id>` uses the selected Flow environment to fetch server
function logs. It supports `--logs-page` (default 1), `--logs-page-size`
(default 100), `--keyword`, and `--limit` (defaults to the page size). Output
includes log entries and pagination metadata. `--raw` prints the original
response. Omitting the ID prompts for it. Reading logs does not trigger write
or production confirmations.

### Content deletion

```bash
pnpm flow delete-content --types api-functions,schemas --context example.crm
pnpm flow delete-content --types api-functions,schemas --context example.crm --include-children --apply
```

Deletion previews only by default and selects the exact context. Add
`--include-children` to include dot-separated descendant contexts, and `--apply`
to request deletion with the separate exact `DELETE` confirmation. `--dry-run`
also previews only. Types may be combined: `api-functions`, `client-functions`,
`server-functions`, `ai-functions`, `schemas`, `variables`, `webhooks`, `triggers`,
`tables`, `jobs`, and `subscriptions`. Singular names and `--type` remain aliases.
The `delete:content` alias uses these same safer defaults.

Every delete must be followed by a 404 readback; uncertainty stops the command.
Jobs and triggers qualify only when every referenced server function is known
and inside the selected scope. Dependents are deleted before functions/schemas.
Scope is namespace-owned and context-based, without an inferred cross-context
cascade. Previews show metadata only, never resource values.

Training and deletion use Flow's branch/environment and production safeguards.
Resource writes, readbacks and deletion use its shared authenticated API client
and OTP handling. Model translation/enrichment and TypeScript SDK generation use
the workflow's installed Poly CLI with Flow's resolved connection.

`--skip-validation` bypasses interactive scope, branch-environment, and
production confirmation prompts only when its value exactly matches
`I know what am doing`. It does not bypass target identity, the production
execution key,
schema validation, artefact validation, or unresolved environment-value checks.

After a successful push, Flow regenerates the workflow SDK with
`pnpm workflows exec poly generate` unless `--skip-generate` is set. It removes
the inherited `npm_config_recursive` setting, including case variants, from
that child process's environment. This prevents npm's unknown-config warning
when the Poly CLI checks its version. Other environment settings are preserved.
Direct SDK-generation commands outside Flow do not use this filtering.

## Environment

Required project settings in `workflows/dev.env` (or the file selected by
`ENVPATH`):

```env
POLYAPI_NAMESPACE=example
TARGET_ENV_ID=replace-with-environment-id
```

Flow reuses the connection saved by `pnpm workflows exec poly setup` for the
workflow's installed SDK. You do not need to duplicate its base URL or API key
in `dev.env`. To override that connection for a specific environment, set:

```env
BASE_URL=https://eu1.polyapi.io
API_KEY=replace-with-your-api-key
```

Connection settings are resolved in this order: the selected environment file
(or the default `workflows/dev.env`), shell environment, saved workflow Poly
setup, then legacy root environment settings. Flow supports the SDK names
`POLY_API_BASE_URL` and `POLY_API_KEY` and the older `POLYAPI_*` aliases as well.
It resolves the workflow SDK's own configuration rather than another installed
SDK version's setup.

Kickstart obtains the environment ID from authenticated `GET /whoami` and saves
the pin automatically. For existing projects, run `pnpm flow target-env` and
copy the printed `TARGET_ENV_ID=<id>` into the selected file after verifying the
target. The lookup is read-only and does not change files.

Flow verifies the file's pin against `/whoami` before push (including dry runs),
training/model generation, deletion previews or application, and logs. Missing
or mismatched pins stop the command before resource requests. The pin must be
declared in the selected file; shell exports, saved SDK setup, and legacy root
fallback cannot supply it. Production exemptions and `--skip-validation` do
not bypass this check. Offline `train-openapi --dry-run`, `train-model --dry-run`,
help, and `--show-config` do not require target verification.

Optional values:

```env
POLYAPI_OPENAPI_SPEC_URL=https://eu1.polyapi.io/swagger-json
OTP_ENABLED=true
```

Export `ENVPATH` once to select the local target file for the terminal session.
Flow defaults to `workflows/dev.env` when it is unset. A bare filename such as
`export ENVPATH=dev.env` searches `workflows/` first; the explicit
`export ENVPATH=workflows/dev.env` form is unambiguous. This selects Flow
configuration without loading that file into the parent shell or direct SDK
calls. See [environment selection](../docs/SETUP.md#select-a-flow-environment).

When `OTP_ENABLED=true`, Flow prompts for an OTP at the first write request
and sends it as `x-otp` on its POST, PUT, PATCH, and DELETE requests, including
Canopy updates. Input is hidden and the code is reused for that Flow run.
Read requests and dry runs do not prompt. OTP-enabled writes require an
interactive terminal; Flow does not read the OTP code from the environment.
Function deployment through the Poly CLI retains that CLI's authentication
handling.

`build` compiles TypeScript. `generate` and `postinstall` refresh
`src/sdk/schema.d.ts` from `POLYAPI_OPENAPI_SPEC_URL` (or the default URL above).

## What Flow Scans

- `src/**/server/*.ts`
- `src/**/client/*.ts`
- `src/**/artefacts/schemas/*.json`
- `src/**/artefacts/webhooks/*.json`
- `src/**/artefacts/triggers/*.json`
- `src/**/artefacts/subscriptions/*.json`
- `src/**/artefacts/vari/**/*.json`
- `src/**/artefacts/tabi/*.json`
- `src/**/artefacts/jobs/*.json`
- `src/**/artefacts/ai-functions/*.json`
- `src/**/artefacts/canopy/*.json`

The legacy `artifacts/` spelling is also supported for the same artefact folders.

Function metadata is read from inline `polyConfig` objects.

Canopy JSON can include an application `description`. Flow synchronizes it as
application metadata; `id`, `description`, and `visibility` are kept outside
the rendered application config. Omitting `description` preserves the remote
application's description. `visibility` is applied when creating an application.

AI functions are JSON artefacts. References are portable and are resolved to
remote IDs during sync:

Function and webhook references are resolved by exact `name` and `context`
across accessible environment, tenant, and public resources. Their contexts do
not need to start with `POLYAPI_NAMESPACE`; namespace filtering still applies
to locally managed artefacts and orphan detection/deletion.

```json
{
  "name": "upliftingWeather",
  "context": "example.sampleAiFx",
  "description": "Returns accurate, practical, and encouraging weather guidance tailored to an optional activity.",
  "visibility": "ENVIRONMENT",
  "state": "ALPHA",
  "enabled": true,
  "type": "TEXT",
  "provider": "openai",
  "apiType": "responses",
  "model": "gpt-5.5",
  "arguments": [
    {
      "key": "location",
      "type": "string",
      "required": true,
      "description": "A village, city, region, country, or other location description."
    },
    {
      "key": "activity",
      "type": "string",
      "required": false,
      "description": "An optional activity for which the weather is relevant."
    }
  ],
  "systemPrompt": "Use the weather tools for all weather facts. Resolve the requested location, retrieve current conditions, and provide concise practical guidance tailored to the activity when supplied. Preserve safety warnings, avoid invented facts, and close with a brief sincere uplifting message.",
  "inputTemplate": "Provide weather guidance for {{location}} in the context of {{activity}} when supplied.",
  "clientPromptEnabled": false,
  "clientPromptRequired": false,
  "clientPromptArgName": "",
  "toolFunctions": [
    {
      "functionName": "search",
      "functionContext": "accuWeather.locations",
      "argumentConfig": [
        { "key": "locationText", "source": "ai" },
        {
          "key": "apiKey",
          "source": "variable",
          "variableName": "weatherApiKey",
          "variableContext": "example.sampleAiFx"
        }
      ]
    },
    {
      "functionName": "getByLocationKey",
      "functionContext": "accuWeather.currentConditions",
      "argumentConfig": [
        { "key": "locationId", "source": "ai" },
        {
          "key": "apiKey",
          "source": "variable",
          "variableName": "weatherApiKey",
          "variableContext": "example.sampleAiFx"
        }
      ]
    }
  ],
  "outputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "location",
      "currentWeather",
      "description",
      "recommendedItems",
      "upliftingMessage"
    ],
    "properties": {
      "location": { "type": "string" },
      "currentWeather": {
        "type": "object",
        "additionalProperties": false,
        "required": ["condition", "temperature", "unit"],
        "properties": {
          "condition": { "type": "string" },
          "temperature": { "type": "number" },
          "unit": { "type": "string", "enum": ["C", "F"] }
        }
      },
      "description": { "type": "string" },
      "recommendedItems": {
        "type": "array",
        "items": { "type": "string" }
      },
      "upliftingMessage": { "type": "string" }
    }
  }
}
```

Use `--types ai-functions` to sync only these artefacts. Flow creates them with
`POST /functions/ai`, sends changed mutable fields only with `PATCH
/functions/ai/{id}`, and supports safe orphan reporting/deletion.

All artefact payloads also support `{{ENV_VAR_NAME}}` placeholders. During sync,
placeholders are substituted from the selected env file values. Missing values are
left unchanged and reported before sync.

## Safe Deletion

Flow reports remote resources that exist under the namespace but are not present
locally. It does not delete them unless `--delete-orphans` is explicitly passed.

Use `--dry-run` before pushing changes to a shared environment.
