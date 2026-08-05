#!/usr/bin/env bash
#
# test-federation.sh — Prove the federated push path end to end, in one command.
#
#   sender's hub  ──signed HTTPS──▶  recipient's hub  ──WSS──▶  recipient's device
#
# This is the most important path in the project and structurally the least
# testable one: it needs multiple atproto identities, deployed hubs, real follow
# relationships, and a physical device. That cost is inherent to the design, not
# a bug — but paying it by hand every time is a bug, and it went untested for two
# release cycles because of it. Hence this script.
#
#   ./test-federation.sh              # run every case that is configured
#   ./test-federation.sh --list       # what the cases are and what they need
#   ./test-federation.sh --only mutual-push
#   ./test-federation.sh -v           # show full JSON for each case
#
# ── WHY THE NEGATIVE CASES MATTER MOST ───────────────────────────────────────
# The positive case proves the machinery runs. The negative cases prove it says
# NO — which is the entire security claim. "Mutuals may push code to your
# device" is only meaningful if non-mutuals demonstrably cannot, and a push path
# that accepts everything passes the positive test perfectly.
#
# The load-bearing one is `recipient-enforces`. The sender's mutual check is
# advisory — a courtesy so the common failure is a good local message instead of
# a remote 403 — and a hostile sender simply would not run it. Only the
# RECIPIENT's check is enforcement. So that case pushes with `force`, which
# skips the sender's check on purpose, to make the recipient answer for itself.
# If it ever passes, the recipient is trusting the sender's word about the
# social graph, and the whole trust model is decorative.
#
# ── WHAT A PASS ACTUALLY MEANS ───────────────────────────────────────────────
# `mutual-push` asserts on `response.delivered` — the RECIPIENT's report about
# its own device — not on the relay's 200, which only means "accepted for
# delivery". It then goes one further and asserts the device COMPILED it, by
# reading the runtime's own `app_compiled` telemetry back off the owner's
# /hub/device/events.
#
# That last step used to be impossible from here: delivery was as far as the
# suite could see, and "did the Lua actually run" needed a human watching the
# panel or a serial tap. The device return path closed that, so the strongest
# claim this script can make no longer requires anyone to be in the room.
#
# It needs an owner token for the RECIPIENT hub (not just the sender's), and a
# device on firmware that forwards telemetry. Without the token the case still
# passes on delivery alone and says the compile went unverified — an honest
# weaker claim rather than a silent one.
#
# ── CREDENTIALS ──────────────────────────────────────────────────────────────
# Only SENDERS need one; a recipient's /federation/inbox takes no owner
# credential at all — it is authenticated by signature + mutual follow, and
# requiring one there would make federation impossible (server/src/auth.ts).
#
# Cloudflare secrets are WRITE-ONLY: `wrangler secret list` shows that
# HUB_ADMIN_TOKEN exists, never its value. A token you did not record is gone.
# So record it ONCE, in the keychain, instead of rotating it every run:
#
#   W=poem1-hub-haha
#   TOKEN="$(openssl rand -hex 32)"
#   security add-generic-password -a "$W" -s poem1-hub-admin -w "$TOKEN"
#   printf '%s' "$TOKEN" | (cd server && npx wrangler secret put HUB_ADMIN_TOKEN --name "$W")
#
# This script looks each hub's token up by worker name, so adding a hub is
# adding a keychain entry. You do NOT need an OAuth browser session to run any
# of this — OAuth is only for CLAIMING a hub and publishing its record, which is
# a one-time act per identity.
#
# Requires: curl, jq.

set -euo pipefail

# ── The cast ─────────────────────────────────────────────────────────────────
# Three identities with deliberately different relationships to the device
# owner, because one mutual proves nothing on its own:
#
#   mfd.is                    owns the DEVICE. The recipient in every case.
#   hahacomputer.bsky.social  MUTUAL with mfd.is  -> may push.
#   idiot.town                follows mfd.is, NOT followed back -> may not.
#
# idiot.town is the interesting one. A follower is not a mutual, and it is the
# relationship most likely to be got wrong by a sloppy graph check: it looks
# like a connection, and `followedBy: true` is exactly what a naive
# implementation would accept.
OWNER_HANDLE="${POEM1_OWNER_HANDLE:-mfd.is}"

OWNER_HUB="${POEM1_OWNER_HUB:-https://poem1-hub.service-cloudflare-442.workers.dev}"
OWNER_WORKER="${POEM1_OWNER_WORKER:-poem1-hub}"

MUTUAL_HUB="${POEM1_MUTUAL_HUB:-https://poem1-hub-haha.service-cloudflare-442.workers.dev}"
MUTUAL_WORKER="${POEM1_MUTUAL_WORKER:-poem1-hub-haha}"

# The non-mutual sender. Unset/undeployed until someone stands it up, so the
# cases that need it SKIP loudly rather than silently not running.
STRANGER_HANDLE="${POEM1_STRANGER_HANDLE:-idiot.town}"
STRANGER_HUB="${POEM1_STRANGER_HUB:-https://poem1-hub-idiot.service-cloudflare-442.workers.dev}"
STRANGER_WORKER="${POEM1_STRANGER_WORKER:-poem1-hub-idiot}"

# A handle that cannot resolve, for the discovery-failure case. Deliberately
# .invalid (RFC 2606) so it can never start resolving and quietly stop testing
# what it claims to.
NXDOMAIN_HANDLE="poem1-federation-test.invalid"

APP_FILE="${POEM1_TEST_APP:-device-apps/federated-hello.lua}"
KEYCHAIN_SERVICE="poem1-hub-admin"

only=""
verbose=0

# Every case name, so --only can reject a typo instead of matching nothing and
# reporting a green "passed 0". Keep in step with the `wanted` calls below.
CASES="mutual-push bad-token unknown-handle sender-warns recipient-enforces"

usage() {
  sed -n '2,60p' "$0" >&2
  exit 0
}

list_cases() {
  cat <<EOF
Cases, in the order they run:

  mutual-push          POSITIVE. $MUTUAL_HUB
                       -> $OWNER_HANDLE, expect delivered AND compiled on the
                       device (read back from its own telemetry).
                       Needs: keychain token for $MUTUAL_WORKER, device online.
                       Also a token for $OWNER_WORKER to check the compile —
                       without it the case passes on delivery alone and says so.

  bad-token            The sender rejects a wrong owner credential (401/403).
                       Needs: nothing.

  unknown-handle       Discovery fails cleanly for a handle that cannot resolve.
                       Needs: keychain token for $MUTUAL_WORKER.

  sender-warns         The SENDER's advisory check refuses a non-mutual (403
                       not_mutual) before anything leaves the hub.
                       Needs: token for $OWNER_WORKER, and $STRANGER_HANDLE
                       publishing a hub record.

  recipient-enforces   THE IMPORTANT ONE. $STRANGER_HANDLE pushes to
                       $OWNER_HANDLE with force, skipping its own check, and the
                       RECIPIENT must refuse it (403).
                       Needs: token for $STRANGER_WORKER, hub claimed by
                       $STRANGER_HANDLE.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)    only="$2"; shift 2 ;;
    --list)    list_cases ;;
    -v|--verbose) verbose=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$only" ]] && [[ " $CASES " != *" $only "* ]]; then
  echo "test-federation: no such case '$only'." >&2
  echo "  Known cases: $CASES" >&2
  exit 2
fi

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "test-federation: error: '$tool' not found. brew install $tool" >&2; exit 2; }
done
[[ -f "$APP_FILE" ]] || { echo "test-federation: error: no $APP_FILE" >&2; exit 2; }

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

passes=0; fails=0; skips=0

# Tokens are looked up by WORKER name, so each hub's credential is independent —
# a hub you have not set up yields an empty token and its cases skip, rather
# than failing in a way that looks like a broken push path.
token_for() {
  local var_name token
  var_name="POEM1_TOKEN_$(echo "$1" | tr 'a-z-' 'A-Z_')"
  token="${!var_name:-}"
  if [[ -z "$token" ]] && command -v security >/dev/null 2>&1; then
    token=$(security find-generic-password -a "$1" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
  fi
  printf '%s' "$token"
}

# Returns the HTTP status; response body lands in $BODY.
push() {  # hub token to force
  local hub="$1" token="$2" to="$3" force="$4" payload
  payload=$(jq -n --arg to "$to" --arg code "$(cat "$APP_FILE")" --argjson f "$force" \
    '{to: $to, code: $code} + (if $f == 1 then {force: true} else {} end)')
  curl -sS -o "$BODY" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    --data-binary "$payload" --max-time 60 "${hub%/}/federation/push"
}

# Highest event seq a hub has recorded from its device. Empty — NOT 0 — when the
# endpoint can't be used at all (no token, hub not running this code, no device
# configured), because "no events yet" and "cannot look" must not be confused:
# the first is a valid baseline of 0, the second means don't assert on compiles.
latest_seq() {  # hub token
  local hub="$1" token="$2"
  [[ -z "$token" ]] && return 0
  curl -sS -m 8 -H "Authorization: Bearer $token" \
    "${hub%/}/hub/device/events?limit=1" 2>/dev/null \
    | jq -r 'if .events then ((.events[0].seq) // 0) else empty end' 2>/dev/null
}

# The device's own verdict on the app it was just handed.
# Prints: "compiled", "error:<lua message>", or "unknown" on timeout.
#
# Takes the EARLIEST matching event after the baseline, not the latest: a push
# that fails to compile and a later one that succeeds must not be allowed to
# overwrite each other's verdict.
compile_verdict() {  # hub token since
  local hub="$1" token="$2" since="$3" deadline v
  deadline=$(( $(date +%s) + 25 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    v=$(curl -sS -m 8 -H "Authorization: Bearer $token" \
          "${hub%/}/hub/device/events?limit=25" 2>/dev/null \
        | jq -r --argjson s "$since" '
            (.events // [])
            | map(select(.seq > $s
                         and (.name == "app_compiled" or .name == "compile_error")))
            | sort_by(.seq) | .[0]
            | if . == null then empty
              elif .name == "app_compiled" then "compiled"
              else "error:" + (((.body | fromjson).data.error) // "?")
              end' 2>/dev/null)
    [[ -n "$v" ]] && { printf '%s' "$v"; return 0; }
    sleep 2
  done
  printf 'unknown'
}

report() {  # verdict name detail
  case "$1" in
    PASS) passes=$((passes+1)); printf '  \033[32mPASS\033[0m  %-20s %s\n' "$2" "$3" ;;
    FAIL) fails=$((fails+1));   printf '  \033[31mFAIL\033[0m  %-20s %s\n' "$2" "$3" ;;
    SKIP) skips=$((skips+1));   printf '  \033[33mSKIP\033[0m  %-20s %s\n' "$2" "$3" ;;
  esac
  [[ "$verbose" -eq 1 && -s "$BODY" ]] && { jq . < "$BODY" 2>/dev/null | sed 's/^/        /'; } || true
}

wanted() { [[ -z "$only" || "$only" == "$1" ]]; }

# Reads a field from either the sender's own error envelope or the recipient's
# nested one, since the same logical refusal surfaces in both shapes depending
# on which hub did the refusing.
err_of() { jq -r '.response.error // .error // ""' < "$BODY" 2>/dev/null; }

echo "Federation suite — device owner: $OWNER_HANDLE"
echo

# ── 1. The happy path ────────────────────────────────────────────────────────
if wanted mutual-push; then
  tok=$(token_for "$MUTUAL_WORKER")
  if [[ -z "$tok" ]]; then
    report SKIP mutual-push "no token for $MUTUAL_WORKER (see header)"
  else
    # Baseline BEFORE the push, so the compile verdict below can only be about
    # THIS app and not something the device reported earlier.
    owner_tok=$(token_for "$OWNER_WORKER")
    seq_before=$(latest_seq "$OWNER_HUB" "$owner_tok")

    code=$(push "$MUTUAL_HUB" "$tok" "$OWNER_HANDLE" 0)
    ok=$(jq -r '.ok // false' < "$BODY"); delivered=$(jq -r '.response.delivered // false' < "$BODY")
    if [[ "$code" == "200" && "$ok" == "true" && "$delivered" == "true" ]]; then
      if [[ -z "$seq_before" ]]; then
        report PASS mutual-push "delivered to device (compile UNVERIFIED — no token for $OWNER_WORKER)"
      else
        # Once — it polls, so a second call would re-wait and could disagree.
        verdict=$(compile_verdict "$OWNER_HUB" "$owner_tok" "$seq_before")
        case "$verdict" in
          compiled)
            report PASS mutual-push "signed, verified, mutual-checked, compiled ON the device" ;;
          error:*)
            report FAIL mutual-push "delivered but FAILED to compile: ${verdict#error:}" ;;
          *)
            # Delivered, but the device never said what it made of it. Most
            # likely firmware predating telemetry forwarding — which is a real
            # gap in the claim, not a detail, so it does not pass quietly.
            report FAIL mutual-push "delivered but device never reported compiling it (firmware too old? reflash)" ;;
        esac
      fi
    elif [[ "$ok" == "true" ]]; then
      # Hubs agreed, device did not answer. Usually a deploy just restarted the
      # Durable Object and dropped the socket; it reconnects in seconds.
      report FAIL mutual-push "hubs OK but device unreachable — just deployed? retry"
    else
      report FAIL mutual-push "HTTP $code, error=$(err_of)"
    fi
  fi
fi

# ── 2. A wrong credential is refused ─────────────────────────────────────────
# Cheap, but it guards a real hole: without requireOwner, anyone knowing the hub
# URL could make it push to every one of its owner's mutuals, signed as them.
# Hub URLs are published in atproto repos, so they are public by design.
if wanted bad-token; then
  code=$(push "$MUTUAL_HUB" "not-the-real-token" "$OWNER_HANDLE" 0)
  if [[ "$code" == "401" || "$code" == "403" ]]; then
    report PASS bad-token "sender refused a bad owner credential ($code)"
  else
    report FAIL bad-token "expected 401/403, got $code"
  fi
fi

# ── 3. Discovery fails cleanly ───────────────────────────────────────────────
if wanted unknown-handle; then
  tok=$(token_for "$MUTUAL_WORKER")
  if [[ -z "$tok" ]]; then
    report SKIP unknown-handle "no token for $MUTUAL_WORKER"
  else
    code=$(push "$MUTUAL_HUB" "$tok" "$NXDOMAIN_HANDLE" 0)
    e=$(err_of)
    if [[ "$code" != "200" && ( "$e" == "identity_error" || "$e" == "no_hub" ) ]]; then
      report PASS unknown-handle "unresolvable handle rejected ($e, $code)"
    else
      report FAIL unknown-handle "expected identity_error/no_hub, got '$e' ($code)"
    fi
  fi
fi

# ── 4. The sender's advisory check ───────────────────────────────────────────
if wanted sender-warns; then
  tok=$(token_for "$OWNER_WORKER")
  has_hub=$(curl -s -m 20 "${OWNER_HUB%/}/hub/peer/$STRANGER_HANDLE" | jq -r '.found // false')
  if [[ -z "$tok" ]]; then
    report SKIP sender-warns "no token for $OWNER_WORKER"
  elif [[ "$has_hub" != "true" ]]; then
    report SKIP sender-warns "$STRANGER_HANDLE publishes no hub record yet"
  else
    code=$(push "$OWNER_HUB" "$tok" "$STRANGER_HANDLE" 0)
    if [[ "$code" == "403" && "$(err_of)" == "not_mutual" ]]; then
      report PASS sender-warns "sender refused a non-mutual before sending"
    else
      report FAIL sender-warns "expected 403 not_mutual, got $code / $(err_of)"
    fi
  fi
fi

# ── 5. The recipient enforces, independently ─────────────────────────────────
# force:true skips the SENDER's advisory check on purpose. What is left is the
# recipient's own answer, which is the only one that was ever enforcement. A
# hostile sender would not run the courtesy check either — this simulates that
# without needing a hostile sender.
if wanted recipient-enforces; then
  tok=$(token_for "$STRANGER_WORKER")
  if [[ -z "$tok" ]]; then
    report SKIP recipient-enforces "no token for $STRANGER_WORKER — hub not set up"
  else
    code=$(push "$STRANGER_HUB" "$tok" "$OWNER_HANDLE" 1)
    status=$(jq -r '.status // 0' < "$BODY")
    delivered=$(jq -r '.response.delivered // false' < "$BODY")
    reason=$(jq -r '.response.message // ""' < "$BODY")
    if [[ "$delivered" == "true" ]]; then
      report FAIL recipient-enforces "A NON-MUTUAL REACHED THE DEVICE — trust model broken"
    elif [[ "$status" != "403" ]]; then
      report FAIL recipient-enforces "expected recipient 403, got status=$status code=$code"
    elif [[ "$reason" != *"not a mutual"* ]]; then
      # 403 alone is NOT enough. verifyInbound also throws 403 for an unverifiable
      # signature or a missing hub record, so a broken signing path would sail
      # through a status-only assertion looking exactly like enforcement working.
      # That would be the worst possible false pass: the suite would report the
      # graph check holding while the graph check was never reached. Insist the
      # refusal names the relationship.
      report FAIL recipient-enforces "403 but not the mutual check — reason: $reason"
    else
      report PASS recipient-enforces "recipient refused a non-mutual: ${reason#*— }"
    fi
  fi
fi

echo
echo "passed $passes, failed $fails, skipped $skips"
[[ "$skips" -gt 0 && "$fails" -eq 0 ]] && \
  echo "(skips are unconfigured hubs, not passes — see ./test-federation.sh --list)"

[[ "$fails" -eq 0 ]] || exit 1

# Nothing passing is a FAILURE, not a success.
#
# Exiting 0 here was the suite's own worst bug: `passed 0, failed 0, skipped 5`
# is what you get from a locked keychain, a missing `security`, or hubs nobody
# has configured — an environment where NOTHING was tested — and it exited green,
# indistinguishable from a clean run. A gate whose most common broken state
# reports success is worse than no gate, because it is trusted.
#
# Skips stay non-fatal on purpose (an unconfigured third hub should not look like
# a broken push path), so the condition is "did anything actually pass", not
# "did anything skip".
if [[ "$passes" -eq 0 ]]; then
  echo >&2
  echo "test-federation: NOTHING RAN — 0 cases passed. This is not a pass." >&2
  echo "  Usually: locked keychain, no tokens, or unconfigured hubs." >&2
  echo "  See ./test-federation.sh --list for what each case needs." >&2
  exit 1
fi
