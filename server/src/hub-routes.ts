import { getHubPublicJwk, rotateHubKey } from "./hub-key"
import {
  HUB_COLLECTION,
  HUB_RKEY,
  deleteHubRecord,
  fetchHubRecordFor,
  publishHubRecord,
  readHubRecord,
} from "./hub-record"
import { PdsError } from "./pds"
import { IdentityError, resolveIdentity } from "./identity"
import { KeyError } from "./oauth"
import { describeError, ownerSession } from "./oauth-routes"
import { AuthError, requireOwner } from "./auth"

// Routes for the hub's published identity, and for discovering other people's.
//
// /hub/peer is the interesting one: it resolves a handle to a DID, that DID to
// its PDS, and asks that PDS for the person's hub record — with no account,
// no API key, and no central index. That is the discovery half of
// docs/social-plan.md working end to end.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

export async function routeHubIdentityRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url)
  const origin = url.origin
  const path = url.pathname

  if (!path.startsWith("/hub/")) return null

  try {
    // ── This hub's federation public key ─────────────────────────────────
    if (path === "/hub/key" && request.method === "GET") {
      return json({ publicKey: await getHubPublicJwk(env) })
    }

    // ── Publish / refresh the record ─────────────────────────────────────
    //
    // Content is entirely hub-determined (its own endpoint and public key), so
    // a caller cannot steer what gets written. It is also published
    // automatically after a successful login, making this a manual re-trigger.
    if (path === "/hub/publish" && request.method === "POST") {
      await requireOwner(env, request)
      const { session, error } = await ownerSession(env, origin)
      if (error) return error
      const result = await publishHubRecord(env, session!, origin)
      return json({ ok: true, ...result })
    }

    // ── Read this hub's record back out of the repo ──────────────────────
    if (path === "/hub/record" && request.method === "GET") {
      const { session, error } = await ownerSession(env, origin)
      if (error) return error
      const record = await readHubRecord(session!)
      return record
        ? json({ published: true, collection: HUB_COLLECTION, rkey: HUB_RKEY, record })
        : json({ published: false, message: "no hub record; POST /hub/publish" }, 404)
    }

    // ── Revoke ───────────────────────────────────────────────────────────
    if (path === "/hub/record" && request.method === "DELETE") {
      await requireOwner(env, request)
      const { session, error } = await ownerSession(env, origin)
      if (error) return error
      await deleteHubRecord(session!)
      return json({ ok: true, message: "hub record deleted; this hub can no longer be verified" })
    }

    // ── Rotate the federation key, then republish ────────────────────────
    if (path === "/hub/rotate-key" && request.method === "POST") {
      await requireOwner(env, request)
      const { session, error } = await ownerSession(env, origin)
      if (error) return error
      const publicKey = await rotateHubKey(env)
      const result = await publishHubRecord(env, session!, origin)
      return json({ ok: true, publicKey, ...result })
    }

    // ── Discovery: find someone else's hub ───────────────────────────────
    if (path.startsWith("/hub/peer/") && request.method === "GET") {
      const subject = decodeURIComponent(path.slice("/hub/peer/".length))
      if (!subject) return json({ error: "bad_request", message: "no handle or DID" }, 400)

      const identity = await resolveIdentity(subject)
      const record = await fetchHubRecordFor(identity.did, identity.pds)
      if (!record) {
        return json(
          {
            found: false,
            did: identity.did,
            handle: identity.handle ?? identity.alsoKnownAs[0],
            message: `no ${HUB_COLLECTION} record in that repo — they are not running a hub`,
          },
          404,
        )
      }
      return json({
        found: true,
        did: identity.did,
        handle: identity.handle ?? identity.alsoKnownAs[0],
        pds: identity.pds,
        hub: record,
      })
    }

    return null
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: "unauthorized", message: err.message }, err.status)
    }
    if (err instanceof KeyError) {
      return json({ error: "key_unavailable", message: err.message }, 503)
    }
    if (err instanceof IdentityError) {
      return json({ error: "identity_error", message: err.message }, err.status)
    }
    if (err instanceof PdsError) {
      return json({ error: "pds_error", message: err.message, detail: describeError(err) }, err.status)
    }
    return json(
      {
        error: "hub_error",
        message: err instanceof Error ? err.message : String(err),
        detail: describeError(err),
      },
      500,
    )
  }
}
