#!/usr/bin/env bash
# Run directly, or download to a temporary file and execute with Bash.
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

for tool in curl tar git node pnpm code; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'kickstart: required command not found: %s\n' "$tool" >&2
    exit 1
  fi
done

while true; do
  read -r -p 'Project name: ' project_name
  if [[ "$project_name" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
    break
  fi
  printf 'Use lowercase letters, numbers, dots, underscores or hyphens; start with a letter or number.\n' >&2
done

default_parent="$HOME/Code/poly"
while true; do
  read -r -p "Parent directory [$default_parent]: " parent_dir
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
  read -r -p 'Project namespace [demo]: ' project_namespace
  project_namespace="${project_namespace:-demo}"
  [[ "$project_namespace" =~ $namespace_pattern ]] && break
  printf 'Use letters, numbers, underscores or hyphens, with dots between namespace segments.\n' >&2
done
while true; do
  read -r -s -p 'PolyAPI key (hidden): ' api_key
  printf '\n'
  [[ -n "$api_key" && ! "$api_key" =~ [[:space:]] ]] && break
  printf 'Enter a nonempty API key without whitespace.\n' >&2
done
while true; do
  read -r -p 'Environment (dev, na1, na2, eu1): ' poly_env
  case "$poly_env" in
    dev|na1|na2|eu1) break ;;
    *) printf 'Choose dev, na1, na2 or eu1.\n' >&2 ;;
  esac
done
base_url="https://${poly_env}.polyapi.io"
sdk_tag="$poly_env"
[[ "$poly_env" != dev ]] || sdk_tag=develop

download_dir=$(mktemp -d "${TMPDIR:-/tmp}/poly-kickstart.XXXXXXXX")

download_repository() {
  local repo="$1" destination="$2"
  local archive="$download_dir/$repo.tar.gz"
  mkdir -p -- "$destination"
  if curl --fail --location --silent --show-error --retry 2 \
    --output "$archive" "https://codeload.github.com/polyapi/$repo/tar.gz/refs/heads/main"; then
    tar -xzf "$archive" -C "$destination" --strip-components=1
  else
    printf 'HTTPS archive unavailable for %s; trying GitHub SSH access...\n' "$repo"
    git clone --depth 1 --single-branch --branch main \
      "git@github.com:polyapi/$repo.git" "$destination"
    rm -rf -- "$destination/.git"
  fi
}

printf 'Downloading project template and skills...\n'
download_repository poly-ts-project-template "$download_dir/template"
download_repository poly-skills "$download_dir/skills"
[[ -f "$download_dir/template/package.json" ]]
[[ -f "$download_dir/template/scripts/kickstart-namespace.cjs" ]]
for category in general polyapi-common polyapi-typescript; do
  [[ -d "$download_dir/skills/$category/skills" ]]
done

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

(
  umask 077
  printf '%s\n' \
    "POLYAPI_NAMESPACE=$project_namespace" \
    "BASE_URL=$base_url" \
    "API_KEY=$api_key" \
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
node scripts/kickstart-namespace.cjs "$project_namespace"

(
  umask 077
  export POLY_API_BASE_URL="$base_url" POLY_API_KEY="$api_key"
  printf 'Setting up PolyAPI (%s)...\n' "$poly_env"
  pnpm --silent workflows exec poly setup "$base_url" "$api_key"
  printf 'Generating PolyAPI SDK...\n'
  pnpm --silent workflows exec poly generate
)
unset api_key

printf 'Initializing Git and switching to develop...\n'
git init -b main
git add .
git commit -m 'Initial commit'
git switch -c develop
printf 'Project ready at %s\n' "$project_dir"
code .
