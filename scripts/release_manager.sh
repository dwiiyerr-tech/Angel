#!/usr/bin/env bash
set -euo pipefail

release_root="${ANGEL_RELEASE_ROOT:-}"
command_name="${1:-status}"

if [[ -z "$release_root" || "$release_root" != /* || "$release_root" == "/" ]]; then
  echo "ANGEL_RELEASE_ROOT must be an explicit absolute directory other than /" >&2
  exit 2
fi

releases_dir="$release_root/releases"
current_link="$release_root/current"
previous_link="$release_root/previous"

validate_release() {
  local label="$1"
  local target="$releases_dir/$label"
  if [[ "$label" == *"/"* || "$label" == "." || "$label" == ".." ]]; then
    echo "Invalid release label: $label" >&2
    exit 2
  fi
  if [[ ! -f "$target/package.json" || ! -f "$target/src/app.js" || ! -f "$target/index.js" ]]; then
    echo "Release $label is incomplete at $target" >&2
    exit 3
  fi
  printf '%s\n' "$target"
}

atomic_link() {
  local target="$1"
  local link="$2"
  local temporary="$link.next.$$"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}

activate_release() {
  local target="$1"
  local old_target=""
  if [[ -L "$current_link" ]]; then old_target="$(readlink -f "$current_link")"; fi
  mkdir -p "$release_root" "$releases_dir"
  if [[ -n "$old_target" && "$old_target" != "$target" ]]; then
    atomic_link "$old_target" "$previous_link"
  fi
  atomic_link "$target" "$current_link"
  echo "Activated $(basename "$target")"
}

case "$command_name" in
  activate)
    target="$(validate_release "${2:-}")"
    activate_release "$target"
    ;;
  rollback)
    if [[ ! -L "$previous_link" ]]; then
      echo "No previous release slot is available" >&2
      exit 4
    fi
    target="$(readlink -f "$previous_link")"
    validate_release "$(basename "$target")" >/dev/null
    activate_release "$target"
    ;;
  status)
    echo "current=$(if [[ -L "$current_link" ]]; then readlink -f "$current_link"; else echo none; fi)"
    echo "previous=$(if [[ -L "$previous_link" ]]; then readlink -f "$previous_link"; else echo none; fi)"
    ;;
  *)
    echo "Usage: $0 {activate RELEASE|rollback|status}" >&2
    exit 2
    ;;
esac
