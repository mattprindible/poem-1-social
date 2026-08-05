#!/usr/bin/env bash
#
# set-hub.sh — Point a device at a different hub, over the air.
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
# Success is confirmed by the DEVICE'S OWN WORD where that is possible.
#
# On every (re)connect the firmware sends {"type":"hello","host":…} naming the
# hub it believes it reached. A hello that arrives AT the destination and NAMES
# the destination is proof: the device is the only party that knows where it
# actually landed, and a stale hello from a previous hub names the previous hub,
# so it cannot be mistaken for a fresh arrival. We read it from the destination's
# /hub/device/events, and compare against a pre-send `seq` rather than a clock,
# so nothing depends on this machine and Cloudflare agreeing about the time.
#
# That needs an owner token for the DESTINATION hub, and a destination that runs
# this project's hub code. Neither holds when moving to the public relay, or to
# a hub you don't own, so the old heuristic remains as a FALLBACK: watch the
# destination's connection count and wait for it to RISE.
#
# The fallback is weaker and the script says so when it uses it. It waits for a
# rise rather than a non-zero count because Durable Objects hold on to
# hibernating WebSockets from previous boots — a hub the device left hours ago
# can still report "connections: 1", which produced a confident false positive
# during testing. A baseline narrows that without closing it: a stale entry
# reaped just as the device arrives still reads as failure.
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
      echo "  e.g. my-hub.example.workers.dev" >&2
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
  # channel:"system" — control plane (0.7.0+). Unlike "app", set_hub is NOT a
  # reserved type, so it reaches the device via the "system" channel slot that
  # device/src/main.cpp registers. A device flashed before that registration
  # existed will DROP this; it still accepts the un-channelled form.
  payload=$(jq -n '{channel: "system", type: "set_hub", host: ""}')
else
  target_host="$new_host"
  payload=$(jq -n --arg h "$new_host" '{channel: "system", type: "set_hub", host: $h}')
fi
target_url="https://${target_host}"

echo "Current hub: $base_url" >&2
echo "Destination: $target_url" >&2

# Connection count at a hub, or empty if it can't be read.
hub_conn_count() {
  curl -sS -m 5 "$1/devices/${device_id}" 2>/dev/null \
    | sed -n 's/^connections: \([0-9][0-9]*\).*/\1/p' | head -1
}

# An owner token for a destination hub, if this machine has one. Same convention
# as test-federation.sh: keychain service "poem1-hub-admin", account = the
# worker name, which is the first label of the hostname.
token_for_hub() {
  local host="$1" token
  token="${HUB_ADMIN_TOKEN:-}"
  if [[ -z "$token" ]] && command -v security >/dev/null 2>&1; then
    token=$(security find-generic-password -a "${host%%.*}" \
      -s "poem1-hub-admin" -w 2>/dev/null || true)
  fi
  printf '%s' "$token"
}

# Highest recorded event seq at a hub. Empty (not 0) when the endpoint can't be
# used at all — no token, not our hub code, or no device configured there — which
# is what selects the fallback below. Empty and 0 mean different things here.
hub_latest_seq() {
  local url="$1" token="$2"
  [[ -z "$token" ]] && return 0
  curl -sS -m 8 -H "Authorization: Bearer $token" \
    "$url/hub/device/events?limit=1" 2>/dev/null \
    | jq -r 'if .events then ((.events[0].seq) // 0) else empty end' 2>/dev/null
}

# The host named by the first hello recorded after $2. Empty if there isn't one.
hub_hello_host_after() {
  local url="$1" since="$2" token="$3"
  curl -sS -m 8 -H "Authorization: Bearer $token" \
    "$url/hub/device/events?limit=25" 2>/dev/null \
    | jq -r --argjson s "$since" '
        (.events // [])
        | map(select(.seq > $s and .type == "hello"))
        | map(.body | fromjson | .host // empty)
        | .[0] // empty' 2>/dev/null
}

# Prefer the device's own report; fall back to counting connections.
dest_token=$(token_for_hub "$target_host")
baseline_seq=$(hub_latest_seq "$target_url" "$dest_token")

if [[ -n "$baseline_seq" ]]; then
  confirm_mode="hello"
  echo "Confirming by the device's own hello at $target_host (seq > $baseline_seq)." >&2
else
  confirm_mode="count"
  baseline=$(hub_conn_count "$target_url")
  baseline=${baseline:-0}
  echo "No owner token for $target_host (or it isn't running this hub's code)." >&2
  echo "Falling back to connection counts: currently $baseline, waiting for a rise." >&2
  echo "  NOTE: weaker than the device's own report — hibernating sockets can" >&2
  echo "  make a departed device still look present. Confirm on the panel." >&2
fi

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

# Record the move locally. Only ever called once arrival is confirmed, so a
# failed switch never leaves send-app.sh pointing somewhere the device isn't.
record_move() {
  if [[ "$do_clear" -eq 1 ]]; then
    rm -f .resident-hub-url
    echo "Removed .resident-hub-url; pushes now default to the public relay." >&2
  else
    printf '%s\n' "$target_url" > .resident-hub-url
    echo "Wrote .resident-hub-url — send-app.sh will follow it there." >&2
  fi
}

deadline=$(( $(date +%s) + CONNECT_TIMEOUT_SECS ))
while [[ $(date +%s) -lt $deadline ]]; do
  if [[ "$confirm_mode" == "hello" ]]; then
    said=$(hub_hello_host_after "$target_url" "$baseline_seq" "$dest_token")
    if [[ -n "$said" ]]; then
      if [[ "$said" == "$target_host" ]]; then
        echo "Device announced itself on ${target_host}, and named it: \"$said\"." >&2
        record_move
        exit 0
      fi
      # It arrived and reported a DIFFERENT hub than the one hosting this
      # endpoint. Don't record the move on a report that disagrees with itself.
      echo "set-hub: device connected to ${target_host} but reported host \"$said\"." >&2
      echo "  Refusing to record the move — that disagreement needs a look." >&2
      exit 1
    fi
  else
    now_count=$(hub_conn_count "$target_url")
    now_count=${now_count:-0}
    if [[ "$now_count" -gt "$baseline" ]]; then
      echo "Device appeared on ${target_host} (connections ${baseline} -> ${now_count})." >&2
      echo "  (Inferred from connection counts, not the device's own word.)" >&2
      record_move
      exit 0
    fi
  fi
  sleep 3
done

echo >&2
echo "set-hub: device did not appear on ${target_host} within ${CONNECT_TIMEOUT_SECS}s." >&2
echo "  .resident-hub-url was NOT changed." >&2
echo "  The device falls back to ${DEFAULT_HUB_HOST} for the rest of this boot if it" >&2
echo "  cannot reach the new hub, so try: ./set-hub.sh --base-url $PROD_URL --clear" >&2
exit 1
