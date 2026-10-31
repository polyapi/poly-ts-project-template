# PolyAPI TypeScript Project Template

Generic TypeScript workspace for PolyAPI workflow projects.

The template keeps deployable workflow code under `workflows/src/` and uses a
workspace-local Flow CLI under `cli/` to validate and sync TypeScript functions
and JSON artefacts to PolyAPI.

New to PolyAPI? Start with the sample workflow tutorial:
[workflows/src/sampleWorkflow/README.md](workflows/src/sampleWorkflow/README.md).
It walks through the core runtime flow from webhook to trigger to functions.

## Structure

```text
poly-ts-project-template/
  .agents/    repository-local agent configuration and guidance
  cli/        workspace-local Flow validation and synchronization CLI
  designs/    upstream specifications and design source material
  workflows/  deployable workflows, shared utilities, and runtime tests
```

See [CONVENTIONS.md](CONVENTIONS.md) for the authoritative workflow layout,
artefact folders, naming rules, namespace behavior, and test placement.

## Setup

### Interactive project creation

Run `bash ./kickstart.sh` from a template checkout to create a new project.
The script downloads fresh copies of this template and
[`poly-skills`](https://github.com/polyapi/poly-skills) into a unique temporary
directory, then removes those downloads on success, failure, or interruption.
It requires Bash (including macOS's built-in Bash), curl, tar, Git, Node.js,
pnpm, the VS Code `code` command, and a configured Git author identity.

The prompts ask for a project name, parent directory (default
`$HOME/Code/poly`), namespace (default `demo`), hidden API key, and environment
(`dev`, `na1`, `na2`, or `eu1`). The script installs the general, PolyAPI common,
and TypeScript skills in `.agents/skills`, creates a private
`workflows/dev.env`, installs the SDK for the selected environment, rewrites
the template's `example.*` contexts and matching SDK references, and runs
PolyAPI setup and generation. It then commits the project on `main`, switches
to `develop`, and opens VS Code. Environment files remain ignored by Git.

To launch it without keeping a local template checkout, add this function to
`~/.zshrc`, then run `source ~/.zshrc` and `newpolyts`:

```zsh
newpolyts() (
  emulate -L zsh
  unsetopt xtrace verbose
  local bootstrap_dir
  bootstrap_dir=$(mktemp -d "${TMPDIR:-/tmp}/newpolyts.XXXXXXXX") || return 1
  trap 'rm -rf -- "$bootstrap_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if curl --fail --location --silent --show-error --retry 2 \
    --output "$bootstrap_dir/kickstart.sh" \
    https://raw.githubusercontent.com/polyapi/poly-ts-project-template/main/kickstart.sh; then
    bash "$bootstrap_dir/kickstart.sh"
  else
    print -- "HTTPS script unavailable; trying GitHub SSH access..."
    git clone --depth 1 --single-branch --branch main \
      git@github.com:polyapi/poly-ts-project-template.git "$bootstrap_dir/template" || return 1
    bash "$bootstrap_dir/template/kickstart.sh"
  fi
)
```

HTTPS downloads fall back to shallow SSH clones when archives or the script
are inaccessible, for example with a private repository. This fallback needs
GitHub SSH access to both repositories. The downloads' Git history is removed
before creating the project's own repository. Bash runs the setup as a child
process, so your terminal's current directory stays unchanged. If setup fails,
the partial project is retained at the printed path for troubleshooting.

Regression checks for the installer run without real API calls or package
installation, after installing the template's dependencies:

```bash
bash -n kickstart.sh
node --test tests/kickstart.test.cjs
```

### Manual setup

Install dependencies:

```bash
pnpm install
```

To update the workflow SDK for your environment, use pnpm before running setup
or generation. For example, for `eu1`:

```bash
pnpm --filter workflows add polyapi@eu1
```

Use `na1` or `na2` for those environments, and `develop` for `dev`. If the Poly
CLI offers to update using npm, decline and use the pnpm command above; npm
cannot install this project's `workspace:*` dependency.

Set up PolyAPI environment

```bash
pnpm workflows exec poly setup
pnpm workflows exec poly generate
```

Create a local environment file from the sample:

```bash
cp workflows/dev.env.example workflows/dev.env
```

Set placeholder values in `workflows/dev.env`, then run Flow with `ENVPATH`:

```bash
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
```

The required environment variables are:

```env
POLYAPI_NAMESPACE=mycustomer
BASE_URL=https://eu1.polyapi.io
API_KEY=replace-with-your-api-key
```

Choose one root namespace for locally managed project artefacts. The checked-in
template uses `example`; replace it consistently when adopting the template.
See [Namespaces And Portable References](CONVENTIONS.md#namespaces-and-portable-references)
for what must use that namespace and which public or tenant references must not
be rewritten.

Find any placeholders that remain before the first deployment:

```bash
rg -n '\bexample\b' workflows/src
```

Do not commit real environment files or secrets.

## Add Or Update The Flow CLI In Your Project

If your project already uses this template structure and you want to add the
latest workspace-local Flow CLI, sync it from the current
`poly-ts-project-template` repository.

1. Clone the template repository, or update your existing local copy so you have
  the latest `poly-ts-project-template` code.
2. Remove the `cli/` folder from your target project.
3. Copy the `cli/` folder from `poly-ts-project-template` into your target
  project.
4. Replace the target project's `pnpm-lock.yaml` with the one from
  `poly-ts-project-template`.
5. Copy `package.json` from `poly-ts-project-template` into your target
  project.
6. Remove `package-lock.json`.
7. Remove installed dependencies and reinstall everything so the CLI and its
  generated files are rebuilt cleanly.
8. Push the changes. Use a normal push for regular updates, or `--force` when
   you need to fully overwrite the deployed state.

```bash
rm -rf node_modules
rm -rf cli/node_modules
pnpm install
pnpm --filter flow-cli build
pnpm workflows push
# or force a full update
pnpm workflows push --force
```

If your project did not originally come from this template, also make sure it
still includes the root workspace configuration and scripts that reference the
`flow-cli` package.

## Commands

Root commands:

```bash
pnpm check
pnpm format
pnpm lint
pnpm test
ENVPATH=workflows/dev.env pnpm test:integration
```

Workflow commands:

```bash
pnpm workflows test
ENVPATH=workflows/dev.env pnpm workflows test:integration
ENVPATH=workflows/dev.env RUN_MUTATING_INTEGRATION=true pnpm workflows test:integration:mutating
pnpm workflows test:all
pnpm workflows push
pnpm workflows push:dry-run
pnpm workflows train:openapi
pnpm workflows delete:content
```

CLI commands:

```bash
pnpm flow build
pnpm flow generate
```

## Adding A Workflow

Follow the workflow layout, namespace rules, artefact guidance, and test
placement in [CONVENTIONS.md](CONVENTIONS.md). Start from the closest maintained
sample under `workflows/src/`, then run the checks and dry-run commands listed
there before deployment.

## Flow CLI

The Flow CLI validates and synchronizes the artefact types documented in
[CONVENTIONS.md](CONVENTIONS.md#artefacts). It supports scoped `--paths` and
`--types` pushes, dry runs, production safeguards, and explicit orphan
deletion. See [cli/README.md](cli/README.md) for its command and payload
reference.

## OpenAPI Training

Put upstream specs under `designs/` or a workflow-local `artefacts/specs/`
folder, then run:

```bash
pnpm workflows train:openapi
```

The script prompts for a spec file or folder and a PolyAPI context. Use `{file}`
in the context when each spec should train under a context based on its file
name.

## Agent Skills

This template does not include agent skills. Bring relevant skills into
`.agents/skills/` from:

<https://github.com/polyapi/poly-skills>

For a TypeScript PolyAPI project, see the recommended skill setup in the
[sample workflow tutorial](workflows/src/sampleWorkflow/README.md#recommended-agent-skills).

See [AGENTS.md](AGENTS.md) and [CONVENTIONS.md](CONVENTIONS.md) before making
workflow or tooling changes.
