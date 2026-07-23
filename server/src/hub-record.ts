import type { OAuthSession } from "@atproto/oauth-client"

import { getHubPublicJwk, type PublicJwkEC } from "./hub-key"

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
 * Reverse-DNS lexicon id, under a domain the hub owner demonstrably controls.
 *
 * Every participant publishes under the same NSID — discovery means reading
 * your ties' repos for this collection — so whoever owns the domain is the de
 * facto authority for the type. `tech.inanimate.*` would be the natural
 * long-term home given Poem/1 and Resident are both Matt Webb's, but claiming
 * a namespace on someone else's domain before asking is not ours to do.
 * Migration is cheap while few records exist; it gets expensive later.
 */
export const HUB_COLLECTION = "is.mfd.poem1.hub"

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

export class PdsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "PdsError"
  }
}

/**
 * XRPC through the OAuth session, which attaches DPoP-bound credentials and
 * targets the account's own PDS.
 */
async function xrpc(
  session: OAuthSession,
  nsid: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<unknown> {
  const query = init?.query ? `?${new URLSearchParams(init.query)}` : ""
  const res = await session.fetchHandler(`/xrpc/${nsid}${query}`, {
    method: init?.method ?? "GET",
    ...(init?.body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  if (!res.ok) {
    // PDS errors are JSON with error/message; fall back to the raw body.
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string }
      detail = [parsed.error, parsed.message].filter(Boolean).join(": ") || text
    } catch {
      /* not JSON — keep the raw body */
    }
    throw new PdsError(`${nsid} -> ${res.status} ${detail}`, res.status)
  }
  return text ? JSON.parse(text) : undefined
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
  const url = new URL("/xrpc/com.atproto.repo.getRecord", pds)
  url.searchParams.set("repo", did)
  url.searchParams.set("collection", HUB_COLLECTION)
  url.searchParams.set("rkey", HUB_RKEY)

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  })
  if (res.status === 400) return null // no such record
  if (!res.ok) throw new PdsError(`getRecord -> HTTP ${res.status}`, res.status)
  const out = (await res.json()) as { value?: HubRecord }
  return out.value ?? null
}
