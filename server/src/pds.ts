import type { OAuthSession } from "@atproto/oauth-client"

// Talking to a PDS, in the two modes this project needs.
//
//   authenticated — through the owner's OAuth session, to write THEIR repo
//   public        — plain fetch against any PDS, to read ANYONE's repo
//
// The asymmetry is the whole point of building on atproto: writing needs a
// credential, reading needs nothing at all. Discovery in docs/social-plan.md is
// pure public reads, which is why it works for someone who has never signed
// into a hub and does not own a device.
//
// Extracted from hub-record.ts when app records arrived and needed the same
// error handling. One implementation, so a PDS error reads the same wherever it
// surfaced.

export class PdsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "PdsError"
  }
}

/** Pull `error: message` out of a PDS error body, falling back to raw text. */
function detailFrom(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string }
    return [parsed.error, parsed.message].filter(Boolean).join(": ") || text
  } catch {
    return text
  }
}

/**
 * XRPC through the OAuth session, which attaches DPoP-bound credentials and
 * targets the account's own PDS.
 */
export async function xrpc(
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
  if (!res.ok) throw new PdsError(`${nsid} -> ${res.status} ${detailFrom(text)}`, res.status)
  return text ? JSON.parse(text) : undefined
}

/**
 * Delete any record from the signed-in account's own repo.
 *
 * Collection is a parameter rather than a constant on purpose — it is the one
 * operation that has to outlive a namespace change, because everything pinned
 * to a constant loses its grip on the old records the moment that constant
 * moves.
 */
export async function deleteRepoRecord(
  session: OAuthSession,
  collection: string,
  rkey: string,
): Promise<void> {
  await xrpc(session, "com.atproto.repo.deleteRecord", {
    method: "POST",
    body: { repo: session.did, collection, rkey },
  })
}

/**
 * Unauthenticated XRPC against someone else's PDS. Repo records are public, so
 * reading a stranger's hub or app records needs no account and no API key.
 *
 * Timed out rather than left to hang: a peer's PDS is infrastructure we do not
 * run, and a federated push should fail fast instead of holding a Worker
 * request open on a host that has gone away.
 */
export async function publicXrpc(
  pds: string,
  nsid: string,
  query: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`/xrpc/${nsid}`, pds)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)

  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  })
  const text = await res.text()
  if (!res.ok) throw new PdsError(`${nsid} -> ${res.status} ${detailFrom(text)}`, res.status)
  return text ? JSON.parse(text) : undefined
}
