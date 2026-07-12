# Common utilities

The template includes three deployable common functions:

- `log` emits structured runtime logs, removes sensitive context keys, observes
  `example.configurations.logging.logLevel`, and sends `error` and `fatal`
  events to `sendAlert`.
- `sendAlert` runs under `example.utilities.slack` and uses PolyAPI internal
  alerting to post to the Slack community channel configured by
  `example.configurations.slack.channelId`.
- `errorAlerts` runs under `example.diagnostics.services` and is the destination
  of the enabled global error-event trigger. It delegates the serialized error
  payload to `example.utilities.slack.sendAlert`.

## Required context replacement

Before the first deployment, choose a root context—usually the customer name,
for example `mycustomer`—and set `POLYAPI_NAMESPACE=mycustomer` in the local
environment file. Changing the environment variable alone is not sufficient.
Replace every `example` root in the utility source, artefacts, and tests with
the same value.

| File | Required replacements |
| --- | --- |
| `client/log.ts` | `example.utilities`, `vari.example`, and `poly.example` |
| `client/sendAlert.ts` | `example.utilities.slack`, `vari.example`, and `poly.example` |
| `server/errorAlerts.ts` | `example.diagnostics.services` and `poly.example` |
| `artefacts/vari/logLevel.json` | `example.configurations.logging` and the `example.utilities.log` description |
| `artefacts/vari/slackChannelId.json` | `example.configurations.slack` |
| `artefacts/triggers/errorEventTrigger.json` | `errorHandler.path` and `destination.functionContext` |
| `client/*.test.ts` and `server/*.test.ts` | mocked `example` SDK namespace keys |

The replacements include:

- `polyConfig.context` values
- `poly.example` and `vari.example` SDK paths
- JSON `context` and `functionContext` values
- the global trigger's `errorHandler.path`
- test mock namespace keys, so local tests continue to represent deployed paths

For example, replace `example.utilities` with `mycustomer.utilities` and
`example.diagnostics.services` with `mycustomer.diagnostics.services`. The
environment namespace and every deployed context path must share that root.
Then configure `LOG_LEVEL` and `SLACK_CHANNEL_ID` before deploying the utility
artefacts.

Verify that no utility placeholder remains:

```bash
rg -n '\bexample\b' workflows/src/utilities/common
```

Any output from this command must be intentionally replaced before deployment.
