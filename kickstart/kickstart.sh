#!/usr/bin/env bash
# Run from a Git checkout of the template.
set +x
set +v
set -euo pipefail

download_dir=''
project_dir=''
project_created=false

cleanup() {
  local result=$?
  if [[ -n "$download_dir" ]]; then
    rm -rf -- "$download_dir" || true
  fi
  if [[ "$result" -ne 0 && "$project_created" == true ]]; then
    printf 'kickstart: setup failed. Project retained at %s for troubleshooting.\n' "$project_dir" >&2
  fi
  return "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for tool in tar git node pnpm code; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'kickstart: required command not found: %s\n' "$tool" >&2
    exit 1
  fi
done

# Read prompts from the terminal so child commands can use standard input.
if ! { exec 3</dev/tty; } 2>/dev/null; then
  printf 'kickstart: run this command from an interactive terminal.\n' >&2
  exit 1
fi

while true; do
  read -r -p 'Project name: ' project_name <&3
  if [[ "$project_name" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
    break
  fi
  printf 'Use lowercase letters, numbers, dots, underscores or hyphens; start with a letter or number.\n' >&2
done

default_parent="$HOME/Code/poly"
while true; do
  read -r -p "Parent directory [$default_parent]: " parent_dir <&3
  parent_dir="${parent_dir:-$default_parent}"
  case "$parent_dir" in
    '~') parent_dir="$HOME" ;;
    '~/'*) parent_dir="$HOME/${parent_dir#\~/}" ;;
  esac
  parent_dir=$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$parent_dir")
  project_dir="$parent_dir/$project_name"
  if [[ ( -e "$parent_dir" || -L "$parent_dir" ) && ! -d "$parent_dir" ]]; then
    printf 'The parent path is not a directory. Choose another location.\n' >&2
  elif [[ -e "$project_dir" || -L "$project_dir" ]]; then
    printf 'A file or directory named %s already exists there. Choose another location.\n' "$project_name" >&2
  else
    break
  fi
done

namespace_pattern='^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$'
while true; do
  read -r -p 'Project namespace [demo]: ' project_namespace <&3
  project_namespace="${project_namespace:-demo}"
  [[ "$project_namespace" =~ $namespace_pattern ]] && break
  printf 'Use letters, numbers, underscores or hyphens, with dots between namespace segments.\n' >&2
done
while true; do
  read -r -s -p 'PolyAPI key (hidden): ' api_key <&3
  printf '\n'
  [[ -n "$api_key" && ! "$api_key" =~ [[:space:]] ]] && break
  printf 'Enter a nonempty API key without whitespace.\n' >&2
done
while true; do
  read -r -p 'Environment (dev, na1, na2, eu1): ' poly_env <&3
  case "$poly_env" in
    dev|na1|na2|eu1) break ;;
    *) printf 'Choose dev, na1, na2 or eu1.\n' >&2 ;;
  esac
done
exec 3<&-
base_url="https://${poly_env}.polyapi.io"
sdk_tag="$poly_env"
[[ "$poly_env" != dev ]] || sdk_tag=develop

# This child process uses the prompted project's settings rather than a
# connection or environment-file selection inherited from another project.
unset ENVPATH BASE_URL API_KEY POLYAPI_BASE_URL POLYAPI_API_KEY
unset POLY_API_BASE_URL POLY_API_KEY
unset POLYAPI_NAMESPACE POLYAPI_NAMESPACES POLY_API_NAMESPACE POLY_NAMESPACE

download_dir=$(mktemp -d "${TMPDIR:-/tmp}/poly-kickstart.XXXXXXXX")

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
template_root="$(git -C "$script_dir/.." rev-parse --show-toplevel)"
printf 'Preparing project template and downloading skills...\n'
mkdir -p -- "$download_dir/template"
git -C "$template_root" archive HEAD | tar \
  --exclude='.env' --exclude='.env.*' --exclude='*.env' \
  --exclude='*.key' --exclude='*.pem' --exclude='*.p12' \
  --exclude='*.pfx' --exclude='*.crt' \
  -xf - -C "$download_dir/template"
git clone --depth 1 --single-branch --branch main \
  git@github.com:polyapi/poly-skills.git "$download_dir/skills"
[[ -f "$download_dir/template/package.json" ]]
[[ -f "$download_dir/template/kickstart/kickstart-namespace.cjs" ]]
for category in general polyapi-common polyapi-typescript; do
  [[ -d "$download_dir/skills/$category/skills" ]]
done
if [[ ! -s "$download_dir/skills/polyapi-typescript/skills/api-function-training/SKILL.md" ]]; then
  printf 'kickstart: api-function-training is missing from poly-skills/main. Publish the TypeScript training skill there before retrying.\n' >&2
  exit 1
fi

mkdir -p -- "$parent_dir"
mkdir -- "$project_dir"
project_created=true
cp -R "$download_dir/template/." "$project_dir/"
cd -- "$project_dir"
node - "$project_name" <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.name = process.argv[2];
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
NODE
mkdir -p .agents/skills
for category in general polyapi-common polyapi-typescript; do
  cp -R "$download_dir/skills/$category/skills/." .agents/skills/
done
[[ -s .agents/skills/api-function-training/SKILL.md ]]

(
  umask 077
  printf '%s\n' \
    "POLYAPI_NAMESPACE=$project_namespace" \
    '# POLYPROD_EXEC_KEY' \
    '' \
    'LOG_LEVEL=debug' \
    'SLACK_CHANNEL_ID=alerts-demos' \
    '' \
    '# Optional Flow CLI settings' \
    'GIT_PROD_BRANCH=main:prod.env' \
    'GIT_PROD_SKIP_BRANCHES=develop:dev.env' \
    > workflows/dev.env
)

printf 'Installing dependencies...\n'
pnpm install
printf 'Installing PolyAPI SDK for %s...\n' "$poly_env"
pnpm --filter workflows add "polyapi@$sdk_tag"
printf 'Applying project namespace: %s...\n' "$project_namespace"
node kickstart/kickstart-namespace.cjs "$project_namespace"

(
  umask 077
  export POLY_API_BASE_URL="$base_url" POLY_API_KEY="$api_key"
  printf 'Setting up PolyAPI (%s)...\n' "$poly_env"
  # Invoke the SDK's setup CLI without putting the key in pnpm's arguments.
  pnpm --silent workflows exec node <<'NODE'
const path = require('node:path');
const sdkPath = require.resolve('polyapi/package.json');
const sdk = require(sdkPath);
const bin = typeof sdk.bin === 'string' ? sdk.bin : sdk.bin?.poly;
if (!bin) throw new Error('The workflow PolyAPI SDK does not provide its setup CLI.');
const cli = path.resolve(path.dirname(sdkPath), bin);
process.argv = [process.execPath, cli, 'setup', process.env.POLY_API_BASE_URL, process.env.POLY_API_KEY];
require(cli);
NODE
  printf 'Generating PolyAPI SDK...\n'
  pnpm --silent workflows exec poly generate
)

printf 'Building Flow CLI...\n'
pnpm flow build
printf 'Verifying Flow configuration from saved Poly setup...\n'
(
  export KICKSTART_EXPECTED_BASE_URL="$base_url"
  export KICKSTART_EXPECTED_API_KEY="$api_key"
  export KICKSTART_EXPECTED_NAMESPACE="$project_namespace"
  node <<'NODE'
const { loadEnv, getBaseUrl } = require('./cli/dist/utils/apiClient.js');
const { resolveWorkflowPolyConfig } = require('./cli/dist/utils/environment.js');
const { getRequiredNamespaces } = require('./cli/dist/utils/namespace.js');
const { fetchRemoteEnvironment, getTargetEnvId } = require('./cli/dist/utils/targetEnvironment.js');
const fs = require('node:fs');
async function verifyAndPin() {
  if (!resolveWorkflowPolyConfig(process.cwd())) {
    throw new Error('Poly setup did not save a connection for the workflow SDK.');
  }
  loadEnv();
  if (getBaseUrl() !== process.env.KICKSTART_EXPECTED_BASE_URL ||
      process.env.API_KEY !== process.env.KICKSTART_EXPECTED_API_KEY ||
      getRequiredNamespaces().join(',') !== process.env.KICKSTART_EXPECTED_NAMESPACE) {
    throw new Error('Flow configuration does not match the project settings entered during kickstart.');
  }
  const { environmentId } = await fetchRemoteEnvironment();
  // Only the non-secret identity pin is added; URL and key stay in SDK setup.
  fs.appendFileSync('workflows/dev.env', `\nTARGET_ENV_ID=${environmentId}\n`);
  if (getTargetEnvId(loadEnv()) !== environmentId) {
    throw new Error('Flow could not save the verified target environment pin.');
  }
  console.log(`Target environment verified and pinned: ${environmentId}`);
}
verifyAndPin().catch(error => {
  console.error(error instanceof Error ? error.message : 'Flow target verification failed.');
  process.exitCode = 1;
});
NODE
)
unset api_key

printf 'Initializing Git and switching to develop...\n'
git init -b main
git add .
git commit -m 'Initial commit'
git switch -c develop
printf 'Project ready at %s\n' "$project_dir"
code .
