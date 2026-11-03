# PolyAPI TypeScript Project Template

![Your next integration. Built in TypeScript. A PolyAPI project template with workflows, artefacts, and development tools.](.images/project-template-banner.svg)

Build, test, and deploy PolyAPI workflows with TypeScript. This workspace includes
sample integrations, shared utilities, agent skills through kickstart, and Flow
for managing functions and JSON artefacts.

New to PolyAPI? Start with the [message-of-the-day tutorial](workflows/src/sampleWorkflow/README.md),
then explore the [AI and shared utility samples](#learn-by-example). Each lesson
walks through a working integration and explains the pieces as you use them.

## Getting started

Requires only curl on macOS or Linux, which also provide the `tar` command it
uses. On Windows, run it in [WSL](docs/SETUP.md#windows). GitHub authentication
and GitHub CLI (`gh`) are not required.

```bash
curl -fsSL https://raw.githubusercontent.com/polyapi/poly-ts-project-template/main/kickstart/kickstart.sh | bash
```

Kickstart downloads public snapshots of the template and skills over HTTPS into
a temporary directory. You do not need to clone the template first. From an
existing template checkout, `bash kickstart/kickstart.sh` also works.

If pnpm is missing, kickstart installs pnpm 10.0.0 for your user account with
[pnpm's official installer](https://pnpm.io/installation). If Node.js is
missing, pnpm installs the current Node.js LTS, or Node.js 24 LTS on a minimal
Linux system that lacks the `libatomic1` library newer Node.js builds need.
Both live in pnpm's home directory, need no administrator rights, and are added
to your shell profile; open a new terminal afterwards. If Node.js older than 22
is installed, kickstart asks before installing anything; Enter keeps your
current setup and stops. Git and VS Code are optional. Without Git, kickstart
prints the commands that create the repository later. Without VS Code's `code`
command (on macOS, run **Shell Command: Install 'code' command in PATH** from
the VS Code command palette), it prints the project path instead of opening it.

The parent directory defaults to your current terminal directory. Your project
is created inside it using the project name you enter.

Follow the prompts for your project location, namespace, PolyAPI instance, and
API key. Kickstart installs the SDK for your selected instance, configures
PolyAPI, aligns the starter contexts, SDK references,
and tutorial examples with your namespace, saves the verified `TARGET_ENV_ID`,
installs skills, builds Flow, creates `main` and `develop` Git branches, and
opens your project in VS Code.
It does not deploy resources or train the sample APIs.

Already have a checkout? Follow [manual setup](docs/SETUP.md#manual-setup).

## Learn by example

Follow the samples in this order. Each guide includes a first run, expected
results, and exercises, with deeper reference material below the walkthrough.

| Sample | What you will learn |
| --- | --- |
| [Message of the day](workflows/src/sampleWorkflow/README.md) | Webhooks, triggers, server/client functions, trained APIs, Vari, secrets, and a scheduled job. |
| [Weather AI](workflows/src/sampleWorkflow/OVERVIEW.md#weather-ai) | AI Functions that call trained tools and return structured weather guidance with data attribution. |
| [Shared utilities](workflows/src/utilities/common/OVERVIEW.md) | Structured logging, sensitive-field filtering, error handling, and Slack alerts. |

The weather sample uses Open-Meteo without a weather API key; AI execution still
needs a configured provider and can incur usage charges. Follow each sample's
setup instructions before deploying or invoking it.

To build your own integration, start from the closest sample and follow the
[workflow layout and naming rules](docs/CONVENTIONS.md#workflow-structure-and-naming).

## Everyday commands

Run from the project root after setup. Select the Flow file once per terminal
session, then use plain commands:

```bash
export ENVPATH=workflows/dev.env
pnpm check
pnpm workflows test
pnpm workflows push --dry-run --paths sampleWorkflow --types functions,variables,schemas,webhooks,triggers,jobs
```

Keep your owned `POLYAPI_NAMESPACE` and verified `TARGET_ENV_ID` in the selected
environment file. The [target pin](docs/SETUP.md#pin-the-target-environment)
makes Flow reject a connection to a different environment. To keep samples in
the checkout but omit them from deployment, configure
[`POLY_DEPLOY_SKIP_PATHS`](docs/SETUP.md#skip-sample-deployments).
Review the deployment preview before a real push, and keep real environment
files and secrets out of Git.

See the [full command list](docs/SETUP.md#commands) for formatting, deployed tests,
API training, logs, and cleanup. Tests that mutate external systems require an
explicit opt-in; local tests do not prove deployed runtime behaviour.

## Structure

```text
.agents/       agent configuration and installed skills
cli/           workspace-local Flow CLI
designs/       upstream specifications and design source material
kickstart/     interactive project bootstrap
docs/          setup, development, and project conventions
workflows/src/ workflows, shared utilities, and runtime tests
```

## Further reading

| Guide | Covers |
| --- | --- |
| [Setup and development](docs/SETUP.md) | Manual setup, SDK selection, environment pins, namespaces, and the full check/test commands. |
| [Flow CLI](cli/README.md) | Deployment, OpenAPI training, logs, cleanup, and production safeguards. |
| [Upgrading Flow](docs/UPGRADING_FLOW.md) | Upgrade older projects, use Flow's self-updater, and check versions. |
| [Project conventions](docs/CONVENTIONS.md) | Workflow layout, artefacts, naming, SDK patterns, and tests. |
| [Agent guidance](AGENTS.md) · [Installing skills](docs/SETUP.md#agent-skills) | Repository rules and skills from [poly-skills](https://github.com/polyapi/poly-skills). |

New to the platform? Read the [PolyAPI overview](https://docs.polyapi.io/platform_overview.html).
