#!/bin/bash
# teyvat uninstaller
# Reverse dist patches + remove dist-overrides to restore stock pi.
set -e
echo "── teyvat uninstaller ──"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEV="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PATCHES_DIR="$DEV/spirit.bio.organs/heart.interrupt"

PI_DIST=""
for c in \
  "$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent/dist" \
  "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist" \
  "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist"; do
  [ -f "$c/core/tools/bash.js" ] && { PI_DIST="$c"; break; }
done
[ -z "$PI_DIST" ] && { echo "pi not found, nothing to restore"; exit 0; }

revert_patch() {
  local pf="$1" n; n="$(basename "$pf")"
  if ( cd "$PI_DIST" && git apply --reverse --check -p1 "$pf" ) 2>/dev/null; then
    ( cd "$PI_DIST" && git apply --reverse -p1 "$pf" ); echo "  OK reverted $n"
  else
    echo "  skip $n (not applied)"
  fi
}
echo "Reverting dist patches:"
for p in "$PATCHES_DIR"/*.patch; do
  [ -f "$p" ] && revert_patch "$p"
done

echo ""
echo "── pi dist restored. Extensions in ~/.pi/agent/extensions/ left intact. ──"
