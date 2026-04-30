#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
WORKFLOWS_DIR="$ROOT_DIR/workflows"
PNPM_WORKFLOWS_EXEC=(pnpm -C "$ROOT_DIR" workflows exec)

require_command() {
  local name="$1"
  local install_hint="$2"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "ERROR: $name not found. $install_hint" >&2
    exit 1
  fi
}

require_workflows_binary() {
  local name="$1"
  local install_hint="$2"

  if [ ! -x "$WORKFLOWS_DIR/node_modules/.bin/$name" ]; then
    echo "ERROR: $name not found in workflows. $install_hint" >&2
    exit 1
  fi
}

normalise_to_json() {
  local file_path="$1"

  case "$file_path" in
    *.yaml | *.yml)
      require_command "yq" "Install with: brew install yq"
      local json_path="${file_path%.*}.json"
      echo "Converting YAML to JSON: $file_path -> $json_path" >&2
      yq -o=json '.' "$file_path" > "$json_path"
      echo "$json_path"
      ;;
    *)
      echo "$file_path"
      ;;
  esac
}

is_oas2() {
  local file_path="$1"
  require_command "jq" "Install with: brew install jq"
  [ "$(jq -r '.swagger // empty' "$file_path" 2>/dev/null || true)" = "2.0" ]
}

is_oas3() {
  local file_path="$1"
  require_command "jq" "Install with: brew install jq"
  local version
  version="$(jq -r '.openapi // empty' "$file_path" 2>/dev/null || true)"
  [[ "$version" == 3.* ]]
}

context_for_file() {
  local context_pattern="$1"
  local base_name="$2"

  if [[ "$context_pattern" == *"{file}"* ]]; then
    echo "${context_pattern//\{file\}/$base_name}"
  else
    echo "$context_pattern"
  fi
}

train_spec() {
  local raw_spec_path="$1"
  local context_pattern="$2"
  local spec_path
  spec_path="$(normalise_to_json "$raw_spec_path")"

  if ! is_oas2 "$spec_path" && ! is_oas3 "$spec_path"; then
    require_workflows_binary \
      "swagger2openapi" \
      "Install with: pnpm --filter workflows add -D swagger2openapi"
    local converted_path="${spec_path%.*}.oas3.json"
    "${PNPM_WORKFLOWS_EXEC[@]}" swagger2openapi \
      --patch \
      --warnOnly \
      --resolve \
      "$spec_path" \
      -o "$converted_path"
    spec_path="$converted_path"
  fi

  local spec_dir
  local spec_file
  local base_name
  spec_dir="$(cd "$(dirname "$spec_path")" && pwd)"
  spec_file="$(basename "$spec_path")"
  base_name="${spec_file%.*}"
  base_name="${base_name%.oas3}"

  local context_value
  context_value="$(context_for_file "$context_pattern" "$base_name")"

  echo "Generating Poly model for $spec_path with context $context_value"
  "${PNPM_WORKFLOWS_EXEC[@]}" poly model generate "$spec_path" \
    --context "$context_value" \
    --hostUrlAsArgument

  local generated_file
  generated_file="$WORKFLOWS_DIR/$base_name-api.json"
  if [ -f "$generated_file" ]; then
    mv -f "$generated_file" "$spec_dir/$base_name-api.json"
    generated_file="$spec_dir/$base_name-api.json"
  fi

  if [ ! -f "$generated_file" ]; then
    echo "WARNING: Could not find generated model JSON for $spec_path" >&2
    return
  fi

  echo "Training Poly model from $generated_file"
  "${PNPM_WORKFLOWS_EXEC[@]}" poly model train "$generated_file"
}

echo "Enter the path to an OpenAPI spec file or a folder of specs:"
read -r TARGET_PATH

echo "Enter the PolyAPI context path. Use {file} to inject each file base name:"
read -r CONTEXT_PATTERN

if [ -z "$TARGET_PATH" ] || [ -z "$CONTEXT_PATTERN" ]; then
  echo "Spec path and context are required." >&2
  exit 1
fi

if [ -f "$TARGET_PATH" ]; then
  train_spec "$TARGET_PATH" "$CONTEXT_PATTERN"
elif [ -d "$TARGET_PATH" ]; then
  while IFS= read -r spec_path; do
    train_spec "$spec_path" "$CONTEXT_PATTERN"
  done < <(
    find "$TARGET_PATH" -maxdepth 1 -type f \
      \( -name "*.json" -o -name "*.yaml" -o -name "*.yml" \) | sort
  )
else
  echo "Path does not exist: $TARGET_PATH" >&2
  exit 1
fi

echo "Regenerating PolyAPI TypeScript library"
"${PNPM_WORKFLOWS_EXEC[@]}" poly generate || true

echo "Done."
