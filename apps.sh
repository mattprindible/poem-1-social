#!/usr/bin/env bash
#
# apps.sh — Your app library, as records in your own atproto repo.
#
#   ./apps.sh publish device-apps/minute-clock.lua
#   ./apps.sh list                          # yours
#   ./apps.sh list alice.bsky.social        # theirs — no account needed
#   ./apps.sh show alice.bsky.social/minute-clock
#   ./apps.sh run minute-clock              # onto your own device
#   ./apps.sh push alice.bsky.social minute-clock
#   ./apps.sh delete minute-clock
#
# WHY THIS EXISTS ALONGSIDE send-app.sh
# send-app.sh pushes a FILE at a device over the relay, needs no login, and is
# still the right tool while you are iterating with the thing plugged in. It
# just has no idea what it sent: no name, no author, no history. This does,
# because the app lives in your repo rather than on your laptop — which is what
# lets somebody else find it, and what lets you push it without holding a copy.
#
# An app is named one of three ways, everywhere in this script:
#
#   minute-clock                    in YOUR library
#   alice.bsky.social/minute-clock  in THEIRS
#   at://did:plc:…/is.mfd.poem1.app/minute-clock
#
# Reads need nothing. Writes (publish, delete) and pushes need an owner
# credential for YOUR hub: $HUB_ADMIN_TOKEN, or the keychain entry that
# set-hub.sh and test-federation.sh already use.
#
# Requires: curl, jq.

set -euo pipefail

usage() {
  cat <<EOF >&2
Usage: $0 <command> [args]

Commands:
  publish FILE [--name NAME] [--description TEXT]
                          Publish (or update) an app record. NAME defaults to
                          the filename without .lua; the record key is derived
                          from it, so re-publishing the same name is an EDIT.
  list [REPO]             List your apps, or REPO's (handle or DID).
  show REF                Print one app's Lua source to stdout.
  info REF                Print the record's metadata as JSON.
  run REF                 Load an app onto your own device.
  push TO REF [--force]   Push an app to TO's device. Mutuals only.
  delete RKEY             Remove an app record from your repo.
  lexicon                 Does this project's schema resolve? (DNS + records)
  lexicon publish         Publish the schemas into your repo. Only meaningful
                          for the account the authority's TXT record names.

Hub URL:   --hub URL, then \$RESIDENT_BASE_URL, then ./.resident-hub-url
Owner token: \$HUB_ADMIN_TOKEN, then keychain (poem1-hub-admin / worker name)
EOF
}

hub_url=""
args=()
force=0
name=""
description=""

# The command is the first bare word, wherever it falls — flags are global and
# may come before it (`./apps.sh --hub URL list`) or after (`list --hub URL`).
cmd=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub)         hub_url="$2"; shift 2 ;;
    --name)        name="$2"; shift 2 ;;
    --description) description="$2"; shift 2 ;;
    --force)       force=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    -*)            echo "apps: unknown option: $1" >&2; exit 2 ;;
    *)             if [[ -z "$cmd" ]]; then cmd="$1"; else args+=("$1"); fi; shift ;;
  esac
done

[[ -z "$cmd" ]] && { usage; exit 2; }

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "apps: error: '$tool' not found." >&2; exit 2; }
done

# ── Where is my hub ──────────────────────────────────────────────────────────
# No public-relay fallback, unlike send-app.sh: every command here needs a hub
# that knows who you are. The relay has no idea, so defaulting to it would only
# produce a confusing 404.
if [[ -z "$hub_url" ]]; then
  hub_url="${RESIDENT_BASE_URL:-}"
fi
if [[ -z "$hub_url" && -f .resident-hub-url ]]; then
  hub_url=$(tr -d '[:space:]' < .resident-hub-url)
fi
if [[ -z "$hub_url" ]]; then
  echo "apps: error: no hub URL. Pass --hub URL, set \$RESIDENT_BASE_URL," >&2
  echo "  or write it into ./.resident-hub-url (see ./set-hub.sh)." >&2
  exit 2
fi
hub_url="${hub_url%/}"

# Same convention as set-hub.sh: keychain account = worker name = the first
# label of the hostname.
owner_token() {
  local host token
  token="${HUB_ADMIN_TOKEN:-}"
  if [[ -z "$token" ]] && command -v security >/dev/null 2>&1; then
    host="${hub_url#*://}"; host="${host%%/*}"
    token=$(security find-generic-password -a "${host%%.*}" \
      -s "poem1-hub-admin" -w 2>/dev/null || true)
  fi
  printf '%s' "$token"
}

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

# Runs a request; prints the status, leaves the body in $BODY. Adds the owner
# token only when one is needed, so read commands work with no credential at all.
call() {  # method path [payload] [--auth]
  local method="$1" path="$2" payload="${3:-}" auth="${4:-}"
  local -a curl_args=(-sS -o "$BODY" -w "%{http_code}" -X "$method" --max-time 60)

  if [[ "$auth" == "--auth" ]]; then
    local token; token=$(owner_token)
    if [[ -z "$token" ]]; then
      echo "apps: error: this command needs an owner token for $hub_url." >&2
      echo "  Set \$HUB_ADMIN_TOKEN, or store it in the keychain:" >&2
      echo "    security add-generic-password -a <worker> -s poem1-hub-admin -w <token>" >&2
      exit 2
    fi
    curl_args+=(-H "Authorization: Bearer $token")
  fi

  if [[ -n "$payload" ]]; then
    curl_args+=(-H "Content-Type: application/json" --data-binary "$payload")
  fi

  curl "${curl_args[@]}" "${hub_url}${path}"
}

# Print the body and exit non-zero unless the status is 2xx.
finish() {  # status [success-jq]
  local status="$1" filter="${2:-.}"
  if [[ "$status" =~ ^2 ]]; then
    jq -r "$filter" < "$BODY"
    exit 0
  fi
  echo "apps: HTTP $status" >&2
  jq -r '.message // .error // .' < "$BODY" >&2
  exit 1
}

# URL-encode a path segment. App refs contain "/" and DIDs contain ":", both of
# which must survive as data rather than becoming path structure.
urlenc() {
  jq -rn --arg s "$1" '$s|@uri'
}

case "$cmd" in
  publish)
    file="${args[0]:-}"
    [[ -z "$file" ]] && { echo "apps: publish needs a FILE" >&2; exit 2; }
    [[ -f "$file" ]] || { echo "apps: file not found: $file" >&2; exit 2; }
    if [[ -z "$name" ]]; then
      name=$(basename "$file"); name="${name%.lua}"
    fi
    payload=$(jq -n --arg name "$name" --arg code "$(cat "$file")" \
      --arg desc "$description" \
      '{name: $name, code: $code} + (if $desc == "" then {} else {description: $desc} end)')
    status=$(call POST /apps "$payload" --auth)
    finish "$status" '"Published \(.name) as \(.rkey)\n  \(.uri)\n  cid \(.cid)"'
    ;;

  list)
    repo="${args[0]:-}"
    if [[ -n "$repo" ]]; then
      status=$(call GET "/apps?repo=$(urlenc "$repo")")
    else
      status=$(call GET /apps)
    fi
    finish "$status" '
      if .count == 0 then "No apps published."
      else "\(.count) app(s) in \(.repo.handle // .repo.did):\n" +
        ([.apps[] | "  \(.rkey)  \(.bytes)B  \(.description // .name)"] | join("\n"))
      end'
    ;;

  show)
    ref="${args[0]:-}"
    [[ -z "$ref" ]] && { echo "apps: show needs a REF" >&2; exit 2; }
    status=$(call GET "/apps/$(urlenc "$ref")")
    finish "$status" '.app.code'
    ;;

  info)
    ref="${args[0]:-}"
    [[ -z "$ref" ]] && { echo "apps: info needs a REF" >&2; exit 2; }
    status=$(call GET "/apps/$(urlenc "$ref")")
    finish "$status" '{author, rkey, uri, cid, name: .app.name,
                       description: .app.description,
                       createdAt: .app.createdAt, updatedAt: .app.updatedAt}'
    ;;

  run)
    ref="${args[0]:-}"
    [[ -z "$ref" ]] && { echo "apps: run needs a REF" >&2; exit 2; }
    payload=$(jq -n --arg app "$ref" '{app: $app}')
    status=$(call POST /hub/device/app "$payload" --auth)
    finish "$status" '"Loaded \(.app.name) (cid \(.app.cid)) onto \(.deviceId)."'
    ;;

  push)
    to="${args[0]:-}"; ref="${args[1]:-}"
    [[ -z "$to" || -z "$ref" ]] && { echo "apps: push needs TO and REF" >&2; exit 2; }
    payload=$(jq -n --arg to "$to" --arg app "$ref" --argjson f "$force" \
      '{to: $to, app: $app} + (if $f == 1 then {force: true} else {} end)')
    status=$(call POST /federation/push "$payload" --auth)
    finish "$status" '
      if .response.delivered then
        "Delivered \(.app.name) to \(.to.handle) — their hub says: \(.response.message)"
      else
        "Sent to \(.to.hub), but NOT delivered: \(.response.message // .response)"
      end'
    ;;

  delete)
    rkey="${args[0]:-}"
    [[ -z "$rkey" ]] && { echo "apps: delete needs an RKEY" >&2; exit 2; }
    status=$(call DELETE "/apps/$(urlenc "$rkey")" "" --auth)
    finish "$status" '"Deleted \(.rkey)."'
    ;;

  lexicon)
    if [[ "${args[0]:-}" == "publish" ]]; then
      status=$(call POST /hub/lexicons "" --auth)
      finish "$status" '"\(.message)\n" +
        ([.published[] | "  \(.nsid)\n    \(.uri)"] | join("\n"))'
    else
      status=$(call GET /hub/lexicons)
      finish "$status" '
        ([.lexicons[] | "\(if .resolves then "✓" else "✗" end) \(.nsid)\n    \(.note)"]
         | join("\n"))'
    fi
    ;;

  -h|--help|help) usage; exit 0 ;;
  *) echo "apps: unknown command: $cmd" >&2; usage; exit 2 ;;
esac
