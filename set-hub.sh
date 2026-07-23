#!/usr/bin/env bash
#
# set-hub.sh — Point a Poem/1 at a different Resident hub, over the air.
#
#   ./set-hub.sh my-hub.example.workers.dev   # move to that hub
#   ./set-hub.sh --clear                      # back to the public relay
#
# Sends {"type":"set_hub","host":"..."} through the hub the device is on RIGHT
# NOW; the device persists it to NVS and reconnects. No reflash, no reboot.
#
# The current hub, and the device ID, resolve exactly as they do in send-app.sh
# (flag, then env var, then dotfile). On success this updates .resident-hub-url
# so subsequent send-app.sh pushes follow the device to its new home.
#
# Because the device has no way to report back yet (DeviceAgent.onMessage is a
# no-op upstream — see docs/social-plan.md), success is confirmed the only way
# available from here: by watching the DESTINATION hub's connection count and
# waiting for it to RISE.
#
# It counts the rise, not merely a non-zero count, because Durable Objects hold
# on to hibernating WebSockets from previous boots — a hub the device left hours
# ago can still report "connections: 1". Checking for non-zero produced a
# confident false positive while the device was in fact somewhere else entirely.
# Comparing against a pre-send baseline is still best-effort, not proof: it can
# report failure if a stale entry is reaped at the same moment the device
# arrives. Serial, or the device's own screen, remains the ground truth.
#
# Requires: curl, jq.

set -euo pipefail

PROD_URL="https://resident.inanimate.tech"
DEV_URL="http://localhost:5173"
DEFAULT_HUB_HOST="resident.inanimate.tech"   # must match DEFAULT_HUB_HOST in main.cpp
CONNECT_TIMEOUT_SECS=45

base_url=""
device_id="${RESIDENT_DEVICE_ID:-}"
new_host=""
do_clear=0

usage() {
  cat <<EOF >&2
Usage: $0 [--base-url URL | --dev] [--device-id ID] (HOSTNAME | --clear)

  HOSTNAME   bare hostname of the destination hub (no scheme, no path)
  --clear    forget the stored hub; revert to $DEFAULT_HUB_HOST

Current hub (where the command is SENT):
  --base-url URL, then \$RESIDENT_BASE_URL, then ./.resident-hub-url, then $PROD_URL
Device ID:
  --device-id ID, then \$RESIDENT_DEVICE_ID, then ./.resident-device-id
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)  base_url="$2"; shift 2 ;;
    --dev)       base_url="$DEV_URL"; shift ;;
    --device-id) device_id="$2"; shift 2 ;;
    --clear)     do_clear=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*)          echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *)           new_host="$1"; shift ;;
  esac
done

if [[ "$do_clear" -eq 1 && -n "$new_host" ]]; then
  echo "set-hub: pass a hostname or --clear, not both." >&2
  exit 2
fi
if [[ "$do_clear" -eq 0 && -z "$new_host" ]]; then
  echo "set-hub: no hostname given." >&2
  usage
  exit 2
fi

# Reject client-side what the firmware would reject anyway, with a better message.
if [[ "$do_clear" -eq 0 ]]; then
  case "$new_host" in
    *://*|*/*|*" "*)
      echo "set-hub: '$new_host' must be a bare hostname — no scheme, no path." >&2
      echo "  e.g. poem1-hub.example.workers.dev" >&2
      exit 2 ;;
  esac
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "set-hub: error: 'jq' not found. Install with: brew install jq" >&2
  exit 2
fi

if [[ -z "$device_id" && -f .resident-device-id ]]; then
  device_id=$(tr -d '[:space:]' < .resident-device-id)
fi
if [[ -z "$device_id" ]]; then
  echo "set-hub: device ID required (--device-id, \$RESIDENT_DEVICE_ID, or .resident-device-id)." >&2
  exit 2
fi

# Where to SEND: the hub the device is on now.
if [[ -z "$base_url" ]]; then base_url="${RESIDENT_BASE_URL:-}"; fi
if [[ -z "$base_url" && -f .resident-hub-url ]]; then
  base_url=$(tr -d '[:space:]' < .resident-hub-url)
fi
if [[ -z "$base_url" ]]; then base_url="$PROD_URL"; fi
base_url="${base_url%/}"

# Where it should END UP.
if [[ "$do_clear" -eq 1 ]]; then
  target_host="$DEFAULT_HUB_HOST"
  payload=$(jq -n '{type: "set_hub", host: ""}')
else
  target_host="$new_host"
  payload=$(jq -n --arg h "$new_host" '{type: "set_hub", host: $h}')
fi
target_url="https://${target_host}"

echo "Current hub: $base_url" >&2
echo "Destination: $target_url" >&2

# Connection count at a hub, or empty if it can't be read.
hub_conn_count() {
  curl -sS -m 5 "$1/devices/${device_id}" 2>/dev/null \
    | sed -n 's/^connections: \([0-9][0-9]*\).*/\1/p' | head -1
}

# Baseline BEFORE the switch, so we can wait for a rise rather than trust a
# non-zero count (which may just be a hibernating connection from a past boot).
baseline=$(hub_conn_count "$target_url")
baseline=${baseline:-0}
echo "Destination currently reports $baseline connection(s); waiting for that to rise." >&2

http_code=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  --data-binary "$payload" \
  "${base_url}/devices/${device_id}/send")

case "$http_code" in
  200) echo "Sent. Waiting for the device to appear on the destination..." >&2 ;;
  503) echo "set-hub: device not connected to $base_url — is it on a different hub already?" >&2
       exit 1 ;;
  *)   echo "set-hub: HTTP $http_code from $base_url" >&2; exit 3 ;;
esac

# Confirm by watching the destination, since the device cannot ack.
deadline=$(( $(date +%s) + CONNECT_TIMEOUT_SECS ))
while [[ $(date +%s) -lt $deadline ]]; do
  now_count=$(hub_conn_count "$target_url")
  now_count=${now_count:-0}
  if [[ "$now_count" -gt "$baseline" ]]; then
    echo "Device appeared on ${target_host} (connections ${baseline} -> ${now_count})." >&2
    if [[ "$do_clear" -eq 1 ]]; then
      rm -f .resident-hub-url
      echo "Removed .resident-hub-url; pushes now default to the public relay." >&2
    else
      printf '%s\n' "$target_url" > .resident-hub-url
      echo "Wrote .resident-hub-url — send-app.sh will follow it there." >&2
    fi
    exit 0
  fi
  sleep 3
done

echo >&2
echo "set-hub: device did not appear on ${target_host} within ${CONNECT_TIMEOUT_SECS}s." >&2
echo "  .resident-hub-url was NOT changed." >&2
echo "  The device falls back to ${DEFAULT_HUB_HOST} for the rest of this boot if it" >&2
echo "  cannot reach the new hub, so try: ./set-hub.sh --base-url $PROD_URL --clear" >&2
exit 1
