# Deploy a server function with a custom container

Use a custom image when a server function needs native libraries or tools that
are absent from the standard PolyAPI runtime. Build and publish the image
first, then let Flow deploy the function using that image.

The examples assume a utility under `workflows/src/utilities/dbAdapter/` with
`polyConfig.context: 'example.database'` and `polyConfig.name: 'adapter'`.
Replace these example paths and names with your own utility's values.
Run commands from the repository root using Bash.

## 1. Prepare the image

You need:

- Flow 1.3.0 or later; check with `pnpm flow run version`. See
  [upgrading Flow](README.md#self-update) if needed.
- A working Docker installation with Buildx and registry push access.
- A PolyAPI TypeScript base image compatible with the target instance, plus
  the CPU architecture used by that instance.
- A registry location the PolyAPI instance can pull from, and the image name
  it accepts for that published image.
- Your function's required variables and shared functions deployed, with the
  local SDK generated for the same environment.

Create a Dockerfile and an image smoke-test script beside the utility, for
example under `deployment/`. The Dockerfile should accept `BASE_IMAGE_REF`,
extend that PolyAPI runtime, and install the required native dependencies.
Preserve the base image's startup behavior and runtime user. Compile native
modules for its Node version, architecture and system libraries. Keep the
image reusable across function deployments; it should not depend on a
previously deployed function ID or contain database credentials.

Set the following shell variables to the real references for your instance.
The uppercase registry/base values below are placeholders, not published images:

```bash
export BASE_IMAGE_REF='REGISTRY/POLYAPI_TYPESCRIPT_BASE:VERSION'
export IMAGE_REF='REGISTRY/NAMESPACE/polyapi-db-adapter-v1:latest'
export BUILD_PLATFORM='linux/amd64'
```

Build and load the image locally:

```bash
docker buildx build \
  --platform "$BUILD_PLATFORM" \
  --build-arg "BASE_IMAGE_REF=$BASE_IMAGE_REF" \
  --file workflows/src/utilities/dbAdapter/deployment/Dockerfile \
  --tag "$IMAGE_REF" \
  --load \
  workflows/src/utilities/dbAdapter/deployment
```

Run the utility's image smoke test before publishing. It should verify that
the native module loads, required drivers/shared libraries are available, and
startup works as the runtime user. Authenticate Docker to the selected registry
using your normal credential setup, then publish and verify the image:

```bash
docker push "$IMAGE_REF"
docker manifest inspect "$IMAGE_REF"
```

Use a new image name/version when its contents change so Flow can detect the
new selection. Replacing image contents behind the same name does not produce
an image-setting difference in Flow.

## 2. Set the Flow environment variables

Select your existing Flow environment file:

```bash
export ENVPATH=workflows/dev.env
```

Keep its existing credentials, `POLYAPI_NAMESPACE` and `TARGET_ENV_ID`. Add an
image mapping using the exact `<context>.<name>` from the function's `polyConfig`:

```env
POLY_DEPLOY_SERVER_FUNCTION_IMAGES=example.database.adapter:polyapi-db-adapter-v1
```

The two image values have different purposes:

| Value | Used by | Example |
| --- | --- | --- |
| Full registry reference | Docker build/push | `REGISTRY/NAMESPACE/polyapi-db-adapter-v1:latest` |
| Instance-recognized image name, without `/` | Flow deployment mapping | `polyapi-db-adapter-v1` |

Confirm this relationship with your PolyAPI instance; a registry image is not
necessarily available to that instance just because the push succeeded.

If the utility also needs steps after deployment, create its post-deploy script
and add this optional setting:

```env
POLY_DEPLOY_SERVER_FUNCTION_SCRIPT=example.database.adapter:bash workflows/src/utilities/dbAdapter/deployment/postDeploy.sh
```

Flow runs that command from the repository root after a successful function
deployment. It supplies `FUNCTION_ID`, `SERVICE_NAME` and the loaded environment,
including an absolute `ENVPATH`. The script can apply settings such as VPN
labels and wait for the resulting runtime to become ready. Make it safe to
rerun and return a nonzero exit code on failure.

Both mappings support multiple functions separated by commas. See the
[configuration reference](README.md#custom-server-images-and-post-deploy-scripts)
for command arguments, `<id>` substitution, validation and failure behavior.

## 3. Preview the deployment

```bash
pnpm workflows push --dry-run --paths utilities/dbAdapter --types server-functions
```

`--paths` selects the utility and `--types server-functions` limits the push to
its server functions. This assumes the variables and other dependencies are
already ready. There is no separate Flow `--image` flag: the environment
mapping selects the image automatically.

Check the preview for the expected function, image name and optional hook.
Dry runs verify the selected target environment but neither deploy functions
nor run hooks. They also do not prove that the image can start.

## 4. Deploy

After reviewing the preview, run the same command without `--dry-run`:

```bash
pnpm workflows push --paths utilities/dbAdapter --types server-functions
```

Flow passes the configured image to the PolyAPI SDK, runs the hook after a
successful function deployment, and regenerates the local SDK. Existing target
checks and deployment confirmations still apply. Scripts must wait for
readiness when needed; a successful function submission alone is not a
runtime health check.

The image and hook settings also work with
[dependency-aware deployment](push-dynamic.md). For example, to force this
function as a seed:

```bash
pnpm workflows push:dynamic --dry-run example.database.adapter
pnpm workflows push:dynamic example.database.adapter
```

## 5. Verify or retry

Verify the deployed revision uses the intended image, is ready, and can load
the native dependency. Run the utility's connectivity or integration check
against the selected environment. A local image smoke test does not prove
access to the target database or its network.

If the hook fails, Flow reports the function operation as failed, but the
function may already be deployed. Correct the script or runtime issue, then
preview and retry with `--force` so an otherwise unchanged function is redeployed
and its hook runs again:

```bash
pnpm workflows push --dry-run --force --paths utilities/dbAdapter --types server-functions
pnpm workflows push --force --paths utilities/dbAdapter --types server-functions
```

Changing only a hook does not trigger a normal deployment. Functions skipped
as unchanged do not run hooks. Flow does not roll back script side effects;
the [configuration reference](README.md#custom-server-images-and-post-deploy-scripts)
describes comparison and retry behavior in more detail.
