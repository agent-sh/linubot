#!/bin/bash
set -euo pipefail
browser="${LINUBOT_BROWSER_BIN:-}"
if [[ -z "$browser" ]]; then
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then browser="$(command -v "$candidate")"; break; fi
  done
fi
if [[ -z "$browser" ]]; then
  printf '%s\n' 'Install Chromium or Google Chrome to use a Linubot browser workspace.' >&2
  exit 1
fi
# The backend adds this flag for namespace compatibility. Linubot uses a normal
# owned X11 display, so retain Chromium's own renderer sandbox.
arguments=()
for argument in "$@"; do
  if [[ "$argument" != '--no-sandbox' ]]; then arguments+=("$argument"); fi
done
exec "$browser" "${arguments[@]}"
