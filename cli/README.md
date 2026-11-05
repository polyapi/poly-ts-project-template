# Flow CLI

Flow is the workspace-local CLI used to validate and sync TypeScript PolyAPI
functions and JSON artefacts.

For the step-by-step upgrade paths, see [Upgrading Flow](../docs/UPGRADING_FLOW.md).
Check the installed version with `pnpm flow run version` (or `flow --version`).
The version comes from `cli/package.json` and is separate from the PolyAPI SDK.

## Commands

Run commands from the repository root. For dependency setup and the full local
check/test command list, see [setup and development](../docs/SETUP.md).

```bash
pnpm --filter flow-cli run build
pnpm --filter flow-cli run generate
flow push
flow push --dry-run
flow push --paths exampleWorkflow
flow push --types canopy,functions,ai-functions,mcp-servers,webhooks,triggers,subscriptions
flow push --delete-orphans
flow push --skip-validation "I know what am doing"
flow push-dynamic --dry-run
flow push-dynamic --dry-run src/utilities/common/client/log.ts
flow push-dynamic --hubs
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
pnpm workflows push:dynamic:dry-run
pnpm workflows push:dynamic -- src/<workflow>/client/<file>.ts
```

`push-dynamic` is `push` with a dependency-aware function step: the same
pipeline, options, scope prompt and safeguards, but functions are handled by
building the local `poly.*` call graph, seeding it with the functions named
on the command line (forced: deployed even when unchanged; the run then skips
the other artefact types unless `--paths`, `--types` or `--seed-from` is given,
and never touches orphans) or, when none
are named, with the files whose code differs from the target environment,
expanding each seed through its client-function callers up to the first
server function on every path, and deploying the whole tree in dependency
order. `--dry-run` prints the seeds, the caller tree and the ordered plan
without touching the platform; `--json` exports the plan; `--hubs`, `--why` and
`--json` are report-only and imply `--dry-run`. See
`flow push-dynamic --help` and [push-dynamic.md](push-dynamic.md).

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

### One-time upgrade for older projects

If your project has an older Flow CLI without `self-update`, run this one-line
command from your **existing project root**. It downloads a temporary template
checkout and runs the upgrade using your existing GitHub SSH access:

```bash
(flow_tmp=$(mktemp -d) && trap 'rm -rf -- "$flow_tmp"' EXIT && git clone --depth 1 git@github.com:polyapi/poly-ts-project-template.git "$flow_tmp" && bash "$flow_tmp/cli/upgrade.sh" --source "$flow_tmp" --project "$PWD")
```

Requires Git, Node.js, pnpm, and access to the template repository. The temporary
checkout is removed when the command finishes; GitHub CLI and HTTP tokens are
not required.

The upgrade backs up your existing CLI source and replaces `cli/` with the
selected template version. It also saves an AI compatibility prompt so your
coding agent can review extensions and reapply intended customizations.

Your root `package.json` and `workflows/package.json` keep their existing
settings, dependency versions, and custom script values. The upgrade adds only
missing Flow launcher scripts. If a script already exists with a different
value, it is preserved and reported for your coding agent to review. The
project's workspace configuration and lockfile are not replaced with template
copies.

For a preview, add `--check` to the `bash` invocation above. You can also run the
script from an existing template checkout:

```bash
bash /absolute/path/to/poly-ts-project-template/cli/upgrade.sh --project "$PWD" --check
bash /absolute/path/to/poly-ts-project-template/cli/upgrade.sh --project "$PWD"
```

If the incoming **CLI** dependency requirements differ, review the displayed
changes and rerun with `--approve-dependency-changes` to authorize replacing
`cli/package.json`. `--yes` authorizes source replacement without a prompt; it
does not approve dependency changes. Root and workflow dependency declarations
remain unchanged.

This initial upgrade replaces source only. It does not install dependencies,
build Flow, regenerate the SDK, or call PolyAPI. After reviewing the report and
reapplying customizations, install dependencies if needed using
`pnpm install --ignore-scripts`, then run:

```bash
pnpm --filter flow-cli run build
pnpm --filter flow-cli run test:self-update
```

Older projects may also need `TARGET_ENV_ID` in their selected Flow environment
file before remote commands, including deployment dry runs, can run. Retrieve
the ID using `ENVPATH=workflows/dev.env pnpm flow target-env`, confirm that it is
the intended environment, then add the returned setting to that file. The
upgrade does not change environment files or choose this pin automatically.

Review any resulting lockfile changes within your project. Future upgrades can
use the [self-update command](#self-update). If a custom root `flow` script was
preserved, use `pnpm --filter flow-cli run self-update` directly until your agent
has reconciled that launcher.

The recovery command printed by the upgrade can restore the previous CLI and
the original contents of package files it changed. If one of those files has
been edited since the upgrade, recovery stops rather than overwrite newer edits.
Keep the backup until the compatibility review and local checks are complete.

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
Use the [one-time upgrade](#one-time-upgrade-for-older-projects) to bring an
older project onto this version and preserve its package customizations. For
projects already using the current package layout, the updater can also run
from a separate template checkout:

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

Before saving or training a translated model, Flow restores required header API
keys omitted by translation, using operation security overrides and one security
alternative. Existing Authorization prefixes and native authentication are kept;
missing keys receive separate required string arguments. Ambiguous operation
mappings or invalid security references stop training. The API-key endpoint
validator accepts both native `key` and `value` entries, including after schema
refresh. Already trained functions must be retrained to receive these headers.

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

If Poly reports a client-version mismatch, follow
[SDK instance alignment](../docs/SETUP.md#align-the-sdk-with-your-polyapi-instance).
Use pnpm to update the workflow SDK; decline the SDK's npm-based update prompt.
Flow's self-updater does not change that dependency.

## Environment

Required project settings in `workflows/dev.env` (or the file selected by
`ENVPATH`):

```env
POLYAPI_NAMESPACE=example
TARGET_ENV_ID=replace-with-environment-id
```

`TARGET_ENV_ID` is the intended environment's ID, not a namespace or tenant ID.
It verifies the connection described below; changing it does not switch
credentials. See [pin the target environment](../docs/SETUP.md#pin-the-target-environment)
for the setup walkthrough.

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

To omit bundled samples from deployment scanning, set this in the selected
environment file, adding to any existing exclusions:

```env
POLY_DEPLOY_SKIP_PATHS=src/sampleWorkflow
```

These comma-separated paths are relative to `workflows/`; folder entries include
their descendants. Both deployment previews and pushes honor them, even with
`--paths`. Remove a covering entry before deploying that tutorial. Shared
utilities remain available with the example above. Skipping keeps local files
and existing deployments; skipped local resources still count in orphan
detection. It does not block explicit API training, `delete-content`, or SDK
calls. See [skip sample deployments](../docs/SETUP.md#skip-sample-deployments).

Optional values:

```env
POLYAPI_OPENAPI_SPEC_URL=https://eu1.polyapi.io/swagger-json
OTP_ENABLED=true
# Optional but recommended for server functions deployed with push-dynamic.
# FLOW_EXECUTION_API_KEY=replace-with-your-execution-key
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
- `src/**/artefacts/mcp-servers/*.json`
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

See the [weather AI artefact](../workflows/src/sampleWorkflow/artefacts/ai-functions/upliftingWeather.json)
for a complete example. Its two Open-Meteo tools are trained from the sample's
bundled specifications and need no weather account or API key for evaluation.
Follow [the weather setup](../workflows/src/sampleWorkflow/OVERVIEW.md#weather-ai)
to train those tools in the project namespace before deploying the AI function.
The target still needs the selected AI model and provider.

Each tool argument comes from the model (`ai`), a fixed value (`hardcoded`), a
caller argument (`argument`), or a Vari (`variable`). The sample fixes provider
hosts and units with `hardcoded` bindings; a Vari-backed credential looks like
this:

```json
{
  "functionName": "lookup",
  "functionContext": "example.tools",
  "argumentConfig": [
    { "key": "query", "source": "ai" },
    {
      "key": "token",
      "source": "variable",
      "variableName": "providerToken",
      "variableContext": "example.configuration"
    }
  ]
}
```

Use `--types ai-functions` to sync only these artefacts. Flow creates them with
`POST /functions/ai`, sends changed mutable fields only with `PATCH
/functions/ai/{id}`, and supports safe orphan reporting/deletion.

When comparing AI Function and MCP server tools, Flow ignores fields the
platform adds, but compares each `hardcoded` value whole: removing a property
from a JSON value, or an entry from an array, updates the deployed binding.

## MCP servers

An MCP server exposes selected PolyAPI functions as tools to MCP clients such as
coding agents and chat assistants. Keep each server in
`artefacts/mcp-servers/<name>.json`:

```json
{
  "name": "example-weather-tools",
  "description": "Current weather lookup for MCP clients.",
  "enabled": true,
  "isPublic": false,
  "toolFunctions": [
    {
      "functionName": "searchLocations",
      "functionContext": "example.sampleWorkflow",
      "argumentConfig": [
        { "key": "name", "source": "ai" },
        {
          "key": "hostUrl",
          "source": "hardcoded",
          "value": "https://geocoding-api.open-meteo.com"
        }
      ]
    }
  ]
}
```

Tool references use `functionName` and `functionContext` and resolve against
API and server functions in the target environment, the only tools the MCP
endpoint can call. Client functions run in the caller's process, and functions
shared from other environments or tenants are out of the endpoint's reach;
Flow rejects either kind, with the reason, before writing the server. Each
`argumentConfig` entry uses the AI Function sources: `ai` (the MCP client
supplies it), `hardcoded`, `argument`, or a namespace-owned `variable`.
For OAuth, set `oauthClientId`, `oauthRedirectUris`, and
`oauthClientSecretVariable` with `variableName` and `variableContext`; use
`null` to clear the client ID or secret. Never commit remote IDs such as
`toolFunctionIds`, `oauthClientSecretVariableId`, `environmentId`, or `mcpUrl`.

MCP servers have no namespace context. Flow therefore identifies each one by
its exact `name` in the environment verified by `TARGET_ENV_ID`: it creates the
server when that name is absent and PATCHes only changed fields when it exists.
An artefact's `toolFunctions` list is the server's complete tool list: removing
an entry removes that tool, and Flow also clears the legacy `toolFunctionIds`
of servers created with it, which would otherwise stay callable.
Choose a name that is unique in the target environment; duplicate local or
remote names stop the sync instead of updating an arbitrary server. Because Flow
cannot tell which remote servers belong to this project, it never reports or
deletes MCP servers as orphans, and `delete-content` does not cover them.
Remove retired servers deliberately in PolyAPI.

Flow prints each server's MCP URL, `https://<instance>/mcp-servers/<id>/mcp`,
after it is created, updated, or found unchanged; only `GET /mcp-servers/{id}`
returns it. Use `--types mcp-servers` to sync only these artefacts; deploy the
tool functions first, because unresolved tools stop the server's sync.

MCP clients see each tool as its context and name joined with underscores, for
example `example_sampleWorkflow_searchLocations`, with the function's own
description. Only `ai` arguments become tool inputs: PolyAPI applies
`hardcoded`, `argument`, and `variable` bindings without showing them to the
client, and hardcoded values keep their JSON type.

Access depends on `isPublic`:

- `isPublic: true`: any client with the URL can list and call the tools without
  signing in. Flow warns about it on every push.
- `isPublic: false`: PolyAPI rejects anonymous requests and PolyAPI keys and
  expects an OAuth access token. Without OAuth settings, the server's OAuth
  metadata names no authorization server, so MCP clients cannot sign in.
  Configure `oauthClientId` and `oauthClientSecretVariable` before sharing a
  private server; a complete OAuth sign-in has not yet been verified with Flow.
  When `oauthRedirectUris` is omitted, PolyAPI adds the claude.ai and ChatGPT
  connector callbacks.

All artefact payloads also support `{{ENV_VAR_NAME}}` placeholders. During sync,
placeholders are substituted from the selected env file values. Missing values are
left unchanged and reported before sync.

## Safe Deletion

Flow reports remote resources that exist under the namespace but are not present
locally. It does not delete them unless `--delete-orphans` is explicitly passed.

Use `--dry-run` before pushing changes to a shared environment.
