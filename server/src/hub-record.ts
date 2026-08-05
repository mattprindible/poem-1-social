import type { OAuthSession } from "@atproto/oauth-client"

import { getHubPublicJwk, type PublicJwkEC } from "./hub-key"
import { PdsError, publicXrpc, xrpc } from "./pds"

// The hub record: one record in the owner's own atproto repo that says "this
// hub speaks for me, and here is the key it signs with".
//
// This is the keystone of the trust model in docs/social-plan.md. A single
// record does three jobs at once:
//
//   discovery      — where is this person's hub
//   authentication — which key speaks for them
//   revocation     — update or delete the record and the old key is dead
//
// That last one is why the record exists rather than atproto service auth,
// which has the right shape but no revocation and an unfinished spec.
//
// The record lives in the OWNER's repo, not the hub's storage, which is what
// makes it portable: it outlives this Worker, this hostname, and this project.
// Move the hub and you update one record.

/**
 * Reverse-DNS lexicon id, under `san.haha.computer` — a domain the project
 * owner demonstrably controls, and which publishes the schema for this type at
 * `_lexicon.san.haha.computer` (see lexicon.ts).
 *
 * Every participant publishes under the same NSID — discovery means reading
 * your ties' repos for this collection — so one party is necessarily the
 * authority for the type. That is how lexicons work rather than a
 * centralization: Bluesky's own schemas resolve to a single DID while the
 * records live in millions of separate repos. What an authority can do is stop
 * *defining*; it cannot reach into anyone's repo or interpose on any push.
 *
 * Previously `is.mfd.poem1.hub`, which was wrong twice over — a personal handle
 * for shared fabric, and one board's name on a device-agnostic type. See
 * docs/san.md.
 */
export const HUB_COLLECTION = "computer.haha.san.hub"

/** Singleton record: one hub per repo. "self" is the atproto convention. */
export const HUB_RKEY = "self"

export interface HubRecord {
  $type: typeof HUB_COLLECTION
  /** Base URL of the hub. Where other hubs send federated requests. */
  endpoint: string
  /** Public half of the hub's federation signing key. */
  publicKey: PublicJwkEC
  /** First publication, preserved across updates. */
  createdAt: string
  /** Most recent publication. */
  updatedAt: string
}

export async function readHubRecord(session: OAuthSession): Promise<HubRecord | null> {
  try {
    const out = (await xrpc(session, "com.atproto.repo.getRecord", {
      query: { repo: session.did, collection: HUB_COLLECTION, rkey: HUB_RKEY },
    })) as { value?: HubRecord }
    return out.value ?? null
  } catch (err) {
    // A repo with no such record is the normal "not published yet" case.
    if (err instanceof PdsError && err.status === 400) return null
    throw err
  }
}

/**
 * Publish (or refresh) the hub record. Idempotent: re-publishing with unchanged
 * content preserves createdAt and only moves updatedAt.
 *
 * The content is entirely hub-determined — endpoint and public key — so this
 * cannot be steered by a caller.
 */
export async function publishHubRecord(
  env: Env,
  session: OAuthSession,
  endpoint: string,
): Promise<{ record: HubRecord; uri: string; cid: string }> {
  const publicKey = await getHubPublicJwk(env)
  const existing = await readHubRecord(session).catch(() => null)
  const now = new Date().toISOString()

  const record: HubRecord = {
    $type: HUB_COLLECTION,
    endpoint: endpoint.replace(/\/$/, ""),
    publicKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  const out = (await xrpc(session, "com.atproto.repo.putRecord", {
    method: "POST",
    body: {
      repo: session.did,
      collection: HUB_COLLECTION,
      rkey: HUB_RKEY,
      record,
    },
  })) as { uri: string; cid: string }

  return { record, uri: out.uri, cid: out.cid }
}

/** Remove the hub record — the revocation path. */
export async function deleteHubRecord(session: OAuthSession): Promise<void> {
  await xrpc(session, "com.atproto.repo.deleteRecord", {
    method: "POST",
    body: { repo: session.did, collection: HUB_COLLECTION, rkey: HUB_RKEY },
  })
}

/**
 * Read someone ELSE's hub record straight from their PDS — unauthenticated,
 * because repo records are public. This is the discovery half of the trust
 * chain: resolve a DID to its PDS, then ask that PDS for their hub record.
 */
export async function fetchHubRecordFor(
  did: string,
  pds: string,
): Promise<HubRecord | null> {
  try {
    const out = (await publicXrpc(pds, "com.atproto.repo.getRecord", {
      repo: did,
      collection: HUB_COLLECTION,
      rkey: HUB_RKEY,
    })) as { value?: HubRecord }
    return out.value ?? null
  } catch (err) {
    // "They do not run a hub" is a normal answer, not a failure.
    if (err instanceof PdsError && err.status === 400) return null
    throw err
  }
}
