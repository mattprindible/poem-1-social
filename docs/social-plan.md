# Poem/1 Social — design plan

**Status:** design agreed 2026-07-22; **the core bet is proven as of
2026-07-23, and its refusal half as of 2026-08-03.** Phase 0 (device escape
hatch, self-hosted hub, runtime hub config), phase 1 (atproto identity: OAuth
login, hub record published and discoverable) and federation (signed hub-to-hub
push gated on mutual follows) are all built and verified against live
infrastructure.

A second account's hub pushed a Lua app to this device — two hubs, two accounts,
one Poem/1, no shared secrets and no central service. The sender proved itself
with a key published in its own repo; the recipient checked the real Bluesky
graph for a mutual follow; and the physical hold-to-stop escape hatch stopped
the foreign app afterwards. Social trust set policy, the owner kept mechanism.

**Saying no is now proven too, which is the half that actually matters.** A
third account — a genuine *follower* of the device owner, not followed back, with
a valid signature and a hub record of its own — pushed with the sender-side
courtesy check deliberately bypassed, and the recipient refused it on the graph
alone (`following: false, followedBy: true`). A serial tap held open across the
attempt recorded nothing; the panel never learned there had been a push. That
asymmetric follow is the relationship a sloppy graph check gets wrong, because
`followedBy: true` looks like a connection. [`test-federation.sh`](../test-federation.sh)
runs the whole thing — push and refusals — as one command.

**Apps are records as of 2026-08-05.** An app is now published into its author's
own repo as `computer.haha.san.app`, and the federation suite's `record-push` case
proves the round trip: a record published to one account's repo, pushed to
another account's device *by reference*, and compiled there — verified by the
device's own telemetry, not by the relay's 200. Listing someone else's library
is an unauthenticated read of their PDS, so discovery needs no hub and no
account.

What does NOT exist yet: weak-tie discovery, and any of the onboarding work.

**Stepping back, 2026-08-05.** Reviewing the code against the concept turned up
two things it had assumed rather than chosen: a hub carries exactly one device,
and the record types were named after one person's handle and one board. Both
are now corrected — the definition of a hub, the `computer.haha.san.*`
namespace, and the migration are in [`san.md`](san.md).

That review also found the **direct relay path was unauthenticated**, which was
the most serious thing in the project and is now closed — see "Push is the only
write path" below. Worth noting how it was found: not by a test or a report, but
by writing down what a hub *is* and checking the code against it. The hole had
been there since the first hub existed.

**Namespace — SETTLED AND MIGRATED 2026-08-05.** Records moved from
`is.mfd.poem1.*` to `computer.haha.san.*`, under the authority
`san.haha.computer`, whose schemas are published and resolve. The old namespace
was wrong on two independent axes: it carried a *personal handle*, and it named
*one board* in a type that describes a sandbox app. See [`san.md`](san.md) for the reasoning and the staged migration.
`tech.inanimate.*` remains not ours to claim without asking; the same courtesy
now also keeps "Resident" out of every NSID, URL and wire identifier.
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
offers you, *you* pull.

> **TRUE AS OF 2026-08-05 — and it was not, for weeks before that.** The
> *federated* path always enforced it (signature plus mutual check, refusals
> proven). The **direct relay path authenticated nothing**: `POST
> /devices/<id>/send` with no credential returned 200 against the live hub, and
> hub URLs are public by design while device IDs are printed on the device's
> screen. The sentence above was written to describe the design and got read as
> a description of the system.
>
> Closed by the device gate ([`san.md`](san.md)): pushing requires the owner,
> and a hub carries only devices its owner has **claimed**. The suite's
> `relay-closed` case asserts both halves so it cannot silently reopen.
>
> **Still open, and worth knowing:** a device proves its identity with nothing
> but its ID, so anyone who knows a *claimed* ID can still open that device's
> socket and receive its apps. That needs a per-device secret in firmware.
> Device-side *mechanism* is unaffected throughout — sandbox, driver allowlist,
> flip limits and hold-to-stop hold against a hostile push from any source.

Social trust changes **policy** (who may push), never **mechanism** (what pushed
code can do). The Lua sandbox, driver allowlists, and e-ink flip rate limits stay
exactly as they are. Worst case for a hostile mutual is an obnoxious screen, not
exfiltrated Wi-Fi credentials.

## Topology

```
your devices ⇄ (WSS) ⇄ your hub ⇄ (HTTPS) ⇄ their hub ⇄ (WSS) ⇄ their devices
```

Each person runs their own hub (a Cloudflare Worker + Durable Object). A device
only ever holds a socket to its **owner's** hub.

Federation is ordinary HTTPS between two public endpoints — no NAT traversal,
no P2P, no rendezvous server.

> **A hub carries MANY devices — one owner, N devices**, and only devices its
> owner has explicitly **claimed**. Built 2026-08-05; before that a hub held a
> single device pointer that gated nothing, an unexamined convenience from the
> days of one person and one Poem/1. Resident runs on ESP32 boards generally and
> this repo already has a second device. Definition and cardinalities:
> [`san.md`](san.md).

The hub's job is deliberately small: hold the device socket, relay pushes, verify
inbound requests. **Discovery does not involve the hub at all.**

## Identity, discovery, and revocation: one record

Trust is anchored in a record the owner publishes in their own atproto repo — say
`computer.haha.san.hub` — containing the hub's **endpoint URL** and its
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

## Apps are records too — BUILT and verified 2026-08-05

Apps are **durable artifacts, not throwaway pushes**. An app is an atproto record
(`computer.haha.san.app`) holding the Lua source plus metadata.

The record key is derived from the app's **name**, not a random TID. That is the
decision the rest of this section rests on: re-publishing the same name is an
*edit* that mints a new CID, and an app is referable as `handle/name` with no
lookup table. The cost is that renaming creates a new app and orphans the old
key — correct, on balance, since the rkey is the app's identity.

**A repo is not an archive** (verified against a live PDS, 2026-08-05). Asking
for a superseded CID returns `RecordNotFound`; the `cid` parameter on
`getRecord` is a *precondition check* — "is this still the version I expect" —
not a way back to an old one. Versions are therefore identifiable and
change-detectable but **not recoverable from the network**. Anyone who wants to
run an exact past version must have kept a copy. This was assumed the other way
round when the section was first written, and it constrains pinning directly.

**References resolve sender-side, and that is the load-bearing constraint.**
`/federation/push` takes `{app}` as well as `{code}`, but the sending hub turns
the reference into Lua *before* it signs anything, so the wire format stays
frozen at `{type, code}`. Peers run hubs we cannot update; every field added
there is one we would be committing to support forever. A recipient on older hub
code cannot tell a record push from a raw one, because there is no difference —
and `record-push` in the suite exists to keep it that way. If that case ever
needs the *recipient* changed to pass, app records have leaked into the
federation protocol.

Whether the recipient *should* learn what landed on their device — name, author,
CID — is a real and separate question, tangled up with update semantics below.
It is not settled, so it is not shipped.

`apps.sh` is the CLI (`publish`, `list`, `show`, `info`, `run`, `push`,
`delete`). `send-app.sh` is untouched and still the file-and-a-cable path: it
needs no login, which is exactly why it stays.

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

### Cloudflare constraint (found 2026-07-23)

A Worker fetching another Worker **on the same zone** fails with error 1042, so
two hubs on one Cloudflare account cannot federate by default. Fixed with the
`global_fetch_strictly_public` compatibility flag, which sends fetch out over the
public internet rather than short-circuiting internally — which is what
federation wants anyway. Hubs on separate accounts or custom domains never see
this. Separately: **redeploying a Worker restarts its Durable Objects and drops
device WebSockets**, so the first push after any deploy can report "Device not
connected" until the device reconnects.

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

   *Still open, but no longer abstract:* records now have CIDs, and a push
   resolves a reference at send time and reports the exact CID it sent (the
   suite asserts that report matches what was published, so it is a trustworthy
   input rather than a claim). What is missing is anywhere to PUT a pin. A
   pinned app is state on the recipient's side, and nothing on the device or in
   its hub currently remembers which version of whose app it is running. That is
   the next piece of this decision, not another round of arguing the default.

   *And a pin cannot mean what it first sounds like.* Because superseded CIDs
   are unreachable (above), "pin to a CID" can only mean **detect that it
   changed and decline** — it cannot mean "keep fetching the version I chose",
   because that version is gone from the network the moment the author edits.
   Honouring a pin across a reboot therefore requires the recipient to STORE the
   Lua, not just the CID. That is a much larger commitment than it looked, and
   it argues for framing the feature as *consent to updates* rather than as
   version control.
2. **Moderation / blocking.** Mutual-follow is a weak proxy for tie strength;
   people mutual-follow strangers. Revocation and per-person blocking need to be
   first-class, not an afterthought.
3. **Local app identity — SETTLED 2026-08-05.** `send-app.sh` was file-based and
   ephemeral: no name, version, or author. The answer turned out not to be
   changing it. `send-app.sh` keeps doing exactly what it did, because a path
   that needs no login is worth having while you iterate with a cable; `apps.sh`
   is the second loop, for apps that have a name and a home. Two loops, chosen
   per task, rather than one loop made heavier for everybody.
4. **Hosted hub for onboarding?** Running a hub others can point at lowers the
   entry cliff. Because identity is a DID and the endpoint is a record they
   control, self-hosting later is a record update, not a migration — so a hub is
   not lock-in. Worth doing if onboarding proves to be the bottleneck.
   *Cheaper now than it was:* the hub hostname is runtime config (NVS), so
   pointing at a hub — or leaving one — is `./set-hub.sh`, not a rebuild. One
   firmware binary serves everybody, which removes a per-person build from the
   onboarding path.

5. **Devices can talk back — BUILT and verified 2026-08-04.** Upstream's
   `DeviceAgent.onMessage` is an empty function, so everything a device emitted
   reached the hub and was dropped. `server/src/device-agent.ts` subclasses it
   (exported under the same name, so the Durable Object needs no migration),
   records device frames in a bounded SQLite ring, and serves them at
   owner-gated `GET /hub/device/events`.

   The emit half was already in stock Resident — `events.send` in Lua,
   `publishEvent` in C++ — so this was a **hub change with no reflash**, which is
   why it was cheaper than its position in this list suggested.

   Verified end to end on hardware: `device-apps/phone-home.lua` pushed over the
   air, and `hello` / `heartbeat` / `button` frames read back out of the hub with
   the device's own `from`, `nonce` and local clock on them.

   **Errors now come back too (2026-08-04, same branch).** `main.cpp` wires
   `setTelemetryCallback` straight to `ws().sendText`, so the runtime's own
   `compile_error` / `runtime_error` / `log_error` reach the hub verbatim. This
   half *did* need a reflash — telemetry is emitted by the runtime, not by Lua,
   so no app could ever have forwarded it.

   That closes a genuinely bad loop: a pushed app that failed to compile used to
   be indistinguishable from one that worked. The push returned 200 (the relay
   delivered it — that is all it ever promised), the panel kept showing the
   previous app, and the reason lived only on a serial port. Untenable once apps
   arrive from other people, since the sender has no cable and the recipient has
   no reason to hold one.

   Verified with `device-apps/wont-compile.lua`: the Lua message arrives intact,
   with a line number — `:25: unfinished string near ''this string never
   closes'` — as does a runtime fault from `init` (`:4: attempt to index a nil
   value (local 'x')`).

   Forwarded verbatim rather than re-wrapped, and deliberately NOT routed
   through `publishEvent`: that shares a 5/s token bucket with the app's own
   `events.send`, so an app erroring in a loop would spend the budget it needs
   to report anything else. Errors must not be the thing that silences the error
   channel.

   **`set-hub.sh` now confirms by the device's own word.** This needed one more
   firmware change than expected: nothing was sent on connect, so there was
   nothing to observe after a switch — a hub reconnect doesn't reboot, so no
   boot telemetry fires either. `onConnected` now sends
   `{"type":"hello","host":…}` naming the hub the device believes it reached, via
   `sendSystem` (control plane — it must not spend the app's 5/s event budget).

   A hello that arrives AT the destination and NAMES the destination is proof in
   a way no count is: the device is the only party that knows where it landed,
   and a stale hello from a previous hub names the previous hub, so it can't be
   mistaken for a fresh arrival. Compared against a pre-send `seq` rather than a
   clock, so it doesn't depend on this machine and Cloudflare agreeing on time.

   The count heuristic survives as a **fallback**, because the proof needs an
   owner token for the destination and a destination running this hub's code —
   neither true when moving to the public relay or to a hub you don't own. The
   script says which one it used; the fallback prints its own caveat.

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
