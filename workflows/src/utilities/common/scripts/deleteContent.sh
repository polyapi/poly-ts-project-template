#!/usr/bin/env bash
set -euo pipefail

DEFAULT_BASE_URL="https://eu1.polyapi.io"

require_command() {
  local name="$1"
  local install_hint="$2"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "ERROR: $name not found. $install_hint" >&2
    exit 1
  fi
}

mask_value() {
  local value="$1"

  if [ "${#value}" -le 8 ]; then
    echo "********"
    return
  fi

  echo "${value:0:4}...${value: -4}"
}

fetch_items() {
  local list_url="$1"
  local resource_name="$2"
  local items

  items="$(curl -s --location "$list_url" \
    --header "Authorization: Bearer $API_KEY")"

  if ! echo "$items" | jq . >/dev/null 2>&1; then
    echo "Response for $resource_name is not valid JSON." >&2
    echo "$items" >&2
    return 1
  fi

  echo "$items"
}

extract_targets() {
  local items="$1"
  local output_file="$2"

  echo "$items" | jq -c --arg prefix "$CONTEXT_PREFIX" '
    .. | objects
    | select(has("id") and has("context"))
    | select(.context == $prefix or (.context | startswith($prefix + ".")))
  ' > "$output_file"
}

print_preview() {
  local input_file="$1"
  local count
  count="$(jq -s 'length' "$input_file")"

  if [ "$count" -eq 0 ]; then
    return
  fi

  echo "Found $count matching item(s):"
  jq -r '
    {id, name: (.name // "N/A"), context}
    | "ID: \(.id)\n  Name: \(.name)\n  Context: \(.context)\n"
  ' "$input_file"
}

delete_targets() {
  local input_file="$1"
  local delete_base="$2"
  local label="$3"

  while IFS= read -r item; do
    [ -n "$item" ] || continue

    local id
    local name
    local context
    id="$(echo "$item" | jq -r '.id')"
    name="$(echo "$item" | jq -r '.name // "N/A"')"
    context="$(echo "$item" | jq -r '.context')"

    echo "Deleting $label ID: $id"
    echo "  Name:    $name"
    echo "  Context: $context"

    curl -s --location --request DELETE "$delete_base/$id" \
      --header "Authorization: Bearer $API_KEY" >/dev/null
  done < "$input_file"
}

require_command "curl" "Install curl and retry."
require_command "jq" "Install with: brew install jq"

BASE_URL="${BASE_URL:-${POLY_API_BASE_URL:-$DEFAULT_BASE_URL}}"
API_KEY="${API_KEY:-${POLY_API_KEY:-}}"

if [ -z "$API_KEY" ]; then
  read -r -s -p "Enter PolyAPI API key: " API_KEY
  echo ""
fi

if [ -z "$API_KEY" ]; then
  echo "API key is required." >&2
  exit 1
fi

echo "Using PolyAPI base URL: $BASE_URL"
echo "Using API key: $(mask_value "$API_KEY")"
echo ""

read -r -p "Resource type to delete (api/schema/variable/webhook/trigger/table/job): " RESOURCE_TYPE
read -r -p "Context prefix to match exactly or by child context: " CONTEXT_PREFIX

RESOURCE_TYPE="$(echo "$RESOURCE_TYPE" | tr '[:upper:]' '[:lower:]')"

if [ -z "$CONTEXT_PREFIX" ]; then
  echo "Context prefix is required." >&2
  exit 1
fi

case "$RESOURCE_TYPE" in
  api | apis)
    LIST_URL="$BASE_URL/functions/api"
    DELETE_BASE="$BASE_URL/functions/api"
    RESOURCE_LABEL="api"
    ;;
  schema | schemas)
    LIST_URL="$BASE_URL/schemas"
    DELETE_BASE="$BASE_URL/schemas"
    RESOURCE_LABEL="schema"
    ;;
  variable | variables)
    LIST_URL="$BASE_URL/variables"
    DELETE_BASE="$BASE_URL/variables"
    RESOURCE_LABEL="variable"
    ;;
  webhook | webhooks)
    LIST_URL="$BASE_URL/webhooks"
    DELETE_BASE="$BASE_URL/webhooks"
    RESOURCE_LABEL="webhook"
    ;;
  trigger | triggers)
    LIST_URL="$BASE_URL/triggers"
    DELETE_BASE="$BASE_URL/triggers"
    RESOURCE_LABEL="trigger"
    ;;
  table | tables)
    LIST_URL="$BASE_URL/tables"
    DELETE_BASE="$BASE_URL/tables"
    RESOURCE_LABEL="table"
    ;;
  job | jobs)
    LIST_URL="$BASE_URL/jobs"
    DELETE_BASE="$BASE_URL/jobs"
    RESOURCE_LABEL="job"
    ;;
  *)
    echo "Unknown resource type: $RESOURCE_TYPE" >&2
    exit 1
    ;;
esac

TMP_TARGETS="$(mktemp)"
trap 'rm -f "$TMP_TARGETS"' EXIT

echo "Fetching ${RESOURCE_LABEL}s..."
ITEMS="$(fetch_items "$LIST_URL" "$RESOURCE_LABEL")"
extract_targets "$ITEMS" "$TMP_TARGETS"

MATCH_COUNT="$(jq -s 'length' "$TMP_TARGETS")"
if [ "$MATCH_COUNT" -eq 0 ]; then
  echo "No ${RESOURCE_LABEL}s found under context: $CONTEXT_PREFIX"
  exit 0
fi

print_preview "$TMP_TARGETS"
echo ""
read -r -p "Type DELETE to confirm deletion: " CONFIRM

if [ "$CONFIRM" != "DELETE" ]; then
  echo "Aborted."
  exit 0
fi

delete_targets "$TMP_TARGETS" "$DELETE_BASE" "$RESOURCE_LABEL"
echo "Done."
