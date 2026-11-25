# Upgrading Flow

Run these commands from your existing project's root folder.

- [Upgrading from an older version](#upgrading-from-an-older-version)
- [Upgrading with Flow itself](#upgrading-with-flow-itself)
- [Release notes requiring action](#release-notes-requiring-action)

**1.1.0 is the first explicitly tracked Flow release.** Older copies used
`1.0.0` as a placeholder. Flow's version is separate from the PolyAPI SDK:
patch releases such as `1.1.1` contain fixes, minor releases such as `1.2.0`
add compatible features, and major releases such as `2.0.0` introduce breaking
changes. The version is maintained in `cli/package.json`.

Upgrading Flow does not update the workflow's PolyAPI SDK. If Poly reports a
client-version mismatch, [align the SDK with your selected instance](SETUP.md#align-the-sdk-with-your-polyapi-instance)
using pnpm before setup or generation.

## Upgrading from an older version

Use this route if your project does not yet have Flow's `self-update` command.
You need Git, Node.js, pnpm, and GitHub SSH access to the template repository.

Copy and paste this one-line command:

```bash
(flow_tmp=$(mktemp -d) && trap 'rm -rf -- "$flow_tmp"' EXIT && git clone --depth 1 git@github.com:polyapi/poly-ts-project-template.git "$flow_tmp" && bash "$flow_tmp/cli/upgrade.sh" --source "$flow_tmp" --project "$PWD")
```

It downloads a temporary template checkout, shows the proposed changes, and
asks for confirmation. It backs up and replaces `cli/`, then removes the
temporary checkout. GitHub CLI (`gh`) is not needed.

Existing settings and dependencies in `package.json` and
`workflows/package.json` are preserved. Missing Flow commands are added;
conflicting custom commands are kept and flagged for review. Changed CLI
dependency requirements need separate approval.

Copy the printed compatibility prompt into your coding agent so it can review
the backup and restore any extensions you need. Keep the backup until that
review is complete. This initial upgrade installs source only: install
dependencies with `pnpm install --ignore-scripts` if needed after reviewing
their requirements, then build and check the version:

```bash
pnpm --filter flow-cli run build
pnpm flow run version
```

Older projects may be missing `TARGET_ENV_ID` in their Flow environment file.
Retrieve the environment ID using:

```bash
ENVPATH=workflows/dev.env pnpm flow target-env
```

Confirm that this is the intended environment, then add the returned
`TARGET_ENV_ID=...` setting to `workflows/dev.env`. Keep existing credentials
and namespace settings. The upgrade does not edit environment files.

Verify your project without deploying:

```bash
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
```

If validation finds an incompatible project artefact, resolve it before a live
deployment. A successful CLI upgrade does not guarantee every existing
workflow already meets its validation rules.

## Upgrading with Flow itself

Once the updater is available, check your installed version and preview the
latest template version:

```bash
pnpm flow run version
pnpm flow run self-update --check
```

If an earlier updater does not yet provide the version command, run the update
first and check the version afterward.

The preview shows installed and incoming versions, the exact template commit,
and the files that would change. It does not modify your project.

Apply the update when ready:

```bash
pnpm flow run self-update
```

Flow asks for confirmation, saves a backup, replaces its CLI source, and runs
local build and CLI checks. If those checks fail, it restores the previous
source. Dependency differences stop the update for review; project package
files, environment files, and workflow code are preserved.

Review the printed compatibility prompt with your coding agent to restore
intended customizations. Then verify:

```bash
pnpm flow run version
ENVPATH=workflows/dev.env pnpm workflows push --dry-run
```

Keep `run` in the version and self-update commands: pnpm also has its own
commands with these names. Updates follow the template's `main` branch by
default; use `--ref` to select an existing branch, tag, or commit. The recorded
commit identifies the exact source even when two checkouts share a version.

To undo an update:

```bash
pnpm flow run self-update --rollback
```

Each upgrade also prints a standalone recovery command for use if Flow cannot
start. Backups live under `.flow/updates/`. Review and commit the changes
yourself; upgrading does not commit, push, or deploy anything.

## Release notes requiring action

### Table data folder

Flow 1.5.0 syncs the rows of Tabi tables from `artefacts/tabi/data/`; see
[table data](../cli/README.md#table-data). The `table-data` type is on by
default and changes nothing until a project adds data files. Before 1.5.0,
Flow read every JSON file under `artefacts/tabi/`, including that folder, as a
table definition. Move any table definition kept in `artefacts/tabi/data/` up
to `artefacts/tabi/`. Until you do, the tables step fails for that file and no
longer deploys it, but still counts the table as local, so `--delete-orphans`
does not delete it.

### Webhook triggers replaced by direct bindings

Flow 1.4.3 turns a former warning into a validation error. When a webhook
artefact sets `serverFunction`, PolyAPI runs that function and skips the
webhook's triggers, so a local trigger that uses the webhook as its `source`
would never run. Flow now stops before any remote write and names the webhook
and trigger files. Remove the trigger artefact, or remove the webhook's
`serverFunction` binding to keep routing through triggers. Keep a trigger only
for fire-and-forget calls (`waitForResponse: false`) or fan-out to several
functions, and then leave the webhook unbound.

The message-of-the-day sample now binds `motdWebhook` to `motdServer` and no
longer ships `motdTrigger.json`. Updating Flow does not change your workflow
code, so an existing copy of the sample keeps working unchanged. If you adopt
the binding in a project that already deployed the old sample, the remote
`motdTrigger` remains after you delete its local file. PolyAPI skips it once
the binding exists, so it is harmless, but it is clutter.

Flow treats a namespace-owned remote trigger with no local artefact as an
orphan, but only in an unscoped push that selects triggers: `--paths` runs,
including the tutorial's sample push, skip orphan detection. Default pushes
only report orphans; `--delete-orphans` deletes them. To remove the old trigger
once, preview first and check that the plan deletes only `motdTrigger`:

```bash
ENVPATH=workflows/dev.env pnpm workflows push --types triggers --delete-orphans --dry-run
ENVPATH=workflows/dev.env pnpm workflows push --types triggers --delete-orphans
```

Alternatively, delete `motdTrigger` in Canopy. Avoid
`delete-content --types triggers --context example.sampleWorkflow` for this:
it selects every trigger whose function is in that context, including the
sample's error-handler trigger.

