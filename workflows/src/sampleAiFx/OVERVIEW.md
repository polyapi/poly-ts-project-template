# Weather AI: tools, secrets, and structured results

Build a weather companion that turns a location and optional activity into
practical guidance. You will learn how an AI Function calls existing PolyAPI
tools for facts, binds credentials through Vari, and returns a defined JSON
shape.

Start with [Getting started](../../../README.md#getting-started), or complete
the [message-of-the-day tutorial](../sampleWorkflow/README.md) first if webhooks,
API Functions, and generated SDKs are new to you.

Using an AI coding agent is optional. Kickstart already installs the recommended
PolyAPI skills; manual checkouts can follow
[agent skills setup](../../../docs/SETUP.md#agent-skills).

1. [Check the prerequisites](#before-you-start).
2. [Deploy and configure the secret](#deploy-and-test).
3. [Make a request](#invoke-the-ai-function) and inspect its result.
4. [Run the deployed test](#verify), then [try small changes](#try-small-changes).

```text
location + optional activity
  -> upliftingWeather AI Function
     -> location search tool -> current-conditions tool
     <- weather facts
  <- structured facts and activity-aware guidance
```

## Before you start

Use a development environment with AI execution access, a configured OpenAI
provider, and access to the `gpt-5.5` model selected by the
[AI artefact](artefacts/ai-functions/upliftingWeather.json). AI and weather calls
can incur provider usage.

The two weather tools must already be accessible in your environment; their
implementation and training specs are not included in this sample:

| Existing tool | Arguments expected by the AI artefact |
| --- | --- |
| `accuWeather.locations.search` | `locationText`, `apiKey` |
| `accuWeather.currentConditions.getByLocationKey` | `locationId`, `apiKey` |

Find these tools in your environment's function catalogue and inspect their
argument names. If absent, ask the environment's owner for access, or train
compatible API Functions from the provider contract using the
[Flow training guide](../../../cli/README.md#openapi-training). Match the table
above or update the AI artefact's tool bindings to the trained contract.
Obtain an AccuWeather key and confirm that the tools implement the provider's
[current authentication contract](https://developer.accuweather.com/documentation/authentication).

This checkout's owned context is `example.sampleAiFx`, which must match
`POLYAPI_NAMESPACE=example` in your selected Flow file. Kickstart personalizes
the included artefacts, test, and these documentation examples together. For a
fresh manual checkout, complete the namespace-alignment step in
[manual setup](../../../docs/SETUP.md#manual-setup) with the same root as your
selected file. The external `accuWeather.*` tool contexts stay unchanged. See
[namespaces and portable references](../../../docs/CONVENTIONS.md#namespaces-and-portable-references).

**Checkpoint:** the two tools, their argument names, provider access, and your
owned namespace are ready before deployment.

## Deploy and test

Run from the repository root after [project setup](../../../docs/SETUP.md),
including the selected Flow file's `TARGET_ENV_ID`. Select that file once for
this terminal session:

```bash
export ENVPATH=workflows/dev.env
```

The commands below reuse this selection. TypeScript Flow also accepts
`export ENVPATH=dev.env`, looking in `workflows/` first. Its default without
`ENVPATH` is `workflows/dev.env`.

```bash
pnpm workflows push --dry-run --paths sampleAiFx
pnpm workflows push --paths sampleAiFx
```

Review the target and plan before the real push. Flow verifies the target for
both commands and regenerates the SDK after the push by default. A deployment
dry run can contact PolyAPI, but does not invoke the AI Function.

Open `weatherApiKey` in Canopy and set its value to your AccuWeather API key.
The [SECRET Vari artefact](artefacts/vari/weatherApiKey.json) stores its identity
and secrecy level; it deliberately contains no credential value. Both tools
receive this secret through a variable binding, not an AI-generated argument.

**Checkpoint:** your generated SDK exposes
`poly.example.sampleAiFx.upliftingWeather(location, activity)`, with your chosen
root, and the SECRET has a value in the same environment.

## Invoke the AI function

This command makes a live AI/weather call. Confirm the generated SDK's selected
connection first: direct SDK calls do not load Flow's `ENVPATH` or enforce its
`TARGET_ENV_ID` check. The namespace in this example must match the owned
context checked above:

```bash
pnpm workflows exec node <<'JS'
const poly = require('polyapi');

(async () => {
  const result = await poly.example.sampleAiFx.upliftingWeather(
    'London, United Kingdom',
    'an outdoor walk'
  );
  console.log(JSON.stringify(result, null, 2));
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
JS
```

An illustrative response, not a current weather report:

```json
{
  "location": "London, United Kingdom",
  "currentWeather": {
    "condition": "Cloudy",
    "temperature": 12,
    "unit": "C"
  },
  "description": "A cool walk under cloudy skies.",
  "recommendedItems": ["A light jacket", "Comfortable walking shoes"],
  "upliftingMessage": "Enjoy a little fresh air and a change of scenery."
}
```

`location` and `currentWeather` should be grounded in tool results. The
`description`, `recommendedItems`, and `upliftingMessage` are model-generated
guidance. The output schema constrains structure; it does not prove factual
accuracy. Actual weather, wording, items, and unit can differ.

**Checkpoint:** identify the location and weather facts, then the generated
advice. Compare the facts with the tool results in the execution details. A
well-formed response alone is not proof that the facts are correct.

## How the contract works

The [AI artefact](artefacts/ai-functions/upliftingWeather.json) puts the complete
contract in one file:

| Field | What it teaches |
| --- | --- |
| `arguments` | `location` is required; `activity` is optional. These become SDK arguments. |
| `inputTemplate` | Inserts those arguments into the request presented to the model. |
| `systemPrompt` | Requires weather facts from tools and activity-aware guidance. The prompt is inline; a separate prompt Vari is optional. |
| `toolFunctions` | Names the two tools. The AI chooses `locationText` / `locationId`; the platform binds each `apiKey` from SECRET Vari. |
| `outputSchema` | Requires location, current weather, description, items, and an uplifting message, with no extra object properties. |

An API Function wraps an HTTP API. This AI Function coordinates tools and
produces guidance. OpenAPI training and AI execution are separate operations.

## Verify

The [integration test](server/upliftingWeather.integration.test.ts) calls the
same London/outdoor-walk case. Opt in only after the tools, secret, and AI
Function are ready:

```bash
RUN_AI_INTEGRATION=true pnpm workflows test:integration
```

The AVA runner uses the generated SDK's connection; it does not load `ENVPATH`
or check `TARGET_ENV_ID`. The test checks required field types and a `C` or `F`
unit. It does not reject extra fields, establish weather accuracy, or cover
missing activity, ambiguous locations, and provider failures.

## Try small changes

| Exercise | Expected observation |
| --- | --- |
| Change the activity to `cycling to work`. | Guidance and recommended items may change; weather still comes from tools. |
| Omit the second SDK argument. | The optional activity is absent; inspect whether the guidance stays useful. |
| Use an ambiguous location name. | Inspect how the location tool resolves it before trusting the advice. |
| Read the secret argument bindings. | The model selects location inputs; the credential comes from Vari. |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing generated AI function | Correct namespace, successful push, SDK generation, and selected environment. |
| Tool cannot be resolved | Both external tool names, access permissions, and argument keys match the artefact. |
| Weather authentication failure | The SECRET has a value and the tools map it to the current provider contract. |
| AI/provider failure | Tenant provider configuration, model access, usage limits, and execution logs. |
| Valid JSON with questionable advice | Compare with tool results; schema validation cannot establish accuracy. |
