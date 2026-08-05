import type { OAuthSession } from "@atproto/oauth-client"

import { PdsError, publicXrpc, xrpc } from "./pds"

// Apps as records: a Lua app published into its author's own atproto repo.
//
// Before this, an app was a file on somebody's laptop and a POST body. It had no
// name, no author, no version and no history — fine for one person with a cable,
// untenable the moment apps arrive from other people, because "what is this and
// who wrote it" had no answer anywhere in the system.
//
// Publishing to the repo buys all of that from atproto rather than building it:
//
//   authorship  — repo records are signed by the author's key
//   versioning  — putRecord to the same rkey; every write is a new CID
//   history     — the repo keeps it, not us
//   portability — the library outlives this hub, this Worker, and this project
//
// And it collapses discovery into a read: finding a person's apps is listing a
// collection in their repo. No app store, no index, no central service — and
// nothing here needs an account, which is why someone can browse and follow
// builders before they own a hub or a Poem/1.
//
// Note what is deliberately NOT here: pushing. Publishing an app and putting it
// on hardware are separate acts, by separate people, at separate times. The
// federation path resolves a record to its code and sends the code (see
// federation-routes.ts) — the wire format stays frozen at {type, code}.

/**
 * Same namespace, and the same caveat, as HUB_COLLECTION in hub-record.ts:
 * `is.mfd.poem1.*` sits under a domain the hub owner controls, pending the
 * courtesy conversation about `tech.inanimate.*`.
 */
export const APP_COLLECTION = "is.mfd.poem1.app"

/**
 * Generous next to a ~6KB app, and far under any repo limit — this exists to
 * stop a runaway file becoming a record, not to ration authors.
 */
export const MAX_CODE_BYTES = 64 * 1024

export interface AppRecord {
  $type: typeof APP_COLLECTION
  /** Human-readable name. The rkey is derived from it. */
  name: string
  /** The Lua source, inline. Apps are small; a blob would buy nothing. */
  code: string
  /** Optional one-liner: what it puts on the panel. */
  description?: string
  /** First publication, preserved across updates. */
  createdAt: string
  /** Most recent publication. Moves on every edit. */
  updatedAt: string
}

/** An app record plus where it lives — what a caller needs to push or re-read it. */
export interface AppEntry {
  rkey: string
  uri: string
  cid: string
  value: AppRecord
}

export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = "AppError"
  }
}

/**
 * Derive a record key from a name.
 *
 * Name-derived rather than random (TID) so that re-publishing the same app
 * UPDATES it instead of littering the repo with near-duplicates. That is what
 * makes the repo's own history the app's version history — the property the
 * whole design is buying — and it makes an app referable as `handle/name`
 * without a lookup table.
 *
 * The cost is that renaming an app creates a new one and orphans the old rkey.
 * Correct, on balance: the rkey is the app's identity, and a thing whose
 * identity changed is a different thing.
 */
export function rkeyFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\.lua$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  if (!slug) {
    throw new AppError(`app name ${JSON.stringify(name)} has no usable characters for a record key`)
  }
  return slug
}

function assertPublishable(name: string, code: string): void {
  if (!name.trim()) throw new AppError("app name is required")
  if (!code.trim()) throw new AppError("app source is empty")
  const bytes = new TextEncoder().encode(code).length
  if (bytes > MAX_CODE_BYTES) {
    throw new AppError(`app source is ${bytes} bytes; the limit is ${MAX_CODE_BYTES}`, 413)
  }
}

/** Publish or update one app in the owner's repo. Idempotent on the rkey. */
export async function publishAppRecord(
  session: OAuthSession,
  input: { name: string; code: string; description?: string },
): Promise<AppEntry> {
  assertPublishable(input.name, input.code)

  const rkey = rkeyFor(input.name)
  const existing = await readAppRecord(session, rkey).catch(() => null)
  const now = new Date().toISOString()

  const record: AppRecord = {
    $type: APP_COLLECTION,
    name: input.name.trim(),
    code: input.code,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    createdAt: existing?.value.createdAt ?? now,
    updatedAt: now,
  }

  const out = (await xrpc(session, "com.atproto.repo.putRecord", {
    method: "POST",
    body: { repo: session.did, collection: APP_COLLECTION, rkey, record },
  })) as { uri: string; cid: string }

  return { rkey, uri: out.uri, cid: out.cid, value: record }
}

export async function readAppRecord(
  session: OAuthSession,
  rkey: string,
): Promise<AppEntry | null> {
  try {
    const out = (await xrpc(session, "com.atproto.repo.getRecord", {
      query: { repo: session.did, collection: APP_COLLECTION, rkey },
    })) as { uri: string; cid: string; value?: AppRecord }
    return out.value ? { rkey, uri: out.uri, cid: out.cid, value: out.value } : null
  } catch (err) {
    if (err instanceof PdsError && err.status === 400) return null
    throw err
  }
}

export async function listAppRecords(session: OAuthSession, limit = 100): Promise<AppEntry[]> {
  const out = (await xrpc(session, "com.atproto.repo.listRecords", {
    query: { repo: session.did, collection: APP_COLLECTION, limit: String(limit) },
  })) as { records?: { uri: string; cid: string; value: AppRecord }[] }
  return (out.records ?? []).map(toEntry)
}

export async function deleteAppRecord(session: OAuthSession, rkey: string): Promise<void> {
  await xrpc(session, "com.atproto.repo.deleteRecord", {
    method: "POST",
    body: { repo: session.did, collection: APP_COLLECTION, rkey },
  })
}

/** `at://did/collection/rkey` → the rkey on the end. */
function rkeyFromUri(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1)
}

function toEntry(row: { uri: string; cid: string; value: AppRecord }): AppEntry {
  return { rkey: rkeyFromUri(row.uri), uri: row.uri, cid: row.cid, value: row.value }
}

// ── Reading somebody else's library ──────────────────────────────────────────
// Unauthenticated, straight off their PDS. This is the discovery half, and it
// is deliberately available to anyone: no hub, no device, no account.

export async function fetchAppRecordFor(
  did: string,
  pds: string,
  rkey: string,
): Promise<AppEntry | null> {
  try {
    const out = (await publicXrpc(pds, "com.atproto.repo.getRecord", {
      repo: did,
      collection: APP_COLLECTION,
      rkey,
    })) as { uri: string; cid: string; value?: AppRecord }
    return out.value ? { rkey, uri: out.uri, cid: out.cid, value: out.value } : null
  } catch (err) {
    if (err instanceof PdsError && err.status === 400) return null
    throw err
  }
}

export async function listAppRecordsFor(
  did: string,
  pds: string,
  limit = 100,
): Promise<AppEntry[]> {
  try {
    const out = (await publicXrpc(pds, "com.atproto.repo.listRecords", {
      repo: did,
      collection: APP_COLLECTION,
      limit: String(limit),
    })) as { records?: { uri: string; cid: string; value: AppRecord }[] }
    return (out.records ?? []).map(toEntry)
  } catch (err) {
    // An empty or absent collection is "they publish no apps", not an error.
    if (err instanceof PdsError && err.status === 400) return []
    throw err
  }
}

/**
 * Parse the ways a person might name an app on the wire or a command line:
 *
 *   at://did:plc:xyz/is.mfd.poem1.app/minute-clock   full AT-URI
 *   alice.bsky.social/minute-clock                   handle and rkey
 *   minute-clock                                     rkey in your own repo
 *
 * Returns the repo as written (handle or DID, unresolved) so the caller decides
 * whether it needs resolving — a local push does not.
 */
export function parseAppRef(ref: string): { repo?: string; rkey: string } {
  const trimmed = ref.trim()
  if (!trimmed) throw new AppError("empty app reference")

  if (trimmed.startsWith("at://")) {
    const parts = trimmed.slice("at://".length).split("/")
    if (parts.length !== 3 || parts[1] !== APP_COLLECTION) {
      throw new AppError(`not an app AT-URI: ${ref} (want at://<did>/${APP_COLLECTION}/<rkey>)`)
    }
    return { repo: parts[0], rkey: parts[2]! }
  }

  const slash = trimmed.lastIndexOf("/")
  if (slash === -1) return { rkey: trimmed }
  return { repo: trimmed.slice(0, slash), rkey: trimmed.slice(slash + 1) }
}
