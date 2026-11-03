#!/usr/bin/env bash
# Sourced by kickstart.sh. A new project needs only curl, plus tar and the base
# shell tools every supported OS ships: missing Node.js and pnpm are installed
# for the current user, without sudo. Git and VS Code's `code` command are
# optional; kickstart explains how to finish without them.

KICKSTART_PNPM_VERSION="${KICKSTART_PNPM_VERSION:-10.0.0}"
KICKSTART_MIN_NODE_MAJOR=22
# Official Linux builds of Node.js 25 and newer need the system library
# libatomic, which minimal systems such as containers can lack, and installing
# it needs sudo. Node.js 24 LTS runs without it, so it is the fallback.
KICKSTART_NODE_FALLBACK_MAJOR=24
KICKSTART_PNPM_INSTALLER_URL="${KICKSTART_PNPM_INSTALLER_URL:-https://get.pnpm.io/install.sh}"
toolchain_installed=false

# Every yes/no prompt in kickstart and Flow uses [y/N]: Enter keeps the default
# (no), and only an explicit yes proceeds. Answers are read from descriptor 3,
# the terminal kickstart opened, so piped standard input cannot answer them.
kickstart_confirm() {
  local answer
  while true; do
    printf '%s [y/N]: ' "$1" >&2
    IFS= read -r answer <&3 || return 1
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
      y | yes) return 0 ;;
      '' | n | no) return 1 ;;
      *) printf 'Answer y or n.\n' >&2 ;;
    esac
  done
}

kickstart_is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null
}

# Print a usable command's path. Under WSL, Windows tools reached through
# interop (/mnt/<drive>/...) cannot build a Linux project, so they do not count.
toolchain_command() {
  local resolved
  resolved="$(command -v "$1" 2>/dev/null)" || return 1
  if kickstart_is_wsl && [[ "$resolved" == /mnt/[a-zA-Z]/* ]]; then
    return 1
  fi
  printf '%s' "$resolved"
}

# pnpm's home directory, resolved the way pnpm's installer resolves it.
kickstart_pnpm_home() {
  if [[ -n "${PNPM_HOME:-}" ]]; then
    printf '%s' "$PNPM_HOME"
  elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
    printf '%s/pnpm' "$XDG_DATA_HOME"
  else
    case "$(uname -s)" in
      Darwin) printf '%s/Library/pnpm' "$HOME" ;;
      MINGW* | MSYS* | CYGWIN*)
        if [[ -n "${LOCALAPPDATA:-}" ]] && command -v cygpath >/dev/null 2>&1; then
          printf '%s/pnpm' "$(cygpath -u "$LOCALAPPDATA")"
        else
          printf '%s/AppData/Local/pnpm' "$HOME"
        fi
        ;;
      *) printf '%s/.local/share/pnpm' "$HOME" ;;
    esac
  fi
}

kickstart_use_pnpm_home() {
  PNPM_HOME="$(kickstart_pnpm_home)"
  export PNPM_HOME
  mkdir -p -- "$PNPM_HOME"
  case ":$PATH:" in
    *":$PNPM_HOME:"*) ;;
    *) export PATH="$PNPM_HOME:$PATH" ;;
  esac
  hash -r
}

kickstart_node_major() {
  local node_path
  node_path="$(toolchain_command node)" || return 1
  "$node_path" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

# Print why the first Node.js on PATH cannot start; print nothing if it starts.
kickstart_node_error() {
  local node_path
  if ! node_path="$(toolchain_command node)"; then
    printf 'node was not found on PATH'
    return 0
  fi
  "$node_path" --version 2>&1 >/dev/null || true
}

ensure_pnpm() {
  local pnpm_path installer
  if pnpm_path="$(toolchain_command pnpm)" &&
    "$pnpm_path" --version >/dev/null 2>&1; then
    return 0
  fi
  printf 'pnpm was not found. Installing pnpm %s for your user with the official installer...\n' \
    "$KICKSTART_PNPM_VERSION"
  installer="$(mktemp "${TMPDIR:-/tmp}/kickstart-pnpm.XXXXXXXX")" || return 1
  if ! curl --fail --silent --show-error --location --proto '=https' \
    "$KICKSTART_PNPM_INSTALLER_URL" --output "$installer"; then
    rm -f -- "$installer"
    printf 'kickstart: could not download the pnpm installer.\n' >&2
    return 1
  fi
  # The installer adds pnpm's home directory to the shell profile named by
  # SHELL, so new terminals find pnpm and the Node.js it installs.
  if ! env PNPM_VERSION="$KICKSTART_PNPM_VERSION" sh "$installer"; then
    rm -f -- "$installer"
    printf 'kickstart: pnpm installation failed. See https://pnpm.io/installation\n' >&2
    return 1
  fi
  rm -f -- "$installer"
  kickstart_use_pnpm_home
  if ! pnpm --version >/dev/null 2>&1; then
    printf 'kickstart: pnpm was installed in %s but cannot be run.\n' "$PNPM_HOME" >&2
    return 1
  fi
  toolchain_installed=true
}

# Ask once before replacing an outdated Node.js; declining changes nothing.
kickstart_node_replacement_confirmed=false
kickstart_confirm_node_replacement() {
  [[ "$kickstart_node_replacement_confirmed" == true ]] && return 0
  printf 'Node.js %s is older than this template supports (%s or newer).\n' \
    "$1" "$KICKSTART_MIN_NODE_MAJOR"
  printf 'pnpm can install the current Node.js LTS for your user; new terminals will then use it instead of Node.js %s.\n' \
    "$1"
  if ! kickstart_confirm 'Install the current Node.js LTS now?'; then
    printf 'kickstart: Node.js %s or newer is required. Install it, then run kickstart again.\n' \
      "$KICKSTART_MIN_NODE_MAJOR" >&2
    return 1
  fi
  kickstart_node_replacement_confirmed=true
}

ensure_node() {
  local major
  major="$(kickstart_node_major || true)"
  if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= KICKSTART_MIN_NODE_MAJOR)); then
    return 0
  fi
  if [[ "$major" =~ ^[0-9]+$ ]]; then
    kickstart_confirm_node_replacement "$major" || return 1
  else
    printf 'Node.js was not found. Installing the current Node.js LTS for your user with pnpm...\n'
  fi
  if [[ -z "${PNPM_HOME:-}" ]]; then
    # A pnpm installed by npm or Homebrew may not have its global directory
    # configured yet; `pnpm env` installs Node.js there.
    pnpm setup >/dev/null || return 1
  fi
  kickstart_use_pnpm_home
  if ! pnpm env use --global lts; then
    printf 'kickstart: Node.js installation failed. Install Node.js %s or newer, then run kickstart again.\n' \
      "$KICKSTART_MIN_NODE_MAJOR" >&2
    return 1
  fi
  hash -r
  major="$(kickstart_node_major || true)"
  if ! [[ "$major" =~ ^[0-9]+$ ]] && [[ "$(kickstart_node_error)" == *libatomic* ]]; then
    printf 'The current Node.js LTS needs the system library libatomic, which is not installed.\n'
    printf 'Installing Node.js %s LTS instead, which runs without it...\n' \
      "$KICKSTART_NODE_FALLBACK_MAJOR"
    if pnpm env use --global "$KICKSTART_NODE_FALLBACK_MAJOR"; then
      hash -r
      major="$(kickstart_node_major || true)"
      if [[ "$major" =~ ^[0-9]+$ ]]; then
        printf 'To use the current LTS later, install libatomic (libatomic1 on Debian and Ubuntu), then run `pnpm env use --global lts`.\n'
      fi
    fi
  fi
  if ! [[ "$major" =~ ^[0-9]+$ ]]; then
    printf 'kickstart: the installed Node.js cannot start: %s\n' "$(kickstart_node_error)" >&2
    return 1
  fi
  if ((major < KICKSTART_MIN_NODE_MAJOR)); then
    printf 'kickstart: Node.js was installed but Node.js %s is first on PATH.\n' "$major" >&2
    return 1
  fi
  toolchain_installed=true
}

ensure_toolchain() {
  local major
  major="$(kickstart_node_major || true)"
  # Ask about an outdated Node.js before installing pnpm, so that declining
  # leaves the machine unchanged.
  if [[ "$major" =~ ^[0-9]+$ ]] && ((major < KICKSTART_MIN_NODE_MAJOR)); then
    kickstart_confirm_node_replacement "$major" || return 1
  fi
  ensure_pnpm && ensure_node
}

# Git is optional: without it, kickstart skips repository initialization. The
# macOS /usr/bin/git stub opens an installer dialog unless the Command Line
# Tools are present, so only count it when they are.
kickstart_git_usable() {
  local git_path
  git_path="$(toolchain_command git)" || return 1
  if [[ "$(uname -s)" == Darwin && "$git_path" == /usr/bin/git ]]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  "$git_path" --version >/dev/null 2>&1
}

kickstart_open_editor() {
  if command -v code >/dev/null 2>&1; then
    code "$1"
  elif [[ "$(uname -s)" == Darwin ]] &&
    open -a 'Visual Studio Code' "$1" 2>/dev/null; then
    return 0
  else
    printf 'VS Code was not opened: its `code` command was not found. Open %s in your editor.\n' "$1"
  fi
}
