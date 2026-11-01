# Shared utilities: logs and error notifications

Learn how a reusable client function formats diagnostic messages, filters named
context fields, and sends error notifications through a shared alert function.
Start with [Getting started](../../../../README.md#getting-started) and the
[message-of-the-day tutorial](../../sampleWorkflow/README.md).

AI coding agents are optional. Kickstart already installs the recommended
PolyAPI skills; for a manual checkout, see
[agent skills setup](../../../../docs/SETUP.md#agent-skills).

1. [Prepare the namespace and configuration](#prepare-and-deploy).
2. [Write your first log](#write-your-first-log) and inspect its output.
3. [Explore filtering and alerts](#filtering-and-alerts).
4. [Check the implementation](#verify) and [try small changes](#try-small-changes).

## Prepare and deploy

The context root must match `POLYAPI_NAMESPACE`. This checkout uses
`example.utilities`, `example.configurations.*`, and
`example.diagnostics.services`, so its root is `example`. Kickstart personalizes
the included utilities, artefacts, tests, and these documentation examples with
your chosen root.

For a manual checkout with a different root, follow
[Required context replacement](#required-context-replacement). Namespace is the
resource grouping; the selected file's `TARGET_ENV_ID` identifies the remote
environment. See [namespace rules](../../../../docs/CONVENTIONS.md#namespaces-and-portable-references).

Run from the repository root and select your Flow file once for this terminal
session:

```bash
export ENVPATH=workflows/dev.env
```

Subsequent Flow commands reuse this selection. TypeScript Flow also accepts
`export ENVPATH=dev.env`, looking in `workflows/` first; without `ENVPATH`, it
defaults to `workflows/dev.env`.

Configure `LOG_LEVEL` and `SLACK_CHANNEL_ID` in your selected Flow file before
deploying. These become non-secret Vari values at deployment time. Missing
values leave literal `{{PLACEHOLDER}}` strings and a warning, not a useful
default. Use `LOG_LEVEL=info` for this lesson and a community Slack channel
available to your project.

Alerting requires access to `OOB.polyapi.internal.alerting.sendAlertToPoly` and
its supported community Slack workspace. These utilities are not a general
connector to an arbitrary Slack workspace. Confirm the dependency and intended
destination before exercising alerts.

From the repository root:

```bash
pnpm workflows push --dry-run --paths utilities/common
pnpm workflows push --paths utilities/common
```

Review the target and plan before applying it. The push includes three
functions, two configuration variables, and an enabled error-event trigger;
Flow regenerates the SDK by default. A dry run does not send a test alert.

**Checkpoint:** `logLevel` and `channelId` have the intended values, and the
SDK exposes `poly.example.utilities.log` under your root. Direct SDK calls
below use the SDK's selected connection; they do not load `ENVPATH` or enforce
Flow's target pin.

## Write your first log

Run this example from the repository root. All context values are synthetic.
The SDK namespace must match the owned context checked above:

```bash
pnpm workflows exec node <<'JS'
const poly = require('polyapi');

(async () => {
  await poly.example.utilities.log('info', 'loggingLesson', 'Request accepted', {
    requestId: 'demo-1',
    authorization: 'placeholder-only',
    details: { itemCount: 2, token: 'placeholder-only' }
  });
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
JS
```

Expected log line when `info` is enabled:

```text
[info][loggingLesson] Request accepted | context={"requestId":"demo-1","details":{"itemCount":2}}
```

**Checkpoint:** `requestId` and `itemCount` remain, while `authorization` and
nested `token` are removed. `log` is a client function: called here, its output
appears in your terminal. Called inside a server function, its output belongs
to that server's logs. It has no separate hosted log stream.

The function returns `Promise<void>`; it does not return a log record or a
confirmation that a message arrived in Slack.

## Filtering and alerts

The logger reads the threshold from
`example.configurations.logging.logLevel`. Supported values are `debug`,
`info`, `warn`, `error`, `fatal`, and `silent`. An `info` threshold suppresses
`debug`; `silent` suppresses both logs and alerts through `log`.

Refresh is asynchronous and cached for 60 seconds. The first call uses `debug`
while the configuration read runs; failed refreshes also fall back to `debug`.
A threshold change therefore need not affect the first call. When comparing
calls, keep the same process running and let its refresh complete.

```text
log(info/warn/debug) -> threshold -> console output
log(error/fatal)     -> threshold -> console output -> sendAlert
platform error      -> error-event trigger -> errorAlerts -> sendAlert
sendAlert           -> shared PolyAPI alert function -> community Slack
```

`error` and `fatal` calls that pass the threshold await `sendAlert`.
[sendAlert](client/sendAlert.ts) reads the channel Vari and calls the shared
PolyAPI alert function. [errorAlerts](server/errorAlerts.ts) delegates a
serialized platform error to the same client utility. Its enabled
[trigger](artefacts/triggers/errorEventTrigger.json) filters by the owned
namespace path; it is separate from ordinary logger calls.

After confirming the destination, a deliberate `error` log with synthetic
content can test the alert path. Inspect the intended Slack channel: a resolved
function call or a `success` log is not independent proof of message delivery.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| [log.ts](client/log.ts) | Threshold filtering, context filtering, output, and forwarding error/fatal events. |
| [sendAlert.ts](client/sendAlert.ts) | Channel lookup and shared alert invocation, with start/success logs. |
| [errorAlerts.ts](server/errorAlerts.ts) | Server-function destination for platform error events. |
| [logLevel.json](artefacts/vari/logLevel.json) | Deploy-time `LOG_LEVEL` becomes runtime configuration. |
| [slackChannelId.json](artefacts/vari/slackChannelId.json) | Deploy-time `SLACK_CHANNEL_ID` becomes the alert destination. |
| [errorEventTrigger.json](artefacts/triggers/errorEventTrigger.json) | Path filter and error-handler destination. |

## Verify

Run the focused unit tests from the repository root:

```bash
pnpm workflows exec ava 'src/utilities/common/**/*.test.ts'
```

These tests mock SDK configuration and alert calls, so they run without PolyAPI
setup, SDK generation, or credentials. The unit-test runner compiles TypeScript
without checking types. A passing result verifies the covered behavior; it does
not verify generated SDK function names or signatures, access to the shared
alert function, or delivery to Slack.

The separate integration-test runner keeps TypeScript type checking and needs
the SDK generated for the intended environment. Follow each sample's deployment,
configuration, and opt-in instructions before running a live test; see
[test commands](../../../../docs/SETUP.md#commands).

## Try small changes

| Exercise | Expected observation |
| --- | --- |
| Change the safe `itemCount` in the first example. | The structured context reflects the new value. |
| Add a nested `password: "placeholder-only"` field. | The named field is removed from the log context. |
| Compare `debug` and `info` with an `info` threshold after refresh. | Only `info` is emitted; the initial asynchronous refresh matters. |
| Trace an `error` call without executing it. | The same threshold gates logging and alert forwarding. |

## Current limitations

Filtering is case-insensitive for exact keys such as `authorization`, `apiKey`,
`password`, and `token`, including nested objects. It does not sanitize message
text or every spelling: `api_key` is not filtered. Pass only safe context and
messages. `sendAlert` logs a message preview, and `errorAlerts` forwards the
serialized event directly; neither is a general secret scrubber.

The logger can throw on circular context. Alert-delivery failures can also
propagate, including from `errorAlerts`, although the project conventions call
for best-effort, non-throwing global handlers. Account for these limitations
before reusing the utilities in production workflows.

## Required context replacement

Kickstart performs this alignment for new projects, including the documentation
examples. For a fresh manual checkout, use the namespace-alignment step in
[manual setup](../../../../docs/SETUP.md#manual-setup) with the same root as
`POLYAPI_NAMESPACE` in the selected Flow file.

For an already customized project, align its locally owned source, artefacts,
tests, and SDK examples with the new root. Changing the setting alone does not
rewrite code. Use this table to review the utility references:

| File | References to align |
| --- | --- |
| `client/log.ts` | `polyConfig.context`, `vari.example`, and `poly.example` |
| `client/sendAlert.ts` | `example.utilities.slack`, `vari.example`, and `poly.example` |
| `server/errorAlerts.ts` | `example.diagnostics.services` and `poly.example` |
| `artefacts/vari/logLevel.json` | `example.configurations.logging` |
| `artefacts/vari/slackChannelId.json` | `example.configurations.slack` |
| `artefacts/triggers/errorEventTrigger.json` | `errorHandler.path` and `destination.functionContext` |
| Unit tests | Mocked SDK namespace keys must match the source. |

If you choose `mycustomer` as the new root, `example.utilities` becomes
`mycustomer.utilities`, and
`vari.example.configurations.logging.logLevel` becomes
`vari.mycustomer.configurations.logging.logLevel`. Preserve the external
`OOB.polyapi.internal.alerting` namespace.

After manual alignment, search for the previous root in the owned files.
Replace `<previous-root>` below with its literal name:

```bash
rg -n '<previous-root>' workflows/src/utilities/common -g '*.ts' -g '*.json'
```

## Operational command reference

Shared operational commands live in Flow: use `pnpm flow train-openapi` for API
training, `pnpm flow delete-content` for scoped cleanup, and
`pnpm flow logs <function-id>` for logs. These replace the former common shell
scripts. See the [Flow CLI guide](../../../../cli/README.md).
