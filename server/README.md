# server — your Poem/1 hub

A Cloudflare Worker that is **your** Resident relay, plus the social layer built
on top of it. One hub, one owner, one atproto identity.

Started life as a copy of Resident's `examples/server-template` — the worker that
`resident.inanimate.tech` runs by default — whose README says to fork it as a
starting point. The relay logic still lives in the `@inanimate/resident` package,
so nothing is forked; everything here is additive.

Why bother rather than using the public relay: **the public relay has no
authentication.** Anyone who knows your device ID can push code to your Poem/1.
Owning the endpoint is the prerequisite for everything else. The design and its
reasoning live in [`../docs/social-plan.md`](../docs/social-plan.md).

## Deploy

```sh
npm install
npm run gen-key | npx wrangler secret put HUB_PRIVATE_JWK   # OAuth client key
npx wrangler deploy                                         # -> <name>.<account>.workers.dev
```

Point your device at it (no reflashing — the hub is runtime config):

```sh
cd .. && ./set-hub.sh <name>.<account>.workers.dev
```

Then open `https://<your-hub>/oauth/login` and sign in with your Bluesky account.
**The first account to sign in claims the hub**, and afterwards only that DID
may. Signing in also publishes your hub record automatically, and gives your
browser an owner session.

Optional, for CLI and automation:

```sh
TOKEN="$(openssl rand -hex 32)"
security add-generic-password -a <worker-name> -s poem1-hub-admin -w "$TOKEN"  # macOS
printf '%s' "$TOKEN" | npx wrangler secret put HUB_ADMIN_TOKEN
```

> [!IMPORTANT]
> Cloudflare secrets are **write-only**. `wrangler secret list` will tell you
> `HUB_ADMIN_TOKEN` exists but never what it is, and `wrangler secret put` hides
> its input — so a token you did not record is gone, and the only fix is
> replacing it. Record it once, as above, rather than rotating it every time you
> need it. `test-federation.sh` reads tokens from that keychain service by worker
> name.

## Routes

### Device relay (the canonical Resident protocol)

| Route | |
|---|---|
| `wss://<hub>/devices/<id>` | device WebSocket |
| `POST /devices/<id>/send` | push JSON to a connected device |
| `GET /devices/<id>` | connection status |
| `GET /` | relay banner — **must** stay 200; Courier reads the `Date` header as its time-sync fallback |

### Identity

| Route | |
|---|---|
| `GET /client-metadata.json` | the hub **as** an OAuth client — this URL *is* the `client_id` |
| `GET /.well-known/jwks.json` | public half of the OAuth client key |
| `GET /identity/<handle\|did>` | resolve to DID document + PDS |
| `GET /oauth/login[?handle=]` | sign in (or a form) |
| `GET /oauth/callback` | return leg |
| `GET /oauth/session` | who owns this hub |
| `POST /oauth/logout` 🔒 | revoke and unclaim |

### Hub record

| Route | |
|---|---|
| `GET /hub/key` | this hub's federation public key |
| `GET /hub/record` | this hub's published record |
| `POST /hub/publish` 🔒 | publish or refresh it |
| `DELETE /hub/record` 🔒 | revoke |
| `POST /hub/rotate-key` 🔒 | new key, then republish |
| `GET /hub/peer/<handle\|did>` | find **someone else's** hub |

### Federation

| Route | |
|---|---|
| `POST /federation/push` 🔒 | push an app to a mutual's device |
| `POST /federation/inbox` | receive one — authenticated by **signature**, not by owner |
| `GET /federation/relationship/<who>` | are we mutuals |
| `GET \| POST /hub/device` 🔒 | which device this hub relays to |

🔒 = owner only. Send `Authorization: Bearer $HUB_ADMIN_TOKEN`, or use the browser
session cookie from `/oauth/login`. A session is checked against the **current**
owner on every request, so releasing the hub revokes sessions rather than leaving
a previous owner in control for the cookie's remaining lifetime.

`/federation/inbox` is deliberately **not** owner-gated: it is authenticated by
the sender's signature, and gating it would make federation impossible. That
distinction — *hub-to-hub* auth versus *owner* auth — is the one to keep straight
when adding routes.

`POST /federation/push` takes `{to, code}` plus an optional `force`, which skips
**this** hub's advisory mutual check. It cannot grant access — the recipient
enforces independently — so it exists to make that independence observable
instead of masked by the local check.

## Testing it

```sh
cd .. && ./test-federation.sh          # every configured case
./test-federation.sh --list            # what each case needs
./test-federation.sh -v                # full JSON per case
```

The positive case proves the machinery runs; the negative cases prove it says
no, which is the entire security claim. A hub that accepted everything would pass
the positive test perfectly. The load-bearing case is `recipient-enforces`: it
pushes from a non-mutual with `force`, so only the recipient's own answer
remains, and it asserts the refusal **names the relationship** — HTTP 403 alone
would also be produced by a signature failure, which would report the graph check
holding while it was never reached.

## How trust works

Every inbound federated push must pass two independent checks:

1. **Is it really from that DID?** The signature is verified against the public
   key that sender publishes in *their own* atproto repo. The request cannot
   vouch for itself.
2. **Is that DID a mutual?** Read from the live Bluesky graph.

Either alone is useless. Without (1) anyone can put a DID in a header; without
(2) any stranger running a hub could push.

Social trust sets **policy** (who may push), never **mechanism** (what pushed
code can do). The Lua sandbox, driver allowlists and e-ink flip limits are
untouched, and the device's hold-to-stop escape hatch works regardless of who
sent the app.

## Layout

```
src/worker.ts             entry: routing + Durable Object exports
src/hub-store.ts          HubStore DO — owner, keys, sessions, nonces
src/auth.ts               owner authentication (cookie + bearer)
src/identity.ts           atproto resolution: handle -> DID -> PDS
src/oauth.ts              client metadata + client key
src/oauth-client.ts       @atproto/oauth-client wired for Workers
src/oauth-routes.ts       login / callback / session / logout
src/hub-key.ts            federation signing key
src/hub-record.ts         the hub record: read, publish, delete, discover
src/hub-routes.ts         hub record + peer discovery routes
src/federation.ts         signing, verification, mutual-follow checks
src/federation-routes.ts  push and inbox
scripts/gen-key.mjs       generate the OAuth client key (WebCrypto, no deps)
```

Two Durable Objects: `DeviceAgent` (per device, from `@inanimate/resident`) and
`HubStore` (a singleton, since a hub has exactly one owner).

## Running on Workers

`@atproto/oauth-client-node` is Node-only, and the community Workers package is
long stale, so this builds on `@atproto/oauth-client` — the maintained,
environment-agnostic base — and supplies the environment-specific parts itself.
[`bluesky-social/atproto#3292`](https://github.com/bluesky-social/atproto/issues/3292)
lists four blockers; all four are handled, and a fifth turned up in testing. Each
is documented where it is fixed, in `src/oauth-client.ts`.

Two platform notes, both found the hard way:

- A Worker fetching another Worker **on the same zone** fails with Cloudflare
  error 1042, so two hubs on one account cannot federate without the
  `global_fetch_strictly_public` compatibility flag (already set in
  `wrangler.jsonc`).
- **Deploying restarts Durable Objects and drops device WebSockets**, so the
  first push after a deploy can report "Device not connected" until the device
  reconnects a few seconds later.

## Development

```sh
npm run typecheck
npx wrangler dev            # http://localhost:5173, matching send-app.sh --dev
```

A full login cannot be exercised locally: atproto requires `client_id` to be a
public HTTPS URL, and the client rejects a loopback origin outright ("URL must
use the https: protocol"). The device relay, identity resolution and metadata
routes all work fine against `wrangler dev`.

Run `wrangler` from this directory, not the repo root — from the root it mistakes
the project for a static site.
