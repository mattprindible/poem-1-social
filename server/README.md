# server — your SAN hub

A Cloudflare Worker that is **your** Resident relay, plus the social layer built
on top of it. One hub, one owner, one atproto identity.

Started life as a copy of Resident's `examples/server-template` — the worker that
`resident.inanimate.tech` runs by default — whose README says to fork it as a
starting point. The relay logic still lives in the `@inanimate/resident` package,
so nothing is forked; everything here is additive.

Why bother rather than using the public relay: **the public relay has no
authentication** — anyone who knows your device ID can push code to your device.
This hub does authenticate (see the relay gate below), and owning the endpoint is
the prerequisite for everything else. The design and its reasoning live in
[`../docs/social-plan.md`](../docs/social-plan.md) and
[`../docs/san.md`](../docs/san.md).

## Deploy

```sh
npm install
# NOT `npm run gen-key |` — npm prints its banner to STDOUT, so the pipe
# stores banner+JSON and the hub answers "HUB_PRIVATE_JWK is not valid JSON".
node scripts/gen-key.mjs | npx wrangler secret put HUB_PRIVATE_JWK   # OAuth client key
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

### The relay gate

Everything under `/devices/` passes `src/device-gate.ts` **before** the relay
router below, because upstream forwards those straight into the Durable Object
and there is no seam inside it to hook without forking Resident.

| Under `/devices/<id>` | Who may |
|---|---|
| `POST /send` | owner only — **this was the hole** |
| WS `?monitor=1` | owner only; upstream broadcasts every relayed message to monitors, so it is a live read channel |
| WS (device) | any **claimed** id |
| `GET` (status) | owner only; a presence oracle otherwise |

A hub carries only what its owner has claimed, so an unclaimed id gets nothing —
that is what stops a hub being an open relay, in both directions. `POST /send`
additionally requires the owner even for a claimed device.

Passing this gate gets a socket, not trust. A device connection is then
**challenged** by `src/device-agent.ts` and must sign a per-connection nonce
with the key bound to that device; until it does, it receives nothing. So a
claimed id opens a socket here and still gets no apps there.

The split is deliberate: a gate is per-request and cannot hold the state a
challenge-response needs, while the Durable Object owns the connection for its
lifetime and can.

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
| `GET /federation/probe/<who>` 🔒 | ask a mutual what they can accept — live, never cached |
| `POST /federation/capabilities` | answer that question — **signature**-authenticated, mutuals only |
| `POST /hub/devices/<id>/pair` 🔒 | open a pairing window to bind a device's key |
| `GET \| POST /hub/devices` 🔒 | list / claim devices |
| `DELETE /hub/devices/<id>` 🔒 | release one |
| `GET \| POST /hub/device` 🔒 | which device inbound federation lands on |
| `GET /hub/device/events[?deviceId=]` 🔒 | what a device has **said back** — see below |
| `POST /hub/device/app` 🔒 | load an app onto **your own** device |

🔒 = owner only. Send `Authorization: Bearer $HUB_ADMIN_TOKEN`, or use the browser
session cookie from `/oauth/login`. A session is checked against the **current**
owner on every request, so releasing the hub revokes sessions rather than leaving
a previous owner in control for the cookie's remaining lifetime.

`/federation/inbox` is deliberately **not** owner-gated: it is authenticated by
the sender's signature, and gating it would make federation impossible. That
distinction — *hub-to-hub* auth versus *owner* auth — is the one to keep straight
when adding routes.

`POST /federation/push` takes `{to}` plus **either** `{code}` (raw Lua) or
`{app}` (a reference into a published library — see below), and an optional
`force`, which skips **this** hub's advisory mutual check. `force` cannot grant
access — the recipient enforces independently — so it exists to make that
independence observable instead of masked by the local check.

An `{app}` reference is resolved to source **here, before signing**. The wire
format between hubs stays frozen at `{type, code}`, so a peer running older code
sees no difference. Keep it that way: peers run hubs we cannot update, and every
field added to that envelope is one this project is committing to forever.

### App records

| Route | |
|---|---|
| `GET /apps` | list your library |
| `GET /apps?repo=<who>` | list **theirs** — no credential at all |
| `POST /apps` 🔒 | publish or update `{name, code, description?}` |
| `GET /apps/<ref>` | one app, source included |
| `DELETE /apps/<rkey>` 🔒 | unpublish (your repo only) |

An app is a record in its author's own atproto repo, `computer.haha.san.app`, keyed
by a slug derived from its name — so re-publishing a name is an **edit** that
mints a new CID. Note that a repo holds *current state*, not an archive: a
superseded CID answers `RecordNotFound`, so versions are identifiable and
change-detectable but not recoverable. A reference is `minute-clock` (yours),
`alice.bsky.social/minute-clock` (hers), or a full `at://…` URI; the same grammar
works in `/federation/push` and `/hub/device/app`.

Reads are ungated on purpose. Repo records are public the moment they are
published, so gating would protect nothing while breaking the property that
matters: anyone can browse a builder's apps with no hub, no device and no
account. Writes go through the owner's OAuth session, because the only repo this
hub can write is its owner's.

### The twin

A device reports its own **composition** on the identify frame — board type,
firmware build, display, drivers wired up, and a declared liveness contract —
rather than a handful of fields someone chose in advance. The hub stores it
per device and keeps it **local**: nothing device-related is ever written to a
PDS, and what a mutual can probe is a deliberate *projection* of the twin
(shape only), not the twin itself.

`./apps.sh twin <id>` exports it, and `tools/fake-device.mjs --from <file>`
becomes that exact board — so the test rig tracks real hardware instead of
drifting from a description someone forgot to update.

**Power source is deliberately absent.** Wall or battery is a deployment fact,
not a firmware one: the same binary runs either way, and this Poem/1 has a
battery ADC while living on wall power. Anything inferring portability from
composition would be wrong about the device it is describing.

### Liveness

`liveness: { expect, heartbeatSec }` is **declared**, because composition cannot
reveal it. The firmware emits a heartbeat from `loop()` — never from Lua — so an
app that wedges the VM stops the beat too, which is the failure nothing else can
see. Heartbeats are stored as a timestamp rather than ring entries; one every
30s would evict an hour of real history.

A device that declares nothing gets **no judgement at all** — not a default of
"assume persistent", which would report every sleepy or older-firmware device as
broken. Silence is only evidence when something promised not to be silent.

### Reading a device's log

`GET /hub/device/events` reports the **default** device; `?deviceId=<id>` reads
any claimed one. Alongside what the device says, the ring records the link
itself, which is what lets silence be diagnosed rather than guessed:

| Pattern | Means |
|---|---|
| `app_received`, `link_down code=1006` | the socket died — the app may be fine |
| `app_received`, `compile_error` | the app failed — the link is fine |
| `link_down code=1008 verified=false` | **we** refused it — a failed identity check |
| `link_up` with no preceding `link_down` | the **hub** restarted (a deploy tears the DO down before it can record the close) |

What it still cannot see: an app that wedges the Lua VM while its socket stays
up. That is indistinguishable from a calm app with nothing to say, because the
firmware sends no heartbeat of its own.

### The device's return path

Upstream's relay carries pushes **to** a device and drops anything coming back
(`DeviceAgent.onMessage` is an empty function). `src/device-agent.ts` subclasses
it, records what the device emits in a bounded ring, and serves it:

```sh
curl -H "Authorization: Bearer $HUB_ADMIN_TOKEN" https://<hub>/hub/device/events
```

```json
{ "deviceId": "…", "deviceConnected": true, "lastEventAt": 1785895724053,
  "events": [ { "seq": 42, "at": …, "channel": "app", "type": "heartbeat",
                "name": null, "body": "{…}" } ] }
```

Three kinds of thing arrive here, and `type` / `name` tell them apart:

| | |
|---|---|
| `channel:"app"` | the Lua app's own `events.send(name, data)` |
| `channel:"system"`, `type:"hello"` | sent on every connect, naming the hub the device believes it reached |
| `type:"telemetry"` | the runtime's own reports; `name` is `app_compiled`, `compile_error`, `runtime_error`, `log_error`, … |

Owner-gated, **not** device-ID-gated. A device ID is the credential for *pushing*
to a device and this hub already knows its own — but what a device *emits* is the
owner's, and an app can report anything it likes.

Prefer `lastEventAt` to `deviceConnected` as proof of life: Durable Objects keep
hibernating WebSockets from old boots, so the connection count (and `GET
/devices/<id>`) can report a device that left hours ago. A recorded event cannot.
That is why `set-hub.sh` confirms a hub switch with the device's own `hello`
naming the destination, and only falls back to counting connections when it has
no owner token for the destination.

## Testing it

```sh
cd .. && ./test-federation.sh          # every configured case
./test-federation.sh --list            # what each case needs
./test-federation.sh -v                # full JSON per case
```

`mutual-push` asserts the app **compiled on the device**, read back from its own
`app_compiled` telemetry — not merely that the relay accepted it for delivery. A
broken app still returns 200 with `delivered:true`, so delivery alone was never
the claim worth making. That needs an owner token for the *recipient* hub; without
one the case passes on delivery and says the compile went unverified.

A run where nothing passes exits **1**, including when every case skips. Skips
are not failures (an unconfigured hub should not look like a broken push path)
but they are not passes either, and the suite used to exit 0 on a run that tested
nothing at all.

There are two positive cases. `mutual-push` sends raw Lua; `record-push`
publishes an app to the sender's repo and pushes it **by reference**, then
asserts the CID the sender reported is the one it published. That second case is
also a guard on the wire format: it exercises app records against an *unchanged*
recipient, so if it ever needs the receiving side updated to pass, records have
leaked into the federation protocol.

The positive cases prove the machinery runs; the negative cases prove it says
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
src/device-agent.ts       DeviceAgent DO — the relay, extended to hear the device
src/hub-store.ts          HubStore DO — owner, keys, sessions, nonces
src/auth.ts               owner authentication (cookie + bearer)
src/identity.ts           atproto resolution: handle -> DID -> PDS
src/oauth.ts              client metadata + client key
src/oauth-client.ts       @atproto/oauth-client wired for Workers
src/oauth-routes.ts       login / callback / session / logout
src/device-gate.ts        the relay gate — auth + claim check, ahead of upstream
src/device-identity.ts    per-device keys: challenge, verify, pairing window
src/capabilities.ts       device profiles, for mutuals probing what we accept
src/devices.ts            the device registry: claim, release, list, default
src/hub-key.ts            federation signing key
src/pds.ts                XRPC to a PDS: authenticated (session) and public
src/hub-record.ts         the hub record: read, publish, delete, discover
src/hub-routes.ts         hub record + peer discovery routes
src/app-record.ts         app records: publish, read, list, delete, ref parsing
src/app-routes.ts         the app library, and the shared reference resolver
src/lexicon.ts            the published schemas, and whether they resolve
src/federation.ts         signing, verification, mutual-follow checks
src/federation-routes.ts  push and inbox
scripts/gen-key.mjs       generate the OAuth client key (WebCrypto, no deps)
```

Two Durable Objects: `DeviceAgent` (per device) and `HubStore` (a singleton,
since a hub has exactly one owner).

`DeviceAgent` is **our subclass** of the one in `@inanimate/resident`, exported
under the same name deliberately. A Durable Object's class name is part of its
migration identity, so renaming it would need a `renamed_classes` migration
against a live object holding the device's socket — subclassing under the same
name keeps that off the table. Don't "improve" the name.

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
- A Durable Object keeps serving the **old code** for a short while after a
  deploy, so the first RPC to a method you just added can fail with *"The RPC
  receiver does not implement the method"*. It looks exactly like a broken
  export or a missing binding; it is neither. Wait and retry before debugging —
  `npx wrangler deploy --dry-run --outdir …` and grepping the bundle for the
  method name settles whether the code actually shipped.

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
