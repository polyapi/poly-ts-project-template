# Sample AI Function: Uplifting Weather

This example implements the weather companion from the PolyAPI AI Functions
skill. It uses existing PolyAPI functions for weather facts and an AI Function
only for location selection and activity-aware guidance.

## Contract and flow

Input:

- `location`: required free-form location description
- `activity`: optional activity for tailored recommendations

Output is a strict object containing the resolved location, current condition
and temperature, a description, recommended items, and an uplifting message.

```text
upliftingWeather AI function
  -> accuWeather.locations.search PolyAPI function
  -> accuWeather.currentConditions.getByLocationKey PolyAPI function
  <- structured weather facts
<- structured activity-aware guidance
```

Both tools receive `weatherApiKey` through a portable SECRET vari reference.
The model chooses tool arguments but does not supply the credential.
The AI Function keeps its prompt directly in `systemPrompt`; no prompt vari is
needed unless externally managed prompt content is explicitly required.

## Files

- `artefacts/ai-functions/upliftingWeather.json` defines the bounded AI
  contract, tools, prompt, and output schema.
- `artefacts/vari/weatherApiKey.json` defines the secret without storing its
  value in source control.
- `server/upliftingWeather.integration.test.ts` validates the deployed output
  contract and is gated to avoid accidental model/API cost.

## Deploy and test

The context root is `example`, so use `POLYAPI_NAMESPACE=example` or replace
the root consistently before deployment.

The AI Function uses the existing `accuWeather.locations.search` and
`accuWeather.currentConditions.getByLocationKey` PolyAPI functions. Then
deploy the variable and AI Function:

```bash
ENVPATH=workflows/dev.env pnpm workflows push --dry-run --paths sampleAiFx
ENVPATH=workflows/dev.env pnpm workflows push --paths sampleAiFx
pnpm workflows exec poly generate
```

After the first push, open `weatherApiKey` in PolyAPI Canopy and set its value
to your AccuWeather API key. Because it is `SECRET`, Flow deliberately does
not store or update its value from the JSON artefact.

Run the deployed integration test explicitly after the tools, secret, and AI
function are ready:

```bash
ENVPATH=workflows/dev.env RUN_AI_INTEGRATION=true pnpm workflows test:integration
```

Create a key and review the API contract here:

- <https://developer.accuweather.com/>
- <https://developer.accuweather.com/documentation/authentication>
