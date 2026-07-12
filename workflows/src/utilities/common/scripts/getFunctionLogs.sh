#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
WORKFLOWS_DIR="$ROOT_DIR/workflows"

usage() {
  cat <<'EOF'
Usage:
  ENVPATH=workflows/dev.env ./workflows/src/utilities/common/scripts/getFunctionLogs.sh <function-id> [options]

Options:
  --logs-page <number>       Logs page to fetch. Defaults to 1.
  --logs-page-size <number>  Logs page size. Defaults to 100.
  --keyword <text>           Optional keyword filter, for example "error".
  --limit <number>           Logs result limit. Defaults to --logs-page-size.
  --raw                      Print the raw API response.
  -h, --help                 Show this help.

Examples:
  ENVPATH=workflows/dev.env ./workflows/src/utilities/common/scripts/getFunctionLogs.sh fn_123
  ENVPATH=workflows/dev.env ./workflows/src/utilities/common/scripts/getFunctionLogs.sh fn_123 --keyword error
  ENVPATH=workflows/dev.env ./workflows/src/utilities/common/scripts/getFunctionLogs.sh fn_123 --logs-page 1 --logs-page-size 1000 --limit 1000
EOF
}

require_command() {
  local name="$1"
  local install_hint="$2"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "ERROR: $name not found. $install_hint" >&2
    exit 1
  fi
}

absolute_path() {
  local target_path="$1"
  local target_dir
  local target_name

  target_dir="$(cd "$(dirname "$target_path")" && pwd)"
  target_name="$(basename "$target_path")"

  echo "$target_dir/$target_name"
}

resolve_env_path() {
  local env_path="$1"
  local candidate

  if [[ "$env_path" = /* ]]; then
    echo "$env_path"
    return
  fi

  for candidate in "$PWD/$env_path" "$ROOT_DIR/$env_path" "$WORKFLOWS_DIR/$env_path"; do
    if [ -f "$candidate" ]; then
      absolute_path "$candidate"
      return
    fi
  done

  echo "$ROOT_DIR/$env_path"
}

read_env_value() {
  local env_file="$1"
  local key="$2"

  node - "$env_file" "$key" "$WORKFLOWS_DIR" <<'NODE'
const fs = require('node:fs');
const { createRequire } = require('node:module');

const [, , envFile, key, workflowsDir] = process.argv;

try {
  const requireFromWorkflows = createRequire(`${workflowsDir}/package.json`);
  const dotenv = requireFromWorkflows('dotenv');
  const parsed = dotenv.parse(fs.readFileSync(envFile));

  process.stdout.write(parsed[key] ?? '');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to read ${key} from ENVPATH: ${message}`);
  process.exit(1);
}
NODE
}

require_option_value() {
  local option_name="$1"
  local option_value="${2:-}"

  if [ -z "$option_value" ]; then
    echo "$option_name requires a value." >&2
    exit 1
  fi
}

require_positive_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$name must be a positive integer." >&2
    exit 1
  fi
}

build_logs_url() {
  local base_url="$1"
  local function_id="$2"
  local logs_page="$3"
  local logs_page_size="$4"
  local keyword="$5"
  local limit="$6"

  node - "$base_url" "$function_id" "$logs_page" "$logs_page_size" "$keyword" "$limit" <<'NODE'
const [,
  ,
  baseUrl,
  functionId,
  logsPage,
  logsPageSize,
  keyword,
  limit,
] = process.argv;

try {
  const normalizedBaseUrl = `${baseUrl.replace(/\/+$/, '')}/`;
  const encodedFunctionId = encodeURIComponent(functionId);
  const logsUrl = new URL(
    `/functions/server/${encodedFunctionId}/logs`,
    normalizedBaseUrl
  );

  logsUrl.searchParams.set('logsPage', logsPage);
  logsUrl.searchParams.set('logsPageSize', logsPageSize);
  if (keyword) {
    logsUrl.searchParams.set('keyword', keyword);
  }
  logsUrl.searchParams.set('limit', limit);

  process.stdout.write(logsUrl.toString());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to build logs URL: ${message}`);
  process.exit(1);
}
NODE
}

format_response_file() {
  local response_file="$1"

  node - "$response_file" <<'NODE'
const fs = require('node:fs');

const [, , responseFile] = process.argv;
const input = fs.readFileSync(responseFile, 'utf8');

if (!input.trim()) {
  process.exit(0);
}

function findLogs(value) {
  if (Array.isArray(value)) {
    return { logs: value, container: null, key: null };
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const key of ['logs', 'items', 'data', 'results']) {
    if (Array.isArray(value[key])) {
      return { logs: value[key], container: value, key };
    }
  }

  for (const nestedValue of Object.values(value)) {
    if (nestedValue && typeof nestedValue === 'object') {
      const nestedResult = findLogs(nestedValue);
      if (nestedResult) {
        return nestedResult;
      }
    }
  }

  return null;
}

function pickValue(entry, keys) {
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
      return entry[key];
    }
  }

  return '';
}

function formatLogEntry(entry, index) {
  if (typeof entry === 'string') {
    return entry;
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return JSON.stringify(entry, null, 2);
  }

  const timestamp = pickValue(entry, [
    'timestamp',
    'time',
    'createdAt',
    'created_at',
    'date',
  ]);
  const level = pickValue(entry, ['level', 'severity', 'status']);
  const message = pickValue(entry, ['message', 'msg', 'text', 'body', 'error']);
  const titleParts = [];

  if (timestamp) {
    titleParts.push(String(timestamp));
  }
  if (level) {
    titleParts.push(String(level).toUpperCase());
  }
  if (message) {
    titleParts.push(String(message));
  }

  const knownKeys = new Set([
    'timestamp',
    'time',
    'createdAt',
    'created_at',
    'date',
    'level',
    'severity',
    'status',
    'message',
    'msg',
    'text',
    'body',
    'error',
  ]);
  const details = Object.fromEntries(
    Object.entries(entry).filter(([key]) => !knownKeys.has(key))
  );

  const lines = [
    titleParts.length > 0 ? titleParts.join(' | ') : `Log ${index + 1}`,
  ];

  if (Object.keys(details).length > 0) {
    lines.push(
      JSON.stringify(details, null, 2)
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n')
    );
  }

  return lines.join('\n');
}

try {
  const parsed = JSON.parse(input);
  const logsResult = findLogs(parsed);

  if (
    logsResult &&
    logsResult.logs.every(
      item => typeof item === 'string' || (item && typeof item === 'object')
    )
  ) {
    const { logs, container, key } = logsResult;

    if (logs.length === 0) {
      console.log('No logs found.');
      process.exit(0);
    }

    console.log(`Logs (${logs.length})`);

    if (container && key) {
      const metadata = Object.fromEntries(
        Object.entries(container).filter(([entryKey]) => entryKey !== key)
      );

      if (Object.keys(metadata).length > 0) {
        console.log('');
        console.log('Metadata');
        console.log(JSON.stringify(metadata, null, 2));
      }
    }

    console.log('');
    console.log(logs.map(formatLogEntry).join('\n\n'));
    process.exit(0);
  }

  console.log(JSON.stringify(parsed, null, 2));
} catch {
  process.stdout.write(input);
}
NODE
}

require_command "curl" "Install curl and retry."
require_command "node" "Install Node.js and retry."

FUNCTION_ID=""
LOGS_PAGE="1"
LOGS_PAGE_SIZE="100"
KEYWORD=""
LIMIT=""
RAW_OUTPUT="false"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --logs-page)
      require_option_value "$1" "${2:-}"
      LOGS_PAGE="$2"
      shift 2
      ;;
    --logs-page=*)
      LOGS_PAGE="${1#*=}"
      shift
      ;;
    --logs-page-size)
      require_option_value "$1" "${2:-}"
      LOGS_PAGE_SIZE="$2"
      shift 2
      ;;
    --logs-page-size=*)
      LOGS_PAGE_SIZE="${1#*=}"
      shift
      ;;
    --keyword)
      require_option_value "$1" "${2:-}"
      KEYWORD="$2"
      shift 2
      ;;
    --keyword=*)
      KEYWORD="${1#*=}"
      shift
      ;;
    --limit)
      require_option_value "$1" "${2:-}"
      LIMIT="$2"
      shift 2
      ;;
    --limit=*)
      LIMIT="${1#*=}"
      shift
      ;;
    --raw)
      RAW_OUTPUT="true"
      shift
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$FUNCTION_ID" ]; then
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi

      FUNCTION_ID="$1"
      shift
      ;;
  esac
done

if [ -z "$LIMIT" ]; then
  LIMIT="$LOGS_PAGE_SIZE"
fi

require_positive_integer "logsPage" "$LOGS_PAGE"
require_positive_integer "logsPageSize" "$LOGS_PAGE_SIZE"
require_positive_integer "limit" "$LIMIT"

if [ -z "$FUNCTION_ID" ]; then
  read -r -p "Function ID: " FUNCTION_ID
fi

if [ -z "$FUNCTION_ID" ]; then
  echo "Function ID is required." >&2
  exit 1
fi

if [[ "$FUNCTION_ID" == */* ]]; then
  echo "Function ID must not contain '/'." >&2
  exit 1
fi

if [ -z "${ENVPATH:-}" ]; then
  echo "ENVPATH is required, for example: ENVPATH=workflows/dev.env" >&2
  exit 1
fi

SELECTED_ENV_PATH="$(resolve_env_path "$ENVPATH")"

if [ ! -f "$SELECTED_ENV_PATH" ]; then
  echo "ENVPATH points to a file that does not exist: $ENVPATH" >&2
  exit 1
fi

BASE_URL="$(read_env_value "$SELECTED_ENV_PATH" "BASE_URL")"
BASE_URL="${BASE_URL:-$(read_env_value "$SELECTED_ENV_PATH" "POLYAPI_BASE_URL")}"
BASE_URL="${BASE_URL:-$(read_env_value "$SELECTED_ENV_PATH" "POLY_API_BASE_URL")}"
API_KEY="$(read_env_value "$SELECTED_ENV_PATH" "API_KEY")"
API_KEY="${API_KEY:-$(read_env_value "$SELECTED_ENV_PATH" "POLYAPI_API_KEY")}"
API_KEY="${API_KEY:-$(read_env_value "$SELECTED_ENV_PATH" "POLY_API_KEY")}"

if [ -z "$BASE_URL" ]; then
  echo "BASE_URL is required in ENVPATH." >&2
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "API_KEY is required in ENVPATH." >&2
  exit 1
fi

BASE_URL="${BASE_URL%/}"
LOGS_URL="$(build_logs_url "$BASE_URL" "$FUNCTION_ID" "$LOGS_PAGE" "$LOGS_PAGE_SIZE" "$KEYWORD" "$LIMIT")"
TMP_RESPONSE="$(mktemp)"
trap 'rm -f "$TMP_RESPONSE"' EXIT

curl -sS --location "$LOGS_URL" \
  --header "Accept: application/json" \
  --header "Authorization: Bearer $API_KEY" \
  > "$TMP_RESPONSE"

if [ "$RAW_OUTPUT" = "true" ]; then
  cat "$TMP_RESPONSE"
  printf '\n'
  exit 0
fi

format_response_file "$TMP_RESPONSE"
