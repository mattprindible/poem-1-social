import { getHubKey } from "./hub-key"
import { fetchHubRecordFor } from "./hub-record"
import { NS, hubStore } from "./hub-store"
import { resolveIdentity } from "./identity"

// Hub-to-hub trust.
//
// This is the bet in docs/social-plan.md made concrete: a mutual follow on
// Bluesky is treated as enough trust to run code on someone's physical device.
//
// Two independent checks, and BOTH must pass:
//
//   1. Did this really come from that DID?  — signature verified against the
//      public key in the sender's own published hub record.
//   2. Is that DID a mutual of ours?        — the live social graph.
//
// (1) without (2) means any stranger with a hub could push. (2) without (1)
// means anyone can claim to be your mutual by putting their DID in a header.
//
// Note what this does NOT change: social trust sets *policy* (who may push),
// never *mechanism* (what pushed code can do). The Lua sandbox, driver
// allowlists and e-ink flip limits are untouched, and the device's hold-to-stop
// escape hatch works regardless of who sent the app.

export const SIG_HEADER = "x-san-signature"
export const SENDER_HEADER = "x-san-sender"
export const KEY_ID_HEADER = "x-san-key-id"
export const TIMESTAMP_HEADER = "x-san-timestamp"
export const NONCE_HEADER = "x-san-nonce"

/**
 * How far out of step a request's clock may be. Generous enough for ordinary
 * skew, tight enough that a captured request stops being useful quickly. Paired
 * with nonce tracking, since a freshness window alone permits replay *within*
 * the window.
 */
const MAX_SKEW_MS = 5 * 60 * 1000

const encoder = new TextEncoder()

export class FederationError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message)
    this.name = "FederationError"
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * What actually gets signed.
 *
 * The recipient DID is included so a request captured by one hub cannot be
 * replayed at another — the signature is bound to a specific destination, not
 * just to a payload.
 */
async function signingInput(opts: {
  sender: string
  recipient: string
  timestamp: string
  nonce: string
  body: string
}): Promise<Uint8Array> {
  const bodyHash = await sha256Hex(opts.body)
  return encoder.encode(
    [opts.sender, opts.recipient, opts.timestamp, opts.nonce, bodyHash].join("\n"),
  )
}

/** Headers proving this request came from our hub's owner. */
export async function signOutbound(
  env: Env,
  opts: { sender: string; recipient: string; body: string },
): Promise<Record<string, string>> {
  const { privateJwk, publicJwk } = await getHubKey(env)
  const timestamp = Date.now().toString()
  const nonce = crypto.randomUUID()

  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const data = await signingInput({ ...opts, timestamp, nonce })
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data)

  return {
    "Content-Type": "application/json",
    [SENDER_HEADER]: opts.sender,
    [KEY_ID_HEADER]: publicJwk.kid,
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIG_HEADER]: toBase64Url(new Uint8Array(sig)),
  }
}

/**
 * Verify an inbound hub-to-hub request.
 *
 * Returns the sender's DID once the signature checks out against the key that
 * sender publishes in their OWN repo. Anyone can claim a DID in a header; only
 * the holder of the key named by that DID's hub record can sign for it.
 */
export async function verifyInbound(
  env: Env,
  request: Request,
  bodyText: string,
  recipientDid: string,
): Promise<string> {
  const sender = request.headers.get(SENDER_HEADER)
  const signature = request.headers.get(SIG_HEADER)
  const timestamp = request.headers.get(TIMESTAMP_HEADER)
  const nonce = request.headers.get(NONCE_HEADER)
  const keyId = request.headers.get(KEY_ID_HEADER)

  if (!sender || !signature || !timestamp || !nonce) {
    throw new FederationError("missing federation headers", 400)
  }

  const age = Math.abs(Date.now() - Number(timestamp))
  if (!Number.isFinite(age) || age > MAX_SKEW_MS) {
    throw new FederationError("stale or invalid timestamp", 401)
  }

  // Replay protection within the freshness window. Kept only as long as a
  // request could still be considered fresh; after that the timestamp check
  // rejects it anyway, so retaining the nonce buys nothing.
  const store = hubStore(env)
  const seenKey = `${sender}:${nonce}`
  if (await store.getItem(NS.nonce, seenKey)) {
    throw new FederationError("replayed request", 409)
  }

  // The sender's key comes from THEIR repo, not from the request. That is the
  // whole point: the request cannot vouch for itself.
  const identity = await resolveIdentity(sender)
  const record = await fetchHubRecordFor(identity.did, identity.pds)
  if (!record) {
    throw new FederationError(`${sender} publishes no hub record — cannot verify`, 403)
  }
  if (keyId && record.publicKey.kid !== keyId) {
    throw new FederationError(
      `key id ${keyId} does not match the key published by ${sender} ` +
        `(${record.publicKey.kid}) — the key may have been rotated`,
      403,
    )
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    record.publicKey as unknown as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  const data = await signingInput({
    sender: identity.did,
    recipient: recipientDid,
    timestamp,
    nonce,
    body: bodyText,
  })
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(signature),
    data,
  )
  if (!ok) throw new FederationError("signature does not verify", 403)

  await store.setItem(NS.nonce, seenKey, "1", MAX_SKEW_MS)
  return identity.did
}

export interface Relationship {
  following: boolean
  followedBy: boolean
  mutual: boolean
}

/**
 * Ask the Bluesky AppView whether two accounts follow each other.
 *
 * This is the one piece of centralization the design cannot remove: every
 * self-hosted hub asks one hosted aggregator who its owner trusts. It is free,
 * public and cacheable, but if Bluesky ever gates these endpoints, every hub in
 * the network is affected at once. Treated as advisory state, not live truth.
 */
export async function getRelationship(
  ownerDid: string,
  otherDid: string,
): Promise<Relationship> {
  const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.graph.getRelationships")
  url.searchParams.set("actor", ownerDid)
  url.searchParams.append("others", otherDid)

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) {
    throw new FederationError(`graph lookup failed: HTTP ${res.status}`, 502)
  }
  const data = (await res.json()) as {
    relationships?: { following?: string; followedBy?: string }[]
  }
  const rel = data.relationships?.[0]
  // `following` / `followedBy` are present as at:// URIs of the follow records
  // when the relationship exists, and absent when it does not.
  const following = Boolean(rel?.following)
  const followedBy = Boolean(rel?.followedBy)
  return { following, followedBy, mutual: following && followedBy }
}

/** Strong tie = mutual follow. Anything less may not push code. */
/**
 * `action` only changes the wording. The refusal always names the RELATIONSHIP
 * — that is the part the suite asserts on, and the part that says why. But a
 * capabilities probe being refused for "only mutuals may push apps" describes
 * the wrong operation to whoever reads it, and a message that misdescribes what
 * was refused is a small lie in the place people go when confused.
 */
export async function requireMutual(
  ownerDid: string,
  senderDid: string,
  action = "push apps",
): Promise<Relationship> {
  const rel = await getRelationship(ownerDid, senderDid)
  if (!rel.mutual) {
    throw new FederationError(
      `${senderDid} is not a mutual of ${ownerDid} ` +
        `(following: ${rel.following}, followedBy: ${rel.followedBy}) — ` +
        `only mutuals may ${action}`,
      403,
    )
  }
  return rel
}
