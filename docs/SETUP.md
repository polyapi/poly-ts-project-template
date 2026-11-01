# Setup and development

[Getting started](../README.md#getting-started) lives on the template homepage.
Use this guide for local tools, manual setup, and development details. Run
commands from the project root.

## Local tools

Use an actively supported Node.js LTS release, such as Node.js 22 or 24,
and this workspace's pinned `pnpm@10.0.0`. Node.js 18 and 20 are end-of-life;
see the [Node.js release schedule](https://nodejs.org/en/about/previous-releases).
The Node.js version on your laptop is separate from the hosted PolyAPI runtime.

Install Node.js using the [official download instructions](https://nodejs.org/en/download),
then follow the [pnpm installation guide](https://pnpm.io/installation), selecting
version `10.0.0` instead of `latest`. For an npm-based pnpm installation:

```bash
npm install --global pnpm@10.0.0
node --version
pnpm --version
```

Use pnpm for this repository's dependencies. The npm command above installs the
package manager only. Commands in these guides use Bash syntax; on Windows, use
Git Bash or WSL. There is no need to change the machine-wide PowerShell execution
policy to follow the Bash instructions.

## Manual setup

These steps are only needed if you did not use kickstart. If you used
kickstart, your project is already configured and you can skip this section.

Install dependencies:

```bash
pnpm install
```

### Align the SDK with your PolyAPI instance

The template defaults to the **NA1 SDK release**: `workflows/package.json`
declares `"polyapi": "na1"`, and `pnpm-lock.yaml` records the resolved version.
The lockfile keeps installs reproducible; `pnpm install` alone does not refresh
the SDK each time NA1 is upgraded. Before manual setup or following a tutorial
in an existing checkout, align the SDK with the instance your project connects
to. **Kickstart already does this for the instance selected during project
creation.** Repeat this step when changing
instances or when Poly reports that your client version differs from the
instance's version.

Choose the package tag from the connection's base URL:

| PolyAPI instance | SDK package tag |
| --- | --- |
| `https://dev.polyapi.io` | `develop` |
| `https://na1.polyapi.io` | `na1` |
| `https://na2.polyapi.io` | `na2` |
| `https://eu1.polyapi.io` | `eu1` |

For a project pointing to **`https://na1.polyapi.io`**, run from the project root:

```bash
pnpm --filter workflows add polyapi@na1
pnpm workflows exec poly setup
pnpm workflows exec poly generate
```

Replace `na1` with the matching tag from the table for another instance. Choose
the tag from the URL, not the environment filename: `workflows/dev.env` can
point to `na1`.

The `add` command updates the SDK dependency in `workflows/package.json` and
the resolved version in `pnpm-lock.yaml`; review and commit those changes with
your project. The tag resolves to a version at installation time; it does not
automatically follow future instance releases. It does not select your
connection or change `TARGET_ENV_ID`.
Run `poly setup` separately afterward with the intended URL and key, then
generate. A changed SDK version can have a different saved-configuration
location under pnpm, so setup may be required again.

If Poly asks **“Update now?”** and proposes `npm install`, choose **No** and
use the pnpm command above. The SDK's npm updater cannot install this project's
`workspace:*` dependency and fails with `EUNSUPPORTEDPROTOCOL`. Updating Flow
itself does not update the workflow SDK.

### Finish project configuration

Create a local environment file from the sample:

```bash
cp workflows/dev.env.example workflows/dev.env
```

Keep the project namespace and target environment pin in your environment file:

```env
POLYAPI_NAMESPACE=mycustomer
TARGET_ENV_ID=replace-with-environment-id
```

For a fresh manual checkout, align its starter code, artefacts, and documentation
with that same root in one step:

```bash
node kickstart/kickstart-namespace.cjs mycustomer
```

Replace `mycustomer` with the exact `POLYAPI_NAMESPACE` you put in the selected
file. Kickstart already performs this step. The helper replaces the starter
root locally; it does not edit environment settings or rename deployed
resources. Renaming an already customized project requires updating its
existing root and reviewing the remote resources separately.

Flow reuses the base URL and API key saved by `pnpm workflows exec poly setup`.
You only need to add `BASE_URL` and `API_KEY` to the selected environment file
if you want to override that saved connection, for example for a different
environment selected through `ENVPATH`.

Next, [select your Flow environment](#select-a-flow-environment) and
[pin its target](#pin-the-target-environment). Kickstart already saves this pin.

Before deployment, align the selected sample's namespace and complete its
training and configuration prerequisites. Start with the
[message-of-the-day tutorial](../workflows/src/sampleWorkflow/README.md#1-confirm-setup-and-namespace),
then [select your Flow file once](#select-a-flow-environment) and preview only
that sample:

```bash
pnpm workflows push --dry-run --paths sampleWorkflow
```

The context root must match `POLYAPI_NAMESPACE`. For example,
`POLYAPI_NAMESPACE=mycustomer` means locally owned contexts start with
`mycustomer`, such as `mycustomer.utilities`, and SDK calls use the same root.
Kickstart and the manual namespace helper apply this to the starter workflows,
common utilities, and copied tutorial examples. Metadata, SDK calls, portable
references, and namespace-based error filters must agree. See
[namespaces and portable references](CONVENTIONS.md#namespaces-and-portable-references)
for examples and external references that must remain unchanged.

When adopting a fresh template, check for any remaining starter roots before
the first deployment:

```bash
rg -n '\bexample\b' workflows/src -g '*.ts' -g '*.json'
```

Do not commit real environment files or secrets.

## Select a Flow environment

Run this once in each Bash terminal session, from the project root:

```bash
export ENVPATH=workflows/dev.env
```

Use the file selected during setup; if that was a different file, replace the
path above. Subsequent `pnpm flow` and `pnpm workflows push` commands inherit
this selection. The export lasts for the current shell and its child processes;
repeat it in a new terminal unless your editor has already configured it.

TypeScript Flow defaults to `workflows/dev.env` when `ENVPATH` is unset.
`export ENVPATH=dev.env` also works: Flow searches `workflows/` first for a bare
filename. The explicit `workflows/dev.env` form is used throughout these guides
and also works with the Python template. Do not replace `export` with a bare
shell assignment; it may not reach commands launched afterward.

This selects a file for Flow; it does not export that file's contents into your
shell or configure direct SDK calls. Keep `TARGET_ENV_ID` in the selected file,
and use the namespace in that file for owned resources and training contexts.

## Pin the target environment

`TARGET_ENV_ID` is the ID of the PolyAPI environment you intend to use. It is
separate from your namespace or tenant ID. The URL and API key choose the
connection; this setting checks that the connection reaches the expected
environment. Changing the pin does not switch credentials.

Kickstart saves the verified ID automatically. For manual setup or an
intentional target change, [select your Flow file](#select-a-flow-environment),
then ask Flow which environment your configured connection belongs to:

```bash
pnpm flow target-env
```

Check that the reported environment is the one you intend to use, then copy the
printed `TARGET_ENV_ID=<id>` into the selected file, replacing its placeholder:

```env
TARGET_ENV_ID=replace-with-environment-id
```

Flow compares this file's pin with authenticated `GET /whoami` before remote
commands, including deployment dry runs, training, deletion previews, and logs.
A missing or mismatched pin stops the command. On a mismatch, confirm the
intended environment and connection before changing the pin; do not replace it
just to silence the error. Exporting `TARGET_ENV_ID` in your shell does not
replace the file's pin. Offline training previews and help do not need a
connection. Direct SDK calls and tests do not run this Flow check.

## Skip sample deployments

To keep the learning samples in your checkout while deploying your own
integrations, add this setting to the selected Flow file:

```env
POLY_DEPLOY_SKIP_PATHS=src/sampleWorkflow,src/sampleAiFx
```

This comma-separated list contains paths **relative to `workflows/`**, so use
`src/sampleWorkflow`, not `workflows/src/sampleWorkflow`. Each folder entry
also skips its contents; these are paths, not namespaces or wildcard patterns.
Add the entries to any existing list instead of replacing other exclusions.
The example skips both sample workflows and leaves shared utilities available.

The exclusions apply to deployment previews and pushes, including commands
with `--paths`. To deploy a tutorial, first remove that sample's entry (or any
parent-folder entry covering it) from the selected file; `--paths` does not
override the skip list. Add it back when you want to exclude the sample again.

Skipping does not remove local files or delete existing deployments. While the
sample files remain in the checkout, Flow still includes them in its orphan
inventory, so excluding them does not make their resources deletion candidates.
This setting controls deployment scanning; it does not block explicit API
training, `delete-content`, or direct SDK calls. It also does not replace the
`TARGET_ENV_ID` check.

## Commands

After [selecting your Flow environment](#select-a-flow-environment), run these
commands from the project root.

Root commands:

```bash
pnpm check
pnpm format
pnpm lint
pnpm test
pnpm test:integration
```

Workflow commands:

```bash
pnpm workflows test
pnpm workflows test:integration
RUN_MUTATING_INTEGRATION=true pnpm workflows test:integration:mutating
pnpm workflows test:all
pnpm workflows push
pnpm workflows push:dry-run
pnpm flow train-openapi
pnpm flow delete-content --dry-run
pnpm flow logs <function-id>
```

`test` runs local tests; `test:integration` and `test:all` may call deployed
resources when their opt-in flags are enabled. `ENVPATH` and the target pin are
Flow features: the checked-in AVA configuration does not load that file or
verify `TARGET_ENV_ID` for direct SDK tests. Confirm the SDK's selected target
and follow each sample's test prerequisites before opting in.

The bundled unit tests use mocked SDK calls and can run before PolyAPI setup or
SDK generation. Their runner compiles TypeScript without checking types, so a
passing unit test checks the tested behavior but does not verify generated SDK
function names or signatures. The separate integration-test runner keeps
TypeScript type checking and needs the SDK generated for the intended
environment, plus each sample's deployment and configuration prerequisites.

CLI commands:

```bash
pnpm flow build
pnpm flow generate
```

## Adding a workflow

Follow the workflow layout, namespace rules, artefact guidance, and test
placement in [CONVENTIONS.md](CONVENTIONS.md). Start from the closest maintained
sample under `workflows/src/`, then run the checks and dry-run commands listed
there before deployment.

## Agent skills

If you used kickstart, the general, common, and TypeScript skills are already
installed in `.agents/skills/`, including `api-function-training`. No additional
skill setup is needed. Skills guide coding agents; they are optional for running
the tutorials and are not runtime dependencies.

For a manual checkout, you can install relevant skills from
[polyapi/poly-skills](https://github.com/polyapi/poly-skills):

1. Clone or update `poly-skills` outside this project.
2. Create `.agents/skills/` in this project if it does not exist.
3. Copy each selected skill directory, including its supporting files, directly
   into `.agents/skills/` using the skill directory's own name.

Recommended directories, relative to the `poly-skills` checkout:

- `general/skills/clean-code`
- `general/skills/markdownlint-compliance`
- `polyapi-common/skills/canopy-ui`
- `polyapi-common/skills/design-analysis`
- `polyapi-common/skills/generate-overview`
- `polyapi-common/skills/polyapi-constructs`
- `polyapi-typescript/skills/api-function-training`
- `polyapi-typescript/skills/artefacts-usage`
- `polyapi-typescript/skills/coding-conventions`
- `polyapi-typescript/skills/coding-standards`
- `polyapi-typescript/skills/polyapi-sdk`
- `polyapi-typescript/skills/polyapi-runtime-testing`

Keep the destination flat: `general/skills/clean-code` becomes
`.agents/skills/clean-code`. Do not copy package roots or preserve parent
folders above a skill. Kickstart requires `api-function-training` to be available
on `poly-skills/main` and reports an error if it is missing.

See [AGENTS.md](../AGENTS.md) and [CONVENTIONS.md](CONVENTIONS.md) before making
workflow or tooling changes.
