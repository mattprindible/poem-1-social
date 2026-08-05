# SAN — the Social Area Network

**Status:** definition agreed 2026-08-05. **All six stages are built and
verified on hardware** — namespace and lexicon, device claiming, many devices
per hub, device identity and self-description, discovery by probing, and the
naming sweep.

Three things followed from putting a real app on a real wall rather than
reasoning about it: the **twin** (the device describes its own composition, and
the simulator can become it), **liveness** (a firmware heartbeat, and a contract
the device declares rather than one the hub assumes), and **link diagnostics**
(silence now carries its own cause). Those are folded into the stages below.

It exists because the working code had drifted into assumptions nobody chose:
one hub means one device, and the record types carried a personal handle and a
single board's name. Both were fine while this was one person and one Poem/1.
Neither survives contact with the thing it is becoming. Writing the definition
down first is what turned those into a list of edits rather than a debate.

LAN, WAN, PAN — and **SAN**, a network whose topology is a social graph. Your
devices are on it. So are your mutuals'. There is no centre.

## What a hub is

> A **hub** is one person's node in the SAN. It has exactly one **owner** (an
> atproto identity), one public **endpoint**, one federation **keypair**, and
> zero or more **claimed devices**.

The cardinalities are the part worth stating, because the code originally got
one of them wrong — a hub held a single device pointer. All four now hold:

| Relationship | Cardinality | State today |
|---|---|---|
| owner → hub | 1 : 1 | correct, and enforced (`OWNER_ITEM`) |
| hub → endpoint | 1 : 1 | correct (the hub record's `endpoint`) |
| hub → keypair | 1 : 1 | correct (`hub-key.ts`) |
| **hub → device** | **1 : N** | correct as of 2026-08-05 (`devices.ts`) |
| device → hub | N : 1 | correct: a device holds one socket, to its owner's hub |

A device belongs to exactly one hub at a time. A hub carries as many devices as
its owner has. That asymmetry is deliberate — it is what makes "your stuff" a
coherent thing to publish to a social graph.

### What a hub is NOT

- **Not a device.** It is the thing devices are claimed *to*. A hub with no
  devices is perfectly valid — it can still publish apps and push to mutuals,
  which is how someone participates before they own hardware.
- **Not Poem/1-specific.** Resident runs on ESP32 boards generally; upstream
  ships examples for an M5StickC Plus2 and an Adafruit Feather, and this repo
  already has a second device (the M5StickS3 in `voice/`). The Poem/1 is one
  board on the network, not the network.
- **Not a server other people log into.** It holds one owner's credentials and
  one owner's devices. Federation is hub-to-hub, never user-to-hub.

## Naming

The authority for everything this project defines is **`san.haha.computer`**, a
domain the project owner controls and Cloudflare manages.

That makes the lexicon NSIDs — atproto reverses the authority domain:

| Today | Becomes |
|---|---|
| `is.mfd.poem1.hub` | `computer.haha.san.hub` |
| `is.mfd.poem1.app` | `computer.haha.san.app` |

Two things were wrong with the old namespace, on separate axes. `is.mfd.*` is a
**personal handle**, which is the wrong shape for something other people's
software is meant to depend on. And `poem1` names **one board** in a type that
describes a sandbox app, which contradicts the definition above.

**"Resident" does not appear in any NSID, URL, or wire identifier.** Resident is
someone else's project; naming our public surfaces after it would be claiming
something we have not been given. Referring to it in prose and code comments is
fine and correct — it is the dependency, and saying so plainly is the point.
This is the same courtesy reasoning that kept us off `tech.inanimate.*`, applied
one level further out.

### Why a single authority is right, and not centralization

Worth stating because it looks like a contradiction: if every hub publishes
`computer.haha.san.app` records, isn't one domain now load-bearing for everyone?

Yes — and that is how lexicons are supposed to work. Bluesky's own schemas
resolve to exactly one place:

```
_lexicon.feed.bsky.app   → did=did:plc:4v4y5r3lwsbtmsxhile2ljac
_lexicon.graph.bsky.app  → did=did:plc:4v4y5r3lwsbtmsxhile2ljac
```

Millions of accounts publish `app.bsky.feed.post` records into their **own**
repos under a schema Bluesky defines. The data is decentralized; the *schema*
has an owner, which is what stops everyone inventing incompatible types and is
precisely what makes it fabric.

What a shared authority can do is stop *defining* — it cannot reach into
anyone's repo, revoke anyone's records, or interpose on any push. Records
already published keep validating against a schema you have a copy of. That is a
much weaker dependency than the hosted-aggregator one this project already
accepts for the social graph, and unlike that one it has an exit: republish
under a new authority and update one DNS record.

### Publishing the lexicon

Two steps, and one DNS record covers every `computer.haha.san.*` type:

1. **DNS** — `_lexicon.san.haha.computer` TXT → `did=<the DID holding the
   schemas>`
2. **Records** — a `com.atproto.lexicon.schema` record per type, in that DID's
   repo, with the **NSID as the record key**

Resolution then runs DNS TXT → DID → PDS → record, which is what makes a
third-party tool able to *validate* our records rather than just pretty-print
them. Note the DID in step 1 is only a pointer: the **domain** is the authority,
so the schemas can move repos later without the NSID changing.

**DONE 2026-08-05.** The TXT record exists and both schemas resolve — verified
from a hub that owns none of it, and again by hand from cold DNS.

The authority DID is **`did:plc:pyp36qey354yxslrcavwzqja`** — the account that
*is* `haha.computer` — not the project owner's personal `mfd.is`. The domain is
what confers authority, so either would have worked mechanically; pointing at
the domain's own identity keeps the fabric from being anchored to a personal
handle, which is the whole reason the namespace moved in the first place.

**Handle verification is irrelevant here, which is worth stating because it
looks like it should matter.** At the time of writing, `haha.computer` is only
half-migrated as a handle: the `_atproto` TXT record points at that DID, but the
DID document's `alsoKnownAs` still says `hahacomputer.bsky.social`, so the
handle does not verify bidirectionally. It makes no difference. Lexicon
resolution goes DNS → **DID** → PDS and never resolves a handle at all;
`resolveIdentity` given a DID goes straight to the DID document. Finishing the
handle migration is worth doing for how the account *displays*, and changes
nothing about whether the schemas resolve.

## The claiming gap — CLOSED 2026-08-05

**Fixed.** `server/src/device-gate.ts` runs ahead of upstream's relay router and
refuses what the relay used to accept. `relay-closed` in the suite asserts both
halves: an anonymous push is refused, and an id this hub does not carry is
refused *even with* the owner's credential — otherwise a hub is an open relay
onto other people's devices for its own owner.

Read the rest of this section as the statement of the problem; it is kept
because the reasoning still governs what "claimed" has to mean.

**What the gate alone buys:** an unclaimed id gets nothing, so nobody can squat
an arbitrary id or use somebody's hub as an open relay, and pushing requires the
owner. What it cannot do is tell a device from someone who read its id off the
screen — that is stage 4, whose hub half now exists.

**Closed on the hardware too, 2026-08-05.** The Poem/1 holds its own key and is
off the legacy path permanently — binding is one-way, so it cannot be downgraded
by a socket that merely knows the id.

The original text follows.

---

**This was the most consequential thing in this document, and it was a live
security hole, not a design nicety.**

The word "claimed" in the definition above describes nothing that currently
exists. A hub stores one device ID as a federation target; it never gates
anything. Verified against the live hub on 2026-08-05:

```
POST /devices/fccf2990/send   (no credential)  →  200 OK
POST /devices/deadbeef/send   (no credential)  →  503 Device not connected
```

Anyone who knows a device ID and a hub URL can push code to that device. Hub
URLs are published in atproto repos by design, and a device ID is printed on the
device's own screen. This is the same property the README criticises the public
relay for — running your own hub changed *who hosts the relay*, not whether it
authenticates.

The federation path is genuinely authenticated (signature + mutual-follow, and
`test-federation.sh` proves the refusals). It is a locked side door on a building
whose front door is open. Every claim this project makes about social trust
setting policy is undermined by a push path that asks for no policy at all.

Note what this does **not** undermine: the device-side mechanism holds regardless
— the Lua sandbox, the driver allowlist, the flip limits, and the 3-second
hold-to-stop all work against a hostile push from any source. The exposure is
"anyone can put things on your screen", not "anyone can take your Wi-Fi
credentials".

**Claiming, once it exists, should mean:** a device is bound to a hub by an act
the owner authorizes; the relay refuses traffic for devices that are not claimed;
and pushes to a claimed device require an owner credential or an inbound
federation identity that passes the mutual check. That is also what makes a
*set* of devices meaningful rather than a list of pointers.

## Devices are not interchangeable

A second thing multi-device surfaces, easy to miss: **apps are not portable
across boards.** From a real published record:

```lua
screen.rect(30, 30, 900, 480)
screen.text(70, 460, "tick " .. ticks, 2, 0)
```

That is Poem/1 panel geometry. Pushed to the M5StickS3 it compiles cleanly and
renders as garbage — the worst failure mode available, because the error channel
reports success.

The firmware already knows what it is (`cfg.deviceType = "poem1"` in
`device/src/main.cpp`), and Resident carries `deviceType` as a first-class config
field. It simply never reaches the hub: the `hello` frame sends `host`, `stored`
and `fellback`, and not the type.

So the app record probably needs to declare what it targets, and the hub needs
to know what each claimed device is. Both are the same missing fact travelling
one hop further.

**The hub half is done** — the device reports its display in its twin (stage 4),
and a mutual can probe for the shape before writing. What is still missing is the
other end: an app record carries no target, so nothing yet refuses a push that
would render as garbage. That is the open piece.

## Staged migration

Ordered by dependency, not by size. Nothing here is started.

### 1. Namespace and lexicon — DONE 2026-08-05

Done as a clean rebuild rather than an in-place edit: a new worker (`mfd-hub`,
named for the identity it belongs to rather than for a board), fresh secrets,
fresh OAuth claim, device moved over the air. Suite 6/6 afterwards, with the
device confirming its own arrival by naming the destination hub.

That rebuild was worth more than the migration it carried, because it walked the
onboarding path nobody had walked since the project began — and immediately
found that the **documented setup command was broken**: `npm run gen-key |
wrangler secret put` pipes npm's banner into the secret, so the hub reports
`HUB_PRIVATE_JWK is not valid JSON` behind a 503 that reads like a deploy
failure. Fixed in both READMEs. This is the argument for rehearsing onboarding
rather than reasoning about it.

Cleanup, finished 2026-08-05: all five orphaned `is.mfd.poem1.*` records
deleted, verified by listing every collection in every repo; the three
superseded workers (`poem1-hub`, `poem1-hub-haha`, `poem1-hub-idiot`) deleted,
along with their now-dead keychain tokens. Suite 6/6 afterwards and the device
still reporting on `mfd-hub`.

Deletion was left until last on purpose. Removing a Worker destroys its Durable
Objects irreversibly, so it should follow the evidence that nothing needs them —
every hub record repointed, every hub reclaimed, a green suite — rather than
precede it.

Original reasoning, kept: first, because cost grows with every record published
under the old NSID, and because the schema cannot be published until the type is
named.

- New constants: `computer.haha.san.hub`, `computer.haha.san.app`
- DNS TXT (owner action, one record)
- `com.atproto.lexicon.schema` records for both types
- Republish the hub record for all three hubs, and the two app records

**Coordinated cutover is available and should be used.** Federation resolves a
peer's hub record by NSID, so a hub that migrated cannot see one that has not —
normally that would force a dual-read compatibility window. All three hubs are
the same person's, so they can simply be cut over together. If that stops being
true, dual-read becomes mandatory before anyone else joins.

### 2. Device claiming — DONE 2026-08-05

`device-gate.ts` in front of upstream's router, because everything under
`/devices/` is forwarded straight into the Durable Object and there is no seam
inside it to hook without forking Resident.

The surface turned out wider than `/send`. Three things live under
`/devices/<id>`, and the easiest to miss was the dangerous one: a **monitor**
WebSocket (`?monitor=1`), which upstream broadcasts every relayed message to. It
is a live read channel on the device, it is not a write, and it does not look
like anything. Owner-only now, as is the bare `GET` — that one is a presence
oracle for anyone probing device ids.

### 3. Many devices per hub — DONE 2026-08-05

Came free with claiming, as predicted: a registry is what a claim needs, and a
registry is what many-devices needs. `/hub/devices` claims, lists and releases;
the old single-device key migrates itself on first read, so a hub that has been
relaying for weeks does not lose its device — or worse, have it refused by the
new gate.

**The sub-question is answered: a per-hub DEFAULT, chosen by the recipient.**
The sender must not pick, because a sender never learns a device id and that
should not change. A lone device is the default without anyone saying so, which
keeps the common case free of a setup step whose purpose nobody would guess.

### 4. Device identity and self-description — DONE 2026-08-05

**BUILT AND VERIFIED ON HARDWARE 2026-08-05.** The Poem/1 (`fccf2990`) generates
its own P-256 key, keeps it in NVS, and proves it per connection. Its serial log
printed fingerprint `ea3116` and the hub bound `ea3116` — the out-of-band
confirmation the design asked for, matching first try.

The decisive test, on real hardware: an impostor attached to the SAME device id
alongside the genuine device, and a push was sent. The device received and
compiled it; the impostor saw **zero frames**. Wrong-key connections are closed
outright.

Original note follows. `device-identity.ts` issues a per-connection challenge,
verifies a P-256 signature, and binds a key during an owner-opened pairing
window. `tools/fake-device.mjs` is the stand-in, and the suite's
`device-identity` case asserts an impostor key is refused and a SILENT impostor
receives nothing.

Migration is one-way by design: a device with **no** bound key still connects as
before, so deploying this broke no running hub — but once a key is bound, that
device can never fall back to unauthenticated. Re-pairing clears the old key,
which is how a reflashed or factory-reset device gets back in.

The design follows.

Two changes that both need the firmware, so they ship as one reflash.

**Why they belong together.** The gate can tell a claimed id from an unclaimed
one, but it cannot tell a device from someone who read its id off the screen.
And the hub's idea of *what* a device is currently comes from the owner typing
`--type m5stick`. Both are the same shape of problem: the network holds beliefs
about itself that nothing verifies. A device that can prove who it is can also be
believed about what it is — identity is what makes self-description worth
anything.

#### Identity: a key the device generates and never sends

The device generates a P-256 keypair on first boot and keeps the private half in
NVS. It never leaves the device. P-256 because mbedtls has it on the ESP32-S3
and the hub already speaks ES256 for federation — one curve, one set of
mistakes to avoid.

Not a shared secret issued by the hub. A secret has to be *delivered*, which
means either a per-device build (the thing runtime hub config exists to avoid)
or a provisioning channel that is itself unauthenticated. A device-generated key
needs no delivery at all: one firmware image for everybody, and the private half
never crosses a wire.

Handshake, using machinery that already exists — `onMessageWithChannel("system")`
for inbound and `sendSystem` for outbound:

```
device connects  ──▶  hub: challenge (random nonce, per connection)
device signs the nonce with its key
              ◀──     hub verifies against the key bound to this device id
```

A per-connection nonce is what makes it a proof rather than a password. A
replayed `hello` is worthless because the nonce it signed will never be issued
again. Until a connection is verified it is quarantined: it receives no pushes
and its frames are not recorded as the device's word.

#### Pairing: how the hub learns the key

**Trust on first use, inside a window the owner opens.** The hub has no key for
a new device, so someone has to say "this one is mine". The owner opens a
pairing window; the first device presenting a key for that id during the window
gets bound; every later connection must match. The device also draws its key
fingerprint on its own screen, so the owner can confirm out of band that the key
the hub bound is the key the device holds.

Why not permanent TOFU with no window: a device that reconnects constantly gives
an attacker many chances to be first, and "first" is not a property anyone can
observe after the fact. A window makes the risky moment short and deliberate.

#### Self-description: the TWIN — BUILT 2026-08-05

The device reports its own **composition** on the identify frame (not `hello` —
self-description must ride on a frame that has been *proved*): board type,
firmware build, display, the drivers `main.cpp` wired up, and a declared
liveness contract. The hub records it against the claimed device, replacing the
owner-declared `deviceType` with the device's own account of itself.

Composition, not curation. The first version hand-picked `deviceType` and
`screen`, which meant deciding in advance what every future consumer would need
— and being wrong. A twin lets the hub project whatever view it requires.

**One artifact, two consumers**, which is what earns it:

```
device emits twin ──┬──▶ hub: discovery, per-device knowledge
                    └──▶ tools/fake-device.mjs --from: BE that board
```

`./apps.sh twin <id>` exports it. The simulator then stops drifting from the
hardware it stands in for — and drift is exactly where the two bugs of
2026-08-05 hid.

No Resident version is reported: the library exposes neither a macro nor an
accessor, and a hardcoded copy would go on claiming 0.7.0 after the next
`./sync.sh`. Better to omit a fact than publish a stale one.

This also fixes a real failure mode noted above: Lua written for a Poem/1 panel
compiles cleanly on an M5Stick and renders garbage, with the error channel
reporting success. A push can only be checked for compatibility if something
knows what the target actually is.

#### What the twin deliberately does NOT carry

**Power source.** Wall or battery is a *deployment* fact, not a firmware one —
the same binary runs either way, and this Poem/1 has a battery ADC while living
on wall power. Anything inferring portability from composition would be wrong
about the very device it is describing.

**Anything an agent could "just infer."** Inference produces a belief, and
beliefs are what this project spent a day replacing with asking. If the device
knows, the device says.

The twin also stays **hub-local**. Nothing device-related is written to a PDS,
and the capability probe remains a live *projection* answered to mutuals. A
published twin would make the exposure richer and permanent rather than
smaller — obscurity is not privacy.

#### Liveness — BUILT 2026-08-05

`liveness: { expect, heartbeatSec }` is **declared**, for the reasons above. The
heartbeat is emitted by the FIRMWARE from `loop()`, never by Lua, and that is
the whole design: an app that wedges the Lua VM stops the beat with it, which is
the one failure nothing else can see — a wedged app with a live socket looks
exactly like a calm app with nothing to say.

Heartbeats are kept as a timestamp, not ring entries; one every 30s would evict
an hour of real history within the hour.

**A device that declares nothing gets no judgement at all.** Not a default of
"assume persistent", which would report every sleepy board and every device on
older firmware as broken. Silence is evidence only when something promised not
to be silent. This is the single most important line in the section.

#### Diagnosing silence

The ring records the link itself — `link_up` / `link_down` with the close code —
so silence has a cause written next to it rather than needing a theory:

| Pattern | Means |
|---|---|
| `app_received`, `link_down 1006` | the socket died; the app may be fine |
| `app_received`, `compile_error` | the app failed; the link is fine |
| `link_down 1008 verified=false` | **we** refused it, on identity |
| `link_up` with no preceding `link_down` | the **hub** restarted (a deploy tears the DO down first) |

Measured while building this, and worth recording because it disproved the
theory that motivated it: the hub tolerates a **20-second** client block without
dropping the socket, and an 8-second delay before answering the identity
challenge still verifies. So the connection loss of 2026-08-05 was initiated
device-side, not by Cloudflare giving up. The cause remains unknown, and saying
so is better than repeating a guess.

### 5. Discovery: probe, do not remember — BUILT 2026-08-05

The half that makes the rest matter. **A hub should never hold a cached belief
about what a mutual has; it should ask.** Beliefs go stale silently — someone
retires a board, adds one, changes what they run — and a stale belief is worse
than no belief because it is acted on with confidence.

So: `GET /federation/capabilities`, answered live, signature-authenticated the
same way `/federation/inbox` is, and available to **mutuals only**.

**It returns device PROFILES, never device ids or counts.** A device id is a
credential on the relay, and nothing about discovery justifies moving one
between hubs — the property that federation has protected from the start. What a
sender legitimately needs is "will an app shaped like this work on anything you
have", and that is answerable without naming a single device:

```json
{ "profiles": [ { "deviceType": "poem1", "screen": {"w": 960, "h": 540, "colors": 2} } ] }
```

Mutuals only, because what hardware someone owns is theirs to disclose. A mutual
can already push code to your device; learning what shape to push is strictly
less than that, and refusing it would only mean they push blind.

Nothing is cached anywhere. Not "short TTL" — none. A cache here would be a
belief with a timer on it, and the failure it invites (acting confidently on a
board someone retired) is exactly what the stage is against.

**Deduplication is a privacy property, not tidiness.** A list that did not
collapse identical devices would be a device count. Verified: four devices on a
peer's hub, three profiles returned, and the response carries only
`deviceType`, `screen` and `source` — no ids, no names, no keys. The suite's
`discovery` case asserts all of it, including that a non-mutual is refused.

`source` is kept rather than smoothed away: "the device says it is a Poem/1" and
"someone typed poem1" are different claims, and a peer choosing what to push
should be able to tell which one it got.

### 6. Verbiage — DONE 2026-08-05

Headers, cookie, `client_name`, page title and every worker name are changed;
each worker is now named for the identity that owns it.

Sweeping for leftovers afterwards was worth doing — it turned up a **stale NSID
in `apps.sh`'s own help text**, still telling people to write
`at://…/is.mfd.poem1.app/…`. Docs that describe an interface rot exactly like
code, and nothing type-checks a comment.

What deliberately still says `poem1`, and why:

- **`poem1-hub-admin`, the keychain SERVICE name.** Renaming it would orphan
  every token already stored on this machine, and Cloudflare secrets are
  write-only — so the tokens could not be re-derived, only regenerated across
  every hub. A cosmetic rename is not worth that. The *account* within the
  service is the worker name, which is where the real identity lives.
- **`sync.sh` and the firmware.** That script really is Poem/1-specific: it
  pins a MAC, guards a panel, and builds one board's binary. Naming it
  accurately is correct, not leftover.
- **Prose naming the board or the sandbox library.** Both are real things this
  project depends on and should be called what they are. The rule was never to
  scrub the words — it is that they must not appear in an NSID, a URL, or a wire
  identifier.

| Identifier | Where |
|---|---|
| `x-poem1-*` federation headers | `federation.ts:25-29` |
| `poem1_hub_session` cookie | `auth.ts:27` |
| `client_name: "Poem/1 Social hub"` | `oauth.ts:54` (shown on the OAuth consent screen) |
| `<title>Poem/1 hub</title>` | `oauth-routes.ts:21` |
| worker name `poem1-hub` | `wrangler.jsonc`, `package.json` |
| `.resident-hub-url`, `.resident-device-id` | repo root — local dotfiles, not URLs; renaming is optional and cosmetic |

The federation headers are wire protocol, so in principle they are a
compatibility concern. In practice all three hubs are the same person's, which
makes this the last cheap moment to change them.

## The cast — settled 2026-08-05

| Identity | Hub | Role |
|---|---|---|
| `mfd.is` | `mfd-hub` | owns the device (`fccf2990`); recipient in every case |
| `idiot.town` | `idiot-hub` | **mutual** — may push |
| `noitsrusty.bsky.social` | `rusty-hub` | follower, not followed back — **may not** |
| `san.haha.computer` | `san-hub` | **authority.** No follows either way, and **no hub record** |

Every hub is named for the identity that owns it, never for a board. Suite 9/9
on this cast.

**Rusty exists only to be refused**, and that is a real fixture rather than a
spare account. The negative cases are the entire security claim, so they need a
sender holding the awkward relationship *on purpose and permanently*. Following
it back would silently convert the load-bearing refusal test into a second copy
of the positive one, and everything would still pass — which is why the suite
header says so out loud.

It needs a hub despite never succeeding, because `/federation/push` resolves the
recipient's hub record **before** the mutual check: a sender with no hub record
fails at `no_hub` and never reaches the graph logic the case exists to test.

**The authority is not a participant.** `san.haha.computer` holds zero follows
in either direction and publishes **no** hub record — a hub record says "I am a
peer, push to me", which the authority is not. Its hub still exists as a private
admin tool for managing the lexicon schemas.

That separation is worth having demonstrated rather than assumed: after deleting
the record, `/hub/peer/san.haha.computer` reports *"they are not running a hub"*
while both schemas still resolve. **Schema authority and network participation
are independent** — which is exactly what makes a shared lexicon fabric rather
than a hub everyone has to trust.

## Knock-on: the test identities

`test-federation.sh` defaults to `hahacomputer.bsky.social` as the mutual. If
that handle is retired in favour of something under `haha.computer`, the suite's
defaults and the mutual-follow relationship both need updating — and the DID
stays the same through a handle change, so the hub records and keys survive.
Handle changes are cheap in atproto; this is bookkeeping, not migration.
