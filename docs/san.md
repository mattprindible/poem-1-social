# SAN — the Social Area Network

**Status:** definition agreed 2026-08-05. Nothing in this document is built yet.
It exists because the working code had drifted into assumptions nobody chose:
one hub means one device, and the record types carry a personal handle and a
single board's name. Both were fine while this was one person and one Poem/1.
Neither survives contact with the thing it is becoming.

LAN, WAN, PAN — and **SAN**, a network whose topology is a social graph. Your
devices are on it. So are your mutuals'. There is no centre.

## What a hub is

> A **hub** is one person's node in the SAN. It has exactly one **owner** (an
> atproto identity), one public **endpoint**, one federation **keypair**, and
> zero or more **claimed devices**.

The cardinalities are the part worth stating, because the code currently gets
one of them wrong:

| Relationship | Cardinality | State today |
|---|---|---|
| owner → hub | 1 : 1 | correct, and enforced (`OWNER_ITEM`) |
| hub → endpoint | 1 : 1 | correct (the hub record's `endpoint`) |
| hub → keypair | 1 : 1 | correct (`hub-key.ts`) |
| **hub → device** | **1 : N** | **wrong — the hub stores a single pointer** |
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

## The claiming gap

**This is the most consequential thing in this document, and it is a live
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

So the app record probably needs to declare what it targets, and the hub needs to
know what each claimed device is. Both are the same missing fact travelling one
hop further. **Note this half needs a reflash** — the `hello` frame is firmware —
so it should be batched with any other firmware work rather than done alone.

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

Cleanup: all five orphaned `is.mfd.poem1.*` records deleted, verified by
listing every collection in all three repos. `poem1-hub` is superseded but left
deployed for now — deleting a Worker destroys its Durable Objects, and nothing
depends on it (the device's own fallback is the public relay, not this).

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

### 2. Device claiming

The security gap. Independent of naming, so it can run in parallel, but it is
the one that should not wait.

### 3. Many devices per hub

Depends on claiming — a claim is what makes membership meaningful. Smaller than
it looks: `DEVICE_ITEM` in `federation-routes.ts` is a single stored string, and
upstream's relay is already per-device (a Durable Object each, keyed by device
ID). The work is the hub's bookkeeping and addressing, not the transport.

Open sub-question: when a mutual pushes to you and you have four devices, which
one receives it? The sender must not choose — a sender never learns a device ID
today, and that should not change. Likely a per-hub default plus an owner-set
policy, but this is undecided.

### 4. Device type, end to end

Firmware `hello` carries `deviceType`; the hub records it per claimed device; the
app record gains a target field; pushes to a mismatched device warn or refuse.
**Needs a reflash** — batch accordingly.

### 5. Verbiage

Cheap, mechanical, do alongside whatever else is open:

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

Every hub is named for the identity that owns it, never for a board. Suite 6/6
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
