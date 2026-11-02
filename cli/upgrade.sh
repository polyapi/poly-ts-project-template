#!/usr/bin/env bash
# One-time bridge for projects whose Flow CLI does not yet support self-update.
set +x
set +v
set -euo pipefail

upgrade_tmp=''

upgrade_cleanup() {
  local upgrade_result=$?
  if [[ -n "$upgrade_tmp" ]]; then
    rm -rf -- "$upgrade_tmp" || true
  fi
  return "$upgrade_result"
}

upgrade_error() {
  printf 'Flow upgrade: %s\n' "$1" >&2
  exit 1
}

upgrade_help() {
  cat <<'HELP'
Bootstrap an older TypeScript project onto Flow's self-updating CLI.

Run from the project root, or supply --project /absolute/project/path.
This script can run locally or through curl ... | bash -s -- [options].

Options:
  --check                         Preview without changing the project
  --yes                           Authorize replacement without a prompt
  --approve-dependency-changes    Explicitly approve the displayed CLI dependency changes
  --project PATH                  Target project (default: discover from current directory)
  --source SOURCE                 GitHub SSH or local Git repository
  --ref REF                       Branch, tag, or commit (default: main)
  --help                          Show this help without downloading anything

Default source: git@github.com:polyapi/poly-ts-project-template.git
Requires Git, Node.js, pnpm, and access to the template repository.
Private HTTP downloads need authentication in the curl command; this script
uses Git SSH for its downloads and does not require the GitHub CLI.
HELP
}

upgrade_extract() {
  local upgrade_relative=$1
  local upgrade_destination=$2
  local upgrade_entry upgrade_metadata upgrade_name upgrade_mode upgrade_kind upgrade_object
  upgrade_entry=$(git -C "$upgrade_tmp/repository" ls-tree "$upgrade_commit" -- "$upgrade_relative" 2>/dev/null) ||
    upgrade_error 'Unable to inspect the downloaded bootstrap files.'
  IFS=$'\t' read -r upgrade_metadata upgrade_name <<< "$upgrade_entry"
  read -r upgrade_mode upgrade_kind upgrade_object <<< "$upgrade_metadata"
  if [[ "$upgrade_name" != "$upgrade_relative" || "$upgrade_kind" != blob ||
    ( "$upgrade_mode" != 100644 && "$upgrade_mode" != 100755 ) ]]; then
    upgrade_error 'Selected template revision lacks a regular bootstrap file. Use a revision containing the new upgrader.'
  fi
  git -C "$upgrade_tmp/repository" show "$upgrade_commit:$upgrade_relative" > "$upgrade_destination" 2>/dev/null ||
    upgrade_error 'Unable to read the downloaded bootstrap files.'
  [[ -s "$upgrade_destination" ]] || upgrade_error 'The downloaded bootstrap file is empty.'
}

upgrade_main() {
  local upgrade_source='git@github.com:polyapi/poly-ts-project-template.git'
  local upgrade_ref='main'
  local upgrade_project=''
  local upgrade_check=false
  local upgrade_yes=false
  local upgrade_approve=false
  local upgrade_option upgrade_value upgrade_tool
  local -a upgrade_args

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --help|-h) upgrade_help; return 0 ;;
      --check) upgrade_check=true; shift ;;
      --yes) upgrade_yes=true; shift ;;
      --approve-dependency-changes) upgrade_approve=true; shift ;;
      --project|--source|--ref)
        upgrade_option=$1
        [[ "$#" -ge 2 && -n "$2" && "$2" != --* ]] || upgrade_error "$upgrade_option requires a value."
        upgrade_value=$2
        shift 2
        case "$upgrade_option" in
          --project) upgrade_project=$upgrade_value ;;
          --source) upgrade_source=$upgrade_value ;;
          --ref) upgrade_ref=$upgrade_value ;;
        esac
        ;;
      --project=*|--source=*|--ref=*)
        upgrade_option=${1%%=*}
        upgrade_value=${1#*=}
        [[ -n "$upgrade_value" && "$upgrade_value" != --* ]] || upgrade_error "$upgrade_option requires a value."
        shift
        case "$upgrade_option" in
          --project) upgrade_project=$upgrade_value ;;
          --source) upgrade_source=$upgrade_value ;;
          --ref) upgrade_ref=$upgrade_value ;;
        esac
        ;;
      *) upgrade_error 'Unknown option. Run with --help for supported options.' ;;
    esac
  done

  [[ "$upgrade_ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || upgrade_error 'Invalid --ref; use a branch, tag, or commit.'
  for upgrade_tool in git node pnpm; do
    command -v "$upgrade_tool" >/dev/null 2>&1 || upgrade_error "Required command not found: $upgrade_tool"
  done

  # Normalize local paths before Git sees them. Disallow URL credentials and
  # Git option/protocol tricks; no authentication values enter this script.
  upgrade_source=$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const source = process.argv[1];
    if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(source)) {
      process.stdout.write(source);
    } else {
      try {
        const absolute = path.resolve(source);
        if (!fs.statSync(absolute).isDirectory()) process.exit(1);
        process.stdout.write(fs.realpathSync(absolute));
      } catch { process.exit(1); }
    }
  ' "$upgrade_source") || upgrade_error '--source must be a local Git directory or git@github.com:owner/repository.git.'

  # A piped Bash script has no terminal on stdin. Reconnect only the downloaded
  # Node process so its confirmation prompt can still be answered interactively.
  if [[ ! -t 0 && "$upgrade_check" == false && "$upgrade_yes" == false ]]; then
    [[ -t 1 ]] || upgrade_error 'Use an interactive terminal, or review --check and authorize with --yes.'
    { exec 3</dev/tty; } 2>/dev/null || upgrade_error 'Cannot open the terminal; review --check and authorize with --yes.'
  fi

  umask 077
  upgrade_tmp=$(mktemp -d "${TMPDIR:-/tmp}/flow-upgrade.XXXXXXXX")
  trap upgrade_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  git init --quiet "$upgrade_tmp/repository" </dev/null 2>/dev/null || upgrade_error 'Unable to prepare the temporary download.'
  printf 'Downloading the Flow upgrade helper...\n'
  git -C "$upgrade_tmp/repository" fetch --quiet --depth=1 --no-tags -- "$upgrade_source" "$upgrade_ref" </dev/null 2>/dev/null ||
    upgrade_error 'Git download failed. Check repository access and --ref.'
  upgrade_commit=$(git -C "$upgrade_tmp/repository" rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null) ||
    upgrade_error 'Unable to resolve the selected template commit.'
  [[ "$upgrade_commit" =~ ^[a-f0-9]{40,64}$ ]] || upgrade_error 'Git returned an invalid commit ID.'
  upgrade_extract 'cli/bin/self-update.cjs' "$upgrade_tmp/self-update.cjs"
  upgrade_extract 'cli/bin/bootstrap-manifests.cjs' "$upgrade_tmp/bootstrap-manifests.cjs"

  upgrade_args=(--bootstrap --source "$upgrade_source" --ref "$upgrade_commit")
  [[ -z "$upgrade_project" ]] || upgrade_args+=(--project "$upgrade_project")
  [[ "$upgrade_check" == false ]] || upgrade_args+=(--check)
  [[ "$upgrade_yes" == false ]] || upgrade_args+=(--yes)
  [[ "$upgrade_approve" == false ]] || upgrade_args+=(--approve-dependency-changes)

  if [[ -t 0 ]]; then
    node "$upgrade_tmp/self-update.cjs" "${upgrade_args[@]}"
  elif [[ "$upgrade_check" == true || "$upgrade_yes" == true ]]; then
    node "$upgrade_tmp/self-update.cjs" "${upgrade_args[@]}" </dev/null
  else
    node "$upgrade_tmp/self-update.cjs" "${upgrade_args[@]}" <&3
  fi
}

# Keep this invocation last: Bash must parse the whole function before any
# child process receives stdin, including when the script arrives via curl.
upgrade_main "$@"
