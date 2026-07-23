# Poem/1 Social — design plan

**Status:** design agreed 2026-07-22, not yet implemented.
Supersedes the earlier "self-hosted Worker" napkin sketch (auth + error feedback),
which was two chores bundled together rather than a design.

## The bet

Poem/1 came from a Kickstarter. Its backers are a real, bounded, already-social
group. The bet is that **the trust implicit in a social graph affords more than an
untrusted sandbox security model normally allows** — specifically, enough trust to
let people deploy apps to each other's physical devices.

Resident stays a **dependency, not a fork**. The social dimension lives entirely in
(a) a per-person Cloudflare Worker and (b) Lua apps. The firmware library is
untouched, so upstream Resident keeps flowing in via `./sync.sh`.

## Trust model

Identity and the social graph come from **AT Protocol** (Bluesky accounts).

| Tier | Relationship | Capability |
|---|---|---|
| Strong tie | Mutual follow | **Push apps** (Lua code) to your device |
| Weak tie | Follower-of-follower | **Discovery only** — their apps appear when you search. No write access, ever. |

Push is the only write path, and only mutuals have it. Everything a weak tie
offers you, *you* pull. Nothing unbidden reaches your hardware from outside your
mutuals.

Social trust changes **policy** (who may push), never **mechanism** (what pushed
code can do). The Lua sandbox, driver allowlists, and e-ink flip rate limits stay
exactly as they are. Worst case for a hostile mutual is an obnoxious screen, not
exfiltrated Wi-Fi credentials.

## Topology

```
your device ⇄ (WSS) ⇄ your hub ⇄ (HTTPS) ⇄ their hub ⇄ (WSS) ⇄ their device
```

Each person runs their own hub (a Cloudflare Worker + Durable Object). A device
only ever holds a socket to its **owner's** hub. Federation is ordinary HTTPS
between two public endpoints — no NAT traversal, no P2P, no rendezvous server.

The hub's job is deliberately small: hold the device socket, relay pushes, verify
inbound requests. **Discovery does not involve the hub at all.**

## Identity, discovery, and revocation: one record

Trust is anchored in a record the owner publishes in their own atproto repo — say
`tech.inanimate.resident.hub` — containing the hub's **endpoint URL** and its
**public key**.

Each hub generates its own keypair and signs its own outbound requests. A
receiving hub resolves the sender's DID → their PDS → reads their hub record →
verifies the signature.

That one record does three jobs:

- **Discovery** — where is this person's hub
- **Authentication** — which key speaks for them
- **Revocation** — update or delete the record and the old key is dead

Writing it uses atproto OAuth, which is the mature part of the stack.

### Why not atproto service auth

Service auth JWTs (`iss`/`aud`/`lxm`/`exp`/`jti`, signed by the account key,
verified against the DID document) are exactly the right *shape*, but not usable
here:

- Signed by the **user's** signing key, which lives at the PDS — a third-party hub
  cannot mint one; it must ask via `getServiceAuth`, gated by session scopes that
  maintainers say aren't yet designed.
- Maintainers state services "should not accept service auth from any other
  service for now"; the spec is self-described as under-specified.
- **Revocation is not implemented** — mitigated only by ~60s lifetimes.

Right shape, wrong maturity. The repo-record scheme avoids depending on an
unfinished part of atproto, and gets real revocation, which service auth lacks.

### Why not a DID-document service entry

PLC could support extra service entries eventually, but regular users can't edit
their `did:plc` document directly today, and `did:web` would mean self-hosting
identity. The repo record is available to everyone right now.

## Apps are records too

Apps are **durable artifacts, not throwaway pushes**. An app is an atproto record
(`tech.inanimate.resident.app`) holding the Lua source plus metadata.

This gives, for free: authorship and provenance (records are signed), versioning
and history (CIDs, rkeys, timestamps), updates as record updates, and portability
— an app library that outlives the hub, the Worker, and this project.

It also collapses discovery: searching your ties for apps is just **reading their
repos**. No app store, no index, no central service.

**Consequence worth protecting:** because discovery is pure atproto, a person can
browse, publish, and follow builders **before owning a Worker or a Poem/1**. The
social layer can accumulate value while the device network is still tiny — which
is the main defence against cold start.

## Known constraints (verified 2026-07-22)

- **Durable Objects are on the Workers Free plan** (SQLite-backed only) since
  April 2025: 100k req/day, 13k GB-s/day, 5M row reads/day, 100k row writes/day,
  5GB storage. A personal hub costs **$0**. KV-backed DOs remain paid-only and are
  not needed.
- **atproto OAuth** is spec-complete but built on drafts. DPoP and PAR are
  mandatory. Client metadata documents replace registration — each self-deployed
  hub publishes its own metadata at its own URL and *is* its own OAuth client,
  with no central registry and no shared secrets. A hub is a confidential client
  (longer session lifetimes).
- **Arbitrary records** may be published to a repo: rate limits on how many, no
  limits on type.
- **Graph queries** come from `public.api.bsky.app` — `getRelationships` answers
  "are these two mutuals" directly; `getKnownFollowers` maps onto the weak-tie
  tier. Unauthenticated and free.

### The centralization we can't design away

Every self-hosted hub asks **one hosted aggregator** who its owner trusts. The
hubs are decentralized; the trust oracle is not. Acceptable to launch on (free,
public, cacheable), but if Bluesky gates those endpoints, every hub is affected
at once. Cache aggressively; treat the graph as advisory state, not live truth.

## Device-side safety

- **Escape hatch — BUILT and verified 2026-07-22.** Hold the button 3s while an
  app runs → `suspendApp()` + `clearPersistedApp()` + an "App stopped" screen.
  Lives in `device/src/main.cpp`; stock Resident, no fork.

  Stock's tap/long-press gestures run *only during the boot countdown* — while an
  app runs, stock Resident does nothing with the button. `onSystemButtonHold(cb)`
  exists for this, but its threshold is a hardcoded **500ms**, far too short here
  because the same button is also the app-facing Lua `button` module (any app
  using a half-second press would kill itself). So the hold is timed directly off
  `ButtonDriver::pressed()`, the same debounced level read the runtime polls —
  which still bypasses Lua's event dispatch, so an app cannot swallow it.
  *Upstream contribution candidate: make the runtime's hold threshold
  configurable, after which this collapses to the stock hook.*

  Verified on hardware with `device-apps/runaway.lua` (redraws every tick,
  swallows all events): short presses did nothing, the 3s hold stopped it, and
  after a reset the device went **straight to the idle screen with no restore
  countdown** — confirming the persisted copy was cleared.
- **Socially-pushed apps should be non-persistent by default.** Resident saves the
  last pushed app to NVS and auto-restores on boot, so a bad push otherwise
  survives reboots until someone is physically present. Non-persistent social
  pushes mean a power cycle heals you.
- Together these give **two independent recovery paths** — hold-to-unload for a
  running-but-bad app, power-cycle for one that wedges the Lua VM — neither
  depending on the network or the sender.

## Open decisions

1. **Update semantics.** If Alice publishes v2 of an app Bob runs, does Bob's
   device pick it up? Auto-update lets a mutual change what runs on your hardware
   later by editing a record; pinning to a CID means Bob runs exactly what he chose
   until he chooses again. *Leaning: pin by default, surface updates as something
   you accept.* Not obvious — "your friend fixed a bug and your clock silently got
   better" is a genuinely nice property to give up.
2. **Moderation / blocking.** Mutual-follow is a weak proxy for tie strength;
   people mutual-follow strangers. Revocation and per-person blocking need to be
   first-class, not an afterthought.
3. **Local app identity.** `send-app.sh` is file-based and ephemeral — no name,
   version, or author. Durable apps mean the daily loop has to change too.
4. **Hosted hub for onboarding?** Running a hub others can point at lowers the
   entry cliff. Because identity is a DID and the endpoint is a record they
   control, self-hosting later is a record update, not a migration — so a hub is
   not lock-in. Worth doing if onboarding proves to be the bottleneck.

## The real bottleneck

Not security — **onboarding**. Every participant must flash Resident over their
stock Poem/1, which is the one operation carrying the e-ink panel-damage hazard,
and the guided stock → Resident install is **not yet verified end-to-end** (this
unit can't rehearse it; no stock bootloader image was saved). A social network
with three participants is not one.

This is the long pole, and it depends on other people, so it should start early
and in parallel with everything else.

## Courtesy note

Poem/1 and Resident are both Matt Webb's. This builds community infrastructure for
his backers, in a repo intended to go public. Worth a conversation earlier than
feels necessary — partly courtesy, partly because he may have plans, and partly
because "the creator is fine with this" becomes load-bearing the moment we hold
other people's device credentials.
