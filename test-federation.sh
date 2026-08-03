#!/usr/bin/env bash
#
# test-federation.sh — Prove the federated push path end to end, in one command.
#
#   sender's hub  ──signed HTTPS──▶  recipient's hub  ──WSS──▶  recipient's device
#
# This is the most important path in the project and structurally the least
# testable one: it needs two atproto identities, two deployed hubs, a live mutual
# follow, and a physical device. That cost is inherent to the design, not a bug —
# but paying it by hand every time is a bug, and it went untested for two release
# cycles because of it. Hence this script.
#
#   ./test-federation.sh                      # push federated-hello.lua
#   ./test-federation.sh device-apps/foo.lua  # push something else
#   ./test-federation.sh --force              # skip the sender's advisory mutual check
#
# WHAT IT ACTUALLY PROVES, in order — each step can only pass if every earlier
# one did, which is why a single 200 at the end is meaningful:
#
#   1. the sender hub accepts an owner credential            (requireOwner)
#   2. it resolves the recipient handle -> DID -> PDS -> hub record  (discovery)
#   3. it signs with the key it publishes in its own repo     (signOutbound)
#   4. the recipient verifies that signature against the repo  (verifyInbound)
#   5. the recipient confirms a mutual follow on the live graph (requireMutual)
#   6. the recipient hands the app to its device              (deliverAppToDevice)
#   7. the device is connected and accepts it                 (delivered: true)
#
# Step 7 reports the DEVICE's answer, not the relay's. A bare relay 200 is
# hollow — it means "accepted for delivery", not "the device ran it". To confirm
# the Lua actually compiled you still need eyes on the panel or a serial tap:
#   uv run --with pyserial python3 tap.py /dev/cu.usbmodem101 30
# (DTR asserted, RTS not — see the flash-safety notes in sync.sh.)
#
# ── THE CREDENTIAL ───────────────────────────────────────────────────────────
# Only the SENDER needs one. The recipient's /federation/inbox takes no owner
# credential at all — it is authenticated by signature + mutual follow, and
# requiring one there would make federation impossible (see server/src/auth.ts).
#
# Cloudflare secrets are WRITE-ONLY: `wrangler secret list` shows that
# HUB_ADMIN_TOKEN exists but never its value. So a token you did not record is
# gone, and the only fix is to replace it. Do that ONCE and keep it in the
# keychain rather than rotating it every time you want to run this:
#
#   TOKEN="$(openssl rand -hex 32)"
#   security add-generic-password -a poem1-hub-haha -s poem1-hub-admin -w "$TOKEN"
#   printf '%s' "$TOKEN" | (cd server && npx wrangler secret put HUB_ADMIN_TOKEN --name poem1-hub-haha)
#
# You do NOT need an OAuth browser session for this. OAuth exists to claim a hub
# and publish its record; both are long done. Bearer auth is the supported path
# for automation, which is exactly what this is.
#
# Requires: curl, jq. Reads the token from --token, then $HUB_ADMIN_TOKEN, then
# the macOS keychain.

set -euo pipefail

# This project's test pair. Both are public by construction — the sender's hub
# URL is published in its atproto record, and the recipient is a handle — so
# there is nothing secret here to keep out of the repo.
SENDER_HUB="${POEM1_TEST_SENDER_HUB:-https://poem1-hub-haha.service-cloudflare-442.workers.dev}"
RECIPIENT="${POEM1_TEST_RECIPIENT:-mfd.is}"
KEYCHAIN_ACCOUNT="poem1-hub-haha"
KEYCHAIN_SERVICE="poem1-hub-admin"

app_file="device-apps/federated-hello.lua"
token="${HUB_ADMIN_TOKEN:-}"
force=0

usage() {
  cat <<EOF >&2
Usage: $0 [--from URL] [--to HANDLE] [--token TOKEN] [--force] [APP_FILE]

Defaults:
  --from    \$POEM1_TEST_SENDER_HUB, then $SENDER_HUB
  --to      \$POEM1_TEST_RECIPIENT, then $RECIPIENT
  --token   \$HUB_ADMIN_TOKEN, then macOS keychain ($KEYCHAIN_SERVICE)
  APP_FILE  $app_file

Flags:
  --force   Skip the SENDER's advisory mutual check. Cannot grant access — the
            recipient enforces independently — so this is how you observe that
            enforcement rather than having it masked by the local check.
  -h, --help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)  SENDER_HUB="$2"; shift 2 ;;
    --to)    RECIPIENT="$2"; shift 2 ;;
    --token) token="$2"; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)      echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *)       app_file="$1"; shift ;;
  esac
done

SENDER_HUB="${SENDER_HUB%/}"

for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "test-federation: error: '$tool' not found. Install with: brew install $tool" >&2
    exit 2
  fi
done

if [[ ! -f "$app_file" ]]; then
  echo "test-federation: error: file not found: $app_file" >&2
  exit 2
fi

# Keychain is the last resort so an explicit flag or env var always wins, and so
# this still works on a non-macOS host that exports HUB_ADMIN_TOKEN.
if [[ -z "$token" ]] && command -v security >/dev/null 2>&1; then
  token=$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
fi

if [[ -z "$token" ]]; then
  echo "test-federation: error: no owner credential for the sender hub." >&2
  echo "  The value cannot be read back out of Cloudflare, so if you never" >&2
  echo "  recorded it you must set a new one. See the header of this script." >&2
  exit 2
fi

echo "==> $RECIPIENT  <--  $SENDER_HUB" >&2
echo "    app: $app_file" >&2
[[ "$force" -eq 1 ]] && echo "    force: skipping the sender's advisory mutual check" >&2

payload=$(jq -n \
  --arg to "$RECIPIENT" \
  --arg code "$(cat "$app_file")" \
  --argjson force "$force" \
  '{to: $to, code: $code} + (if $force == 1 then {force: true} else {} end)')

tmp_body=$(mktemp)
trap 'rm -f "$tmp_body"' EXIT

http_code=$(curl -sS -o "$tmp_body" -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  --data-binary "$payload" \
  --max-time 60 \
  "${SENDER_HUB}/federation/push")

# `ok` is the sender's view of the recipient's HTTP status; `response.delivered`
# is the recipient's view of its own device. Both must be true — the first can
# be true while the second is false when the hub is fine but the device dropped
# its socket, which is the single most common way this "passes" while nothing
# reached the panel.
ok=$(jq -r '.ok // false' < "$tmp_body")
delivered=$(jq -r '.response.delivered // false' < "$tmp_body")

if [[ "$http_code" == "200" && "$ok" == "true" && "$delivered" == "true" ]]; then
  echo >&2
  jq . < "$tmp_body"
  echo >&2
  echo "PASS — signed, verified, mutual-checked, and delivered to the device." >&2
  echo "       Relay accepted != Lua compiled: confirm on the panel or serial." >&2
  exit 0
fi

echo >&2
jq . < "$tmp_body" 2>/dev/null || cat "$tmp_body" >&2
echo >&2
echo "FAIL — HTTP $http_code, ok=$ok, delivered=$delivered" >&2

# The failures worth naming, because each has a different and non-obvious fix.
case "$(jq -r '.response.error // .error // ""' < "$tmp_body" 2>/dev/null)" in
  unauthorized)
    echo "  The SENDER rejected your credential. Set a token you keep — see the" >&2
    echo "  header of this script." >&2 ;;
  not_mutual)
    echo "  The two accounts are not mutuals. Re-follow, or use --force to make" >&2
    echo "  the RECIPIENT's independent check the thing under test." >&2 ;;
  no_hub)
    echo "  $RECIPIENT publishes no hub record. Check GET \$HUB/hub/record." >&2 ;;
  no_device)
    echo "  The recipient hub has no device configured (POST /hub/device)." >&2 ;;
  federation_error)
    echo "  Signature or graph check failed at the recipient. If the sender's key" >&2
    echo "  was rotated, its published record must be updated to match." >&2 ;;
esac

# A deploy restarts Durable Objects and drops device WebSockets, so the first
# push after one can legitimately report a disconnected device. Retry beats
# debugging here.
if [[ "$delivered" != "true" && "$ok" == "true" ]]; then
  echo "  The hubs agreed; only the device was unreachable. If you just deployed," >&2
  echo "  wait a few seconds for it to reconnect and run this again." >&2
fi

exit 1
