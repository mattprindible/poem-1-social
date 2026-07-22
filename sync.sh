#!/usr/bin/env bash
#
# sync.sh — pull the latest Resident and rebuild the Poem/1 firmware.
#
# Resident is a *dependency* of this project (declared in device/platformio.ini
# as git+https://github.com/inanimate-tech/resident.git#main), not something you
# fork or clone. PlatformIO caches it after the first build, so "staying in sync"
# is just: fetch the latest, rebuild, and (optionally) reflash.
#
#   ./sync.sh                  # update Resident + build (no flash)
#   ./sync.sh --flash          # update + build + SAFELY flash over USB
#   ./sync.sh --flash --force  # skip the safety abort (see below)
#
# Requires: pio (PlatformIO Core). For --flash, also curl + jq, plus the Poem/1
# plugged in via USB and reachable on the relay so it can be quiesced first.
#
# ─────────────────────────────────────────────────────────────────────────────
# E-INK FLASH SAFETY (why --flash is more than `pio run -t upload`)
#
# `pio run -t upload` resets the board into download mode. If the Poem/1's e-ink
# panel is mid-refresh when that reset lands, the interrupted EPD waveform can
# physically damage the panel. Under Resident the panel ONLY refreshes while a
# Lua app is calling flip(), so the fix is to quiesce it first: push standby.lua
# (draws once, then idle), wait for that single refresh to finish, and only then
# flash. --flash does this automatically. If the device can't be reached to
# quiesce it, --flash ABORTS rather than risk a blind reset — override with
# --force ONLY when you can see the screen is already idle or in screensaver.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# How long to wait after pushing standby for the single 'quality' full refresh
# to complete (relay delivery + compile + ~2-4s EPD waveform). Generous margin.
QUIESCE_WAIT="${QUIESCE_WAIT:-8}"

do_flash=0
force=0
for arg in "$@"; do
  case "$arg" in
    --flash) do_flash=1 ;;
    --force) force=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" >&2; exit 0 ;;
    *) echo "sync: unknown option: $arg" >&2; exit 2 ;;
  esac
done

echo "==> Fetching the latest Resident (and other deps)…"
pio pkg update -d "$REPO_ROOT/device"

echo "==> Building…"
pio run -e poem1 -d "$REPO_ROOT/device"

if [[ "$do_flash" -eq 0 ]]; then
  echo "==> Done."
  exit 0
fi

# ── Safe flash: quiesce the panel before esptool resets the board ────────────
echo "==> Quiescing the e-ink panel before flashing…"
if "$REPO_ROOT/send-app.sh" "$REPO_ROOT/device-apps/standby.lua"; then
  echo "    standby.lua pushed; waiting ${QUIESCE_WAIT}s for the refresh to settle…"
  sleep "$QUIESCE_WAIT"
  echo "    panel should now be idle."
elif [[ "$force" -eq 1 ]]; then
  echo "    WARNING: couldn't quiesce the device, but --force was given." >&2
  echo "    Proceeding on your word that the screen is idle or in screensaver." >&2
else
  echo "    ABORT: couldn't push standby.lua, so the panel state is unknown." >&2
  echo "    Flashing now could reset the board mid-refresh and damage the e-ink." >&2
  echo "    If the screen is already idle or in screensaver, re-run:" >&2
  echo "        ./sync.sh --flash --force" >&2
  exit 1
fi

echo "==> Flashing over USB…"
pio run -e poem1 -t upload -d "$REPO_ROOT/device"

echo "==> Done."
