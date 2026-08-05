#!/usr/bin/env bash
#
# test-federation.sh — Prove the whole trust chain end to end, in one command.
#
#   sender's hub  ──signed HTTPS──▶  recipient's hub  ──WSS──▶  recipient's device
#
# It began as a test of the federated push and now covers every link in that
# chain, because each one is only worth anything if the others hold:
#
#   the device is that device      device-identity  (a key it proves per connection)
#   the hub is its owner's         relay-closed     (claimed devices, owner-only push)
#   the peer is who they claim     mutual-push      (signature vs the key in their repo)
#   they are allowed to push       recipient-enforces (mutual follow, recipient decides)
#   what they can push to          discovery        (asked live, never remembered)
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
#   W=idiot-hub
#   TOKEN="$(openssl rand -hex 32)"
#   security add-generic-password -a "$W" -s poem1-hub-admin -w "$TOKEN"
#   printf '%s' "$TOKEN" | (cd server && npx wrangler secret put HUB_ADMIN_TOKEN --name "$W")
#
# This script looks each hub's token up by worker name, so adding a hub is
# adding a keychain entry. A token is enough for every case EXCEPT `record-push`,
# which publishes an app into the sender's repo and so needs that hub to still
# hold a live OAuth session. Sessions lapse; that case skips when it has, rather
# than reporting a federation failure for a login problem.
#
# Requires: curl, jq.

set -euo pipefail

# ── The cast ─────────────────────────────────────────────────────────────────
# Three identities with deliberately different relationships to the device
# owner, because one mutual proves nothing on its own:
#
#   mfd.is                   owns the DEVICE. The recipient in every case.
#   idiot.town               MUTUAL with mfd.is  -> may push.
#   noitsrusty.bsky.social   follows mfd.is, NOT followed back -> may not.
#
# The non-mutual is the interesting one. A follower is not a mutual, and it is
# the relationship most likely to be got wrong by a sloppy graph check: it looks
# like a connection, and `followedBy: true` is exactly what a naive
# implementation would accept.
#
# Rusty exists ONLY to be refused. That is a real fixture, not a spare account:
# the negative cases are the whole security claim, and they need a sender holding
# the awkward relationship on purpose and permanently. Do not "tidy up" by
# following it back — that silently converts the load-bearing refusal test into
# a second copy of the positive one.
#
# It needs a hub of its own even though it never succeeds, because
# /federation/push resolves the recipient's hub record BEFORE the mutual check —
# a sender with no hub record fails at `no_hub` and never exercises the graph
# logic the case exists to test.
#
# Note who is NOT here: san.haha.computer is the lexicon AUTHORITY and holds no
# follows in either direction. It briefly stood in as this fixture and should
# not again — the authority is not a participant.
OWNER_HANDLE="${POEM1_OWNER_HANDLE:-mfd.is}"

OWNER_HUB="${POEM1_OWNER_HUB:-https://mfd-hub.service-cloudflare-442.workers.dev}"
OWNER_WORKER="${POEM1_OWNER_WORKER:-mfd-hub}"

# The mutual needed no handle until discovery: it only ever SENT, and a sender
# is identified by the DID in its signature. Probing runs the other way.
MUTUAL_HANDLE="${POEM1_MUTUAL_HANDLE:-idiot.town}"
MUTUAL_HUB="${POEM1_MUTUAL_HUB:-https://idiot-hub.service-cloudflare-442.workers.dev}"
MUTUAL_WORKER="${POEM1_MUTUAL_WORKER:-idiot-hub}"

# The non-mutual sender. Unset/undeployed until someone stands it up, so the
# cases that need it SKIP loudly rather than silently not running.
STRANGER_HANDLE="${POEM1_STRANGER_HANDLE:-noitsrusty.bsky.social}"
STRANGER_HUB="${POEM1_STRANGER_HUB:-https://rusty-hub.service-cloudflare-442.workers.dev}"
STRANGER_WORKER="${POEM1_STRANGER_WORKER:-rusty-hub}"

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
CASES="mutual-push record-push relay-closed device-identity discovery bad-token unknown-handle sender-warns recipient-enforces"

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

  record-push          POSITIVE. Same path as mutual-push, but the app is
                       PUBLISHED to the sender's repo first and pushed by
                       reference — proving a record round-trips to hardware and
                       that the wire format did not change to allow it.
                       Needs: token for $MUTUAL_WORKER AND a live OAuth session
                       on that hub (publishing writes their repo). Skips, not
                       fails, when the session has lapsed.

  relay-closed         THE FRONT DOOR. An unauthenticated POST to
                       /devices/<id>/send must be refused, and an unclaimed
                       device id must get nothing even WITH the owner token.
                       Needs: token for $OWNER_WORKER.

  device-identity      A paired device cannot be impersonated: the wrong key is
                       refused, and staying SILENT (never answering the
                       challenge) receives nothing. Uses tools/fake-device.mjs
                       against a scratch device id — never your real hardware.
                       Needs: token for $OWNER_WORKER, node 22+.

  discovery            A mutual can ask what this hub accepts and gets device
                       PROFILES — never ids, names or counts. A non-mutual is
                       refused. Duplicate devices must collapse, or the answer
                       becomes a device count.
                       Needs: token for $OWNER_WORKER and $MUTUAL_WORKER, node.

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

# Publish an app into a hub owner's own repo. Returns the HTTP status; body in
# $BODY. Needs a LIVE OAuth session on that hub, not just an owner token — this
# writes the owner's atproto repo, which the hub can only do on their behalf.
publish_app() {  # hub token name file
  local hub="$1" token="$2" name="$3" file="$4" payload
  payload=$(jq -n --arg name "$name" --arg code "$(cat "$file")" \
    --arg desc "published by test-federation.sh" \
    '{name: $name, code: $code, description: $desc}')
  curl -sS -o "$BODY" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    --data-binary "$payload" --max-time 60 "${hub%/}/apps"
}

# Push by REFERENCE rather than by value: the sender resolves the record to Lua
# before anything leaves its hub, so the recipient sees the identical {type,
# code} it has always seen.
push_ref() {  # hub token to ref
  local hub="$1" token="$2" to="$3" ref="$4" payload
  payload=$(jq -n --arg to "$to" --arg app "$ref" '{to: $to, app: $app}')
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

# ── 2. The same push, but the app is a RECORD ────────────────────────────────
# mutual-push proves Lua reaches hardware. This proves the app can be a durable,
# named, authored thing on the way there — published to the sender's repo, then
# pushed by reference and compiled on someone else's device.
#
# The load-bearing assertion is the quiet one: the recipient is unchanged. The
# sender resolves the record to source BEFORE signing, so the wire stays frozen
# at {type, code} and a peer running older hub code cannot tell the difference.
# If this case ever needs the recipient updated to pass, app records will have
# leaked into the federation protocol — which is exactly what the resolve-first
# design exists to prevent.
if wanted record-push; then
  tok=$(token_for "$MUTUAL_WORKER")
  if [[ -z "$tok" ]]; then
    report SKIP record-push "no token for $MUTUAL_WORKER (see header)"
  else
    code=$(publish_app "$MUTUAL_HUB" "$tok" "fed-probe" "$APP_FILE")
    if [[ "$code" != "200" ]]; then
      # An expired OAuth session is a setup problem on that hub, not a broken
      # push path — the owner has to re-login in a browser. Skipping keeps it
      # from reading as a federation regression.
      # Not necessarily JSON: a hub still on code without /apps answers with a
      # plain-text 404, and a jq error there would obscure the actual reason.
      why=$(jq -r '.message // .error // empty' < "$BODY" 2>/dev/null || true)
      [[ -z "$why" ]] && why="HTTP $code — $MUTUAL_WORKER may predate app records; deploy it"
      report SKIP record-push "could not publish to $MUTUAL_WORKER's repo: $why"
    else
      ref=$(jq -r '.rkey' < "$BODY")
      cid=$(jq -r '.cid' < "$BODY")

      owner_tok=$(token_for "$OWNER_WORKER")
      seq_before=$(latest_seq "$OWNER_HUB" "$owner_tok")

      code=$(push_ref "$MUTUAL_HUB" "$tok" "$OWNER_HANDLE" "$ref")
      delivered=$(jq -r '.response.delivered // false' < "$BODY")
      sent_cid=$(jq -r '.app.cid // ""' < "$BODY")

      if [[ "$code" != "200" || "$delivered" != "true" ]]; then
        report FAIL record-push "push by reference failed: HTTP $code, error=$(err_of)"
      elif [[ "$sent_cid" != "$cid" ]]; then
        # The response must name the version that actually went. Without this,
        # "pin an app by CID" (docs/social-plan.md, open decision 1) has no
        # trustworthy input, because the sender's report of WHAT it sent would
        # be unverified.
        report FAIL record-push "pushed cid '$sent_cid' is not the published '$cid'"
      elif [[ -z "$seq_before" ]]; then
        report PASS record-push "record $ref delivered (compile UNVERIFIED — no token for $OWNER_WORKER)"
      else
        verdict=$(compile_verdict "$OWNER_HUB" "$owner_tok" "$seq_before")
        case "$verdict" in
          compiled) report PASS record-push "published record $ref pushed by reference and compiled ON the device" ;;
          error:*)  report FAIL record-push "delivered but FAILED to compile: ${verdict#error:}" ;;
          *)        report FAIL record-push "delivered but device never reported compiling it" ;;
        esac
      fi
    fi
  fi
fi

# ── 3. The relay's front door is shut ────────────────────────────────────────
# The federated path was authenticated for weeks while the relay beside it was
# not: POST /devices/<id>/send with NO credential returned 200 on a live hub.
# Hub URLs are published in atproto repos by design and device ids are printed
# on the device's own screen, so every claim about mutuals being the only
# writers was false at the front door.
#
# Two assertions, because the fix has two halves and either alone is a hole:
#   1. no credential          -> refused
#   2. owner credential, but an id this hub does not carry -> still refused,
#      or the hub is an open relay onto other people's devices for its owner.
if wanted relay-closed; then
  tok=$(token_for "$OWNER_WORKER")
  dev=$(curl -sS -m 20 -H "Authorization: Bearer $tok" "${OWNER_HUB%/}/hub/device" \
        | jq -r '.deviceId // ""' 2>/dev/null)
  if [[ -z "$tok" ]]; then
    report SKIP relay-closed "no token for $OWNER_WORKER"
  elif [[ -z "$dev" ]]; then
    report SKIP relay-closed "$OWNER_WORKER has no device claimed"
  else
    # A payload the runtime ignores: this must prove the door is shut without
    # betting that it is. If the gate were open, a real app would land on the
    # panel, so the probe is deliberately inert.
    probe='{"channel":"system","type":"relay-probe-ignore-me"}'
    anon=$(curl -sS -o "$BODY" -w "%{http_code}" -m 20 -X POST \
      -H "Content-Type: application/json" --data-binary "$probe" \
      "${OWNER_HUB%/}/devices/$dev/send")

    unclaimed=$(curl -sS -o /dev/null -w "%{http_code}" -m 20 -X POST \
      -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
      --data-binary "$probe" "${OWNER_HUB%/}/devices/definitelynotaclaimeddevice/send")

    if [[ "$anon" == "200" ]]; then
      report FAIL relay-closed "ANYONE CAN PUSH TO THIS DEVICE — relay is open (HTTP 200, no credential)"
    elif [[ "$anon" != "401" && "$anon" != "403" ]]; then
      report FAIL relay-closed "expected 401/403 for an anonymous push, got $anon"
    elif [[ "$unclaimed" == "200" ]]; then
      report FAIL relay-closed "hub relayed to an UNCLAIMED device id — it is an open relay"
    elif [[ "$unclaimed" != "404" && "$unclaimed" != "403" ]]; then
      report FAIL relay-closed "expected 404/403 for an unclaimed id, got $unclaimed"
    else
      report PASS relay-closed "anonymous push refused ($anon); unclaimed id refused ($unclaimed)"
    fi
  fi
fi

# ── 4. A paired device cannot be impersonated ────────────────────────────────
# The relay gate proves an UNCLAIMED id gets nothing. This proves a CLAIMED one
# cannot be worn by someone who merely knows it — which is the whole difference
# between "the hub carries my device" and "the hub carries whoever says they are
# my device". Device ids are printed on the device's own screen, so knowing one
# is not evidence of anything.
#
# Runs against a scratch id that is claimed, paired and released here. It never
# touches real hardware — impersonating your actual device would mean racing the
# thing you depend on.
#
# The silent case is the one worth having. An impostor need not fail the
# challenge; it can simply never answer, staying attached and unverified. If
# delivery were gated on "not refused" rather than on "proved", silence would be
# the easiest bypass in the system and every other assertion here would pass.
if wanted device-identity; then
  tok=$(token_for "$OWNER_WORKER")
  rig="suiterig$$"
  if [[ -z "$tok" ]]; then
    report SKIP device-identity "no token for $OWNER_WORKER"
  elif ! command -v node >/dev/null 2>&1; then
    report SKIP device-identity "node not available"
  else
    api() { curl -sS -m 20 -o "$BODY" -w "%{http_code}" -H "Authorization: Bearer $tok" "$@"; }
    rm -f "/tmp/fake-device-$rig.jwk"
    api -X POST -H "Content-Type: application/json" \
      --data-binary "{\"deviceId\":\"$rig\"}" "${OWNER_HUB%/}/hub/devices" >/dev/null
    api -X POST "${OWNER_HUB%/}/hub/devices/$rig/pair" >/dev/null

    host="${OWNER_HUB#*://}"; host="${host%%/*}"
    bound=$(node tools/fake-device.mjs "$host" "$rig" 2>/dev/null | tail -1)
    impostor=$(node tools/fake-device.mjs "$host" "$rig" --wrong-key 2>/dev/null | tail -1)

    # Silent impostor: attach, answer nothing, and see whether a push reaches it.
    silent=$(node -e '
      const [h,d,t]=process.argv.slice(1);
      const ws=new WebSocket(`wss://${h}/devices/${d}`); let got=[];
      ws.onmessage=e=>got.push(e.data);
      ws.onopen=()=>setTimeout(async()=>{
        const r=await fetch(`https://${h}/devices/${d}/send`,{method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${t}`},
          body:JSON.stringify({channel:"system",type:"suite-probe"})});
        console.log(`${r.status} ${got.filter(f=>!f.includes("identify")).length}`);
        process.exit(0);
      },3000);
      setTimeout(()=>{console.log("timeout 0");process.exit(0)},15000);
    ' "$host" "$rig" "$tok" 2>/dev/null | tail -1)

    api -X DELETE "${OWNER_HUB%/}/hub/devices/$rig" >/dev/null
    rm -f "/tmp/fake-device-$rig.jwk"

    if [[ "$bound" != *"state=bound"* ]]; then
      report FAIL device-identity "pairing did not bind a key: $bound"
    elif [[ "$impostor" != *"does not match"* ]]; then
      report FAIL device-identity "AN IMPOSTOR KEY WAS ACCEPTED — device identity is decorative: $impostor"
    elif [[ "$silent" == "200 "* ]]; then
      report FAIL device-identity "A SILENT IMPOSTOR RECEIVED A PUSH — staying quiet bypasses identity"
    elif [[ "$silent" != "503 0" ]]; then
      report FAIL device-identity "expected '503 0' for the silent impostor, got '$silent'"
    else
      report PASS device-identity "wrong key refused; silent impostor got 503 and zero frames"
    fi
  fi
fi

# ── 5. The network answers questions about itself ────────────────────────────
# Discovery is a live question, never a cached belief: someone retires a board or
# adds one, and a remembered answer keeps being acted on with confidence long
# after it stopped being true.
#
# The assertions are as much about what is NOT returned. A device id is a
# credential on the relay, so discovery must never become the thing that moves
# one between hubs — and a list that did not deduplicate would be a device count,
# which is nobody's business either. Two identical devices, one profile.
if wanted discovery; then
  otok=$(token_for "$OWNER_WORKER"); mtok=$(token_for "$MUTUAL_WORKER")
  a="disco$$a"; b="disco$$b"
  if [[ -z "$otok" || -z "$mtok" ]]; then
    report SKIP discovery "need tokens for both $OWNER_WORKER and $MUTUAL_WORKER"
  elif ! command -v node >/dev/null 2>&1; then
    report SKIP discovery "node not available"
  else
    mhost="${MUTUAL_HUB#*://}"; mhost="${mhost%%/*}"
    for d in "$a" "$b"; do
      curl -sS -m 20 -o /dev/null -H "Authorization: Bearer $mtok" -H "Content-Type: application/json" \
        -X POST --data-binary "{\"deviceId\":\"$d\"}" "${MUTUAL_HUB%/}/hub/devices"
      curl -sS -m 20 -o /dev/null -H "Authorization: Bearer $mtok" \
        -X POST "${MUTUAL_HUB%/}/hub/devices/$d/pair"
      rm -f "/tmp/fake-device-$d.jwk"
      # Both claim to be the SAME board: the dedup assertion below is the point.
      node tools/fake-device.mjs "$mhost" "$d" --type suitesim --screen 111x222 >/dev/null 2>&1
    done

    code=$(curl -sS -o "$BODY" -w "%{http_code}" -m 30 -H "Authorization: Bearer $otok" \
      "${OWNER_HUB%/}/federation/probe/$MUTUAL_HANDLE")
    sims=$(jq -r '[.response.profiles[]? | select(.deviceType=="suitesim")] | length' < "$BODY" 2>/dev/null)
    leaked=$(jq -r '[.response.profiles[]? | keys[]] | unique | join(",")' < "$BODY" 2>/dev/null)

    # And a non-mutual must not be able to ask at all.
    refused=$(curl -sS -o /dev/null -w "%{http_code}" -m 30 -H "Authorization: Bearer $otok" \
      "${OWNER_HUB%/}/federation/probe/$STRANGER_HANDLE")

    for d in "$a" "$b"; do
      curl -sS -m 20 -o /dev/null -X DELETE -H "Authorization: Bearer $mtok" \
        "${MUTUAL_HUB%/}/hub/devices/$d"
      rm -f "/tmp/fake-device-$d.jwk"
    done

    if [[ "$code" != "200" ]]; then
      report FAIL discovery "probing a mutual failed: HTTP $code"
    elif [[ "$sims" != "1" ]]; then
      report FAIL discovery "two identical devices produced $sims profile(s) — the answer is a device COUNT"
    elif [[ "$leaked" == *"deviceId"* || "$leaked" == *"name"* || "$leaked" == *"key"* ]]; then
      report FAIL discovery "PROFILES LEAKED IDENTITY: fields were $leaked"
    elif [[ "$refused" == "200" ]]; then
      report FAIL discovery "a NON-MUTUAL answered a capabilities probe"
    else
      report PASS discovery "mutual described by shape only ($leaked); non-mutual refused ($refused)"
    fi
  fi
fi

# ── 6. A wrong credential is refused ─────────────────────────────────────────
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

# ── 7. Discovery fails cleanly ───────────────────────────────────────────────
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

# ── 8. The sender's advisory check ───────────────────────────────────────────
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

# ── 9. The recipient enforces, independently ─────────────────────────────────
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
