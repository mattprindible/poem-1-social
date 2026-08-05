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
#   ./sync.sh --flash --force  # skip the QUIESCE abort only (see below)
#
# Requires: pio (PlatformIO Core). For --flash, also curl + jq, plus the Poem/1
# plugged in via USB and reachable on the relay so it can be quiesced first.
#
# --flash has TWO independent safety gates, and --force relaxes only the second:
#
#   1. WHICH BOARD — the pinned upload_port is confirmed by MAC before esptool
#      runs. Never skippable, because "I can see the screen is idle" is not an
#      answer to "is this the right device". Set a different expected MAC with
#      $POEM1_MAC or a .poem1-mac file.
#   2. WHICH PANEL STATE — standby.lua is pushed and allowed to settle, so the
#      reset cannot land mid-refresh. --force skips this one, for when you can
#      SEE the screen is already idle but the device is off-relay.
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

# ── Safety gate 1: is the pinned port actually the Poem/1? ───────────────────
# device/platformio.ini pins upload_port, but a pin is only a comment with
# ambition: port numbering is assigned by the HOST, so replugging can silently
# hand /dev/cu.usbmodem101 to a different board. The Poem/1 and the M5StickS3
# are both ESP32-S3s on the built-in USB JTAG peripheral, so they enumerate with
# an IDENTICAL VID:PID (303A:1001) and differ only by MAC — nothing about the
# port itself distinguishes them.
#
# The MAC is the only reliable discriminator, so check it before esptool touches
# anything. Deliberately NOT overridable by --force: --force means "I can see
# the screen is idle", which is an answer about the PANEL. It is not, and must
# not become, an answer about WHICH BOARD this is — those are different
# questions and conflating them is how you flash the wrong device while feeling
# careful.
POEM1_MAC="${POEM1_MAC:-94:A9:90:29:CF:FC}"
if [[ -f "$REPO_ROOT/.poem1-mac" ]]; then
  POEM1_MAC=$(tr -d '[:space:]' < "$REPO_ROOT/.poem1-mac")
fi

# Read the port we are ABOUT to flash, rather than assuming — a guard that
# checks a different port than the one esptool uses proves nothing.
pinned_port=$(sed -n 's/^[[:space:]]*upload_port[[:space:]]*=[[:space:]]*//p' \
  "$REPO_ROOT/device/platformio.ini" | head -1)

if [[ -z "$pinned_port" ]]; then
  echo "==> No upload_port pinned; leaving board selection to PlatformIO." >&2
  echo "    With two ESP32-S3s attached auto-detect can pick either one." >&2
else
  echo "==> Checking $pinned_port is the Poem/1 (expecting $POEM1_MAC)…"
  actual_mac=$(pio device list --json-output 2>/dev/null \
    | jq -r --arg p "$pinned_port" '.[] | select(.port == $p) | .hwid' \
    | sed -n 's/.*SER=\([0-9A-Fa-f:]*\).*/\1/p' | head -1)

  if [[ -z "$actual_mac" ]]; then
    echo "    ABORT: nothing is attached at $pinned_port." >&2
    echo "    Plug the Poem/1 in, or re-pin upload_port in device/platformio.ini." >&2
    echo "    Current ports:" >&2
    pio device list --json-output 2>/dev/null \
      | jq -r '.[] | select(.hwid | contains("SER=")) | "      \(.port)  \(.hwid)"' >&2
    exit 1
  fi

  if [[ "$actual_mac" != "$POEM1_MAC" ]]; then
    echo "    ABORT: $pinned_port is MAC $actual_mac, not the Poem/1 ($POEM1_MAC)." >&2
    echo "    The ports have almost certainly been reassigned by a replug." >&2
    echo "    Flashing now would reset the WRONG board — and if that board is" >&2
    echo "    the Poem/1 on some other port, the reset lands with no e-ink" >&2
    echo "    quiesce, which is the exact damage this script exists to prevent." >&2
    echo "    Fix by re-pinning upload_port in device/platformio.ini to:" >&2
    pio device list --json-output 2>/dev/null \
      | jq -r --arg m "$POEM1_MAC" \
        '.[] | select(.hwid | contains("SER=" + $m)) | "      \(.port)"' >&2
    exit 1
  fi
  echo "    confirmed: $pinned_port is the Poem/1."
fi

# ── Safety gate 2: quiesce the panel before esptool resets the board ─────────
#
# BETTER, IF SOMEONE IS STANDING THERE: hold the device's button ~3s first. That
# suspends the app AND clears the persisted copy, so nothing is left to restore
# after the flash. Pushing standby.lua only stops the *drawing* — it still
# writes an app into NVS that the next boot will restore and redraw. This gate
# exists for the unattended case, where nobody can press anything.
#
# Also note pushing now needs the owner credential on your own hub (the relay
# gate), which send-app.sh reads from the keychain. No token means this aborts,
# which is the correct direction to fail.
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
