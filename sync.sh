#!/usr/bin/env bash
#
# sync.sh — pull the latest Resident and rebuild the Poem/1 firmware.
#
# Resident is a *dependency* of this project (declared in device/platformio.ini
# as git+https://github.com/inanimate-tech/resident.git#main), not something you
# fork or clone. PlatformIO caches it after the first build, so "staying in sync"
# is just: fetch the latest, rebuild, and (optionally) reflash.
#
#   ./sync.sh          # update Resident + build (no flash)
#   ./sync.sh --flash  # update Resident + build + flash over USB
#
# Requires: pio (PlatformIO Core). For --flash, plug the Poem/1 in via USB.

set -euo pipefail
cd "$(dirname "$0")/device"

echo "==> Fetching the latest Resident (and other deps)…"
pio pkg update

echo "==> Building…"
pio run -e poem1

if [[ "${1:-}" == "--flash" ]]; then
  echo "==> Flashing over USB…"
  echo "    Reminder: if a Lua app is actively drawing (e.g. a clock), push"
  echo "    device-apps/standby.lua first so the e-ink panel is idle."
  pio run -e poem1 -t upload
fi

echo "==> Done."
