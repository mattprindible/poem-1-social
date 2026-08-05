import {
  APP_COLLECTION,
  AppError,
  type AppEntry,
  deleteAppRecord,
  fetchAppRecordFor,
  listAppRecords,
  listAppRecordsFor,
  parseAppRef,
  publishAppRecord,
  readAppRecord,
} from "./app-record"
import { IdentityError, resolveIdentity } from "./identity"
import { PdsError } from "./pds"
import { describeError, ownerSession } from "./oauth-routes"
import { AuthError, requireOwner } from "./auth"

// The app library, as HTTP.
//
// One grammar for naming an app, used by every route here and by the push
// paths in federation-routes.ts:
//
//   minute-clock                   an app in YOUR repo
//   alice.bsky.social/minute-clock an app in THEIRS
//   at://did:plc:…/computer.haha.san.app/minute-clock   the same, fully qualified
//
// Reads are open; writes need the owner. That split is not laziness — it is the
// design. A repo record is public the moment it is published, so gating reads
// would protect nothing while breaking the property that matters most: anyone
// can browse a builder's apps without a hub, a device, or an account.
//
// No HTML. This hub has a login page and nothing else by design (see the note
// in README.md) — the library is meant to be driven by an agent or a script,
// and JSON is the surface for both.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

/** Strip `code` for listings — a library index should not be megabytes of Lua. */
function summarize(entry: AppEntry) {
  const { code, ...rest } = entry.value
  return {
    rkey: entry.rkey,
    uri: entry.uri,
    cid: entry.cid,
    bytes: new TextEncoder().encode(code).length,
    ...rest,
  }
}

/**
 * Resolve an app reference to the record it names, wherever it lives.
 *
 * Shared with the push paths, which is the point: "push minute-clock" and
 * "push alice's minute-clock" differ only in what this returns. A reference
 * with no repo means the owner's own library and needs their session; one with
 * a repo is a public read off a stranger's PDS and needs nothing.
 */
export async function resolveAppRef(
  env: Env,
  origin: string,
  ref: string,
): Promise<{ entry: AppEntry; author: string }> {
  const { repo, rkey } = parseAppRef(ref)

  if (!repo) {
    const { session, owner, error } = await ownerSession(env, origin)
    if (error) throw new AppError("this hub has no owner, so it has no app library", 409)
    const entry = await readAppRecord(session!, rkey)
    if (!entry) throw new AppError(`no app "${rkey}" in your library`, 404)
    return { entry, author: owner! }
  }

  const identity = await resolveIdentity(repo)
  const entry = await fetchAppRecordFor(identity.did, identity.pds, rkey)
  if (!entry) {
    throw new AppError(`${repo} publishes no app "${rkey}"`, 404)
  }
  return { entry, author: identity.did }
}

export async function routeAppRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const origin = url.origin
  const path = url.pathname

  if (path !== "/apps" && !path.startsWith("/apps/")) return null

  try {
    // ── List a library ───────────────────────────────────────────────────
    // ?repo=<handle|did> reads someone else's, with no credential at all.
    // That is discovery, in one route and no index.
    if (path === "/apps" && request.method === "GET") {
      const repo = url.searchParams.get("repo")
      if (repo) {
        const identity = await resolveIdentity(repo)
        const apps = await listAppRecordsFor(identity.did, identity.pds)
        return json({
          repo: { did: identity.did, handle: identity.handle ?? identity.alsoKnownAs[0] },
          collection: APP_COLLECTION,
          count: apps.length,
          apps: apps.map(summarize),
        })
      }

      const { session, owner, error } = await ownerSession(env, origin)
      if (error) return error
      const apps = await listAppRecords(session!)
      return json({
        repo: { did: owner },
        collection: APP_COLLECTION,
        count: apps.length,
        apps: apps.map(summarize),
      })
    }

    // ── Publish or update ────────────────────────────────────────────────
    // The rkey comes from the name, so re-posting the same name is an edit,
    // and the repo's history becomes the app's version history.
    if (path === "/apps" && request.method === "POST") {
      await requireOwner(env, request)
      const { session, owner, error } = await ownerSession(env, origin)
      if (error) return error

      const body = (await request.json()) as {
        name?: string
        code?: string
        description?: string
      }
      if (!body.name || !body.code) {
        return json({ error: "bad_request", message: "need { name, code }" }, 400)
      }

      const entry = await publishAppRecord(session!, {
        name: body.name,
        code: body.code,
        description: body.description,
      })
      return json({ ok: true, author: owner, ...summarize(entry) })
    }

    // ── One app, whole ───────────────────────────────────────────────────
    // Includes the source, unlike the listings — this is the route you fetch
    // to actually read or run something.
    const ref = decodeURIComponent(path.slice("/apps/".length))

    if (request.method === "GET") {
      if (!ref) return json({ error: "bad_request", message: "no app named" }, 400)
      const { entry, author } = await resolveAppRef(env, origin, ref)
      return json({ author, rkey: entry.rkey, uri: entry.uri, cid: entry.cid, app: entry.value })
    }

    // ── Unpublish ────────────────────────────────────────────────────────
    // Only ever from your own repo: deleting is a write, and the only repo
    // this hub can write is its owner's.
    if (request.method === "DELETE") {
      await requireOwner(env, request)
      const { repo, rkey } = parseAppRef(ref)
      if (repo) {
        return json(
          { error: "bad_request", message: "you can only delete apps from your own repo" },
          400,
        )
      }
      const { session, error } = await ownerSession(env, origin)
      if (error) return error
      await deleteAppRecord(session!, rkey)
      return json({ ok: true, rkey, message: "app record deleted" })
    }

    return null
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: "unauthorized", message: err.message }, err.status)
    }
    if (err instanceof AppError) {
      return json({ error: "app_error", message: err.message }, err.status)
    }
    if (err instanceof IdentityError) {
      return json({ error: "identity_error", message: err.message }, err.status)
    }
    if (err instanceof PdsError) {
      return json({ error: "pds_error", message: err.message, detail: describeError(err) }, err.status)
    }
    return json(
      {
        error: "app_error",
        message: err instanceof Error ? err.message : String(err),
        detail: describeError(err),
      },
      500,
    )
  }
}
