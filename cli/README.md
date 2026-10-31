# Flow CLI

Flow is the workspace-local CLI used to validate and sync TypeScript PolyAPI
functions and JSON artefacts.

## Commands

```bash
pnpm --filter flow-cli run build
pnpm --filter flow-cli run generate
flow push
flow push --dry-run
flow push --paths exampleWorkflow
flow push --types canopy,functions,ai-functions,webhooks,triggers,subscriptions
flow push --delete-orphans
flow push --skip-validation "I know what am doing"
flow train:openapi designs/ --context 'example.apis.{file}'
flow delete:content --type api --context example.apis --dry-run
flow logs <function-id> --keyword error
```

When called through the workflows package:

```bash
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
ENVPATH=workflows/dev.env pnpm workflows push
```

From the workspace root, the operational commands also have package shortcuts
that build Flow before running it:

```bash
pnpm flow train:openapi [spec-file-or-folder] --context 'example.apis.{file}'
pnpm flow delete:content --type api --context example.apis --dry-run
pnpm flow logs <function-id> --logs-page-size 100 --keyword error
```

The existing `pnpm workflows train:openapi` and `pnpm workflows delete:content`
shortcuts remain supported; `pnpm workflows logs` is also available. Use
`--help` on any of these commands for options. The old common shell scripts
are no longer needed.

### OpenAPI training

`flow train:openapi` accepts a spec file or a folder containing OpenAPI 3 or
Swagger 2 JSON/YAML files. Missing path and context arguments are prompted for
interactively. `{file}` in the context is replaced by each spec's base name.
Generated `*.poly-model.json` files are saved beside the source specs and are
excluded from subsequent spec discovery. Flow trains each generated model and
regenerates the workflow SDK after a successful run. `--dry-run` previews the
specs and contexts without writing files or changing PolyAPI. YAML parsing
runs within Flow; Swagger 2 conversion uses the workspace's installed
`swagger2openapi`, so no global `jq` or `yq` installation is needed.

### Function logs

`flow logs <function-id>` uses the selected Flow environment to fetch server
function logs. It supports `--logs-page` (default 1), `--logs-page-size`
(default 100), `--keyword`, and `--limit` (defaults to the page size). Output
includes log entries and pagination metadata. `--raw` prints the original
response. Omitting the ID prompts for it. Reading logs does not trigger write
or production confirmations.

### Content deletion

`flow delete:content` lists resources under an exact context and its
dot-separated descendants. Supported types are `api`, `schema`, `variable`,
`webhook`, `trigger`, `table`, and `job`; missing type/context arguments are
prompted for. The context must belong to a configured namespace. The command
prints a preview and requires the exact confirmation `DELETE` before making
any deletes. `--dry-run` previews the matches without deleting.

Training and content deletion reuse Flow's branch/environment and production
safeguards. Content deletion uses the shared API client and OTP handling;
training delegates model generation/training and SDK generation to the
workflow's installed Poly CLI, which retains its authentication handling.

`--skip-validation` bypasses interactive scope, branch-environment, and
production confirmation prompts only when its value exactly matches
`I know what am doing`. It does not bypass the production execution key,
schema validation, artefact validation, or unresolved environment-value checks.

After a successful push, Flow regenerates the workflow SDK with
`pnpm workflows exec poly generate` unless `--skip-generate` is set. It removes
the inherited `npm_config_recursive` setting, including case variants, from
that child process's environment. This prevents npm's unknown-config warning
when the Poly CLI checks its version. Other environment settings are preserved.
Direct SDK-generation commands outside Flow do not use this filtering.

## Environment

Required project setting in `workflows/dev.env` (or the file selected by
`ENVPATH`):

```env
POLYAPI_NAMESPACE=example
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

Optional values:

```env
POLYAPI_OPENAPI_SPEC_URL=https://eu1.polyapi.io/swagger-json
OTP_ENABLED=true
```

Use `ENVPATH` to point Flow at the local environment file for the target
environment.

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
