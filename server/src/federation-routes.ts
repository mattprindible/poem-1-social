import { getAgentByName } from "agents"

import {
  FederationError,
  getRelationship,
  requireMutual,
  signOutbound,
  verifyInbound,
} from "./federation"
import { fetchHubRecordFor } from "./hub-record"
import { NS, hubStore } from "./hub-store"
import { IdentityError, resolveIdentity } from "./identity"
import { describeError, getOwner } from "./oauth-routes"
import { AuthError, requireOwner } from "./auth"

// The federated push path.
//
//   sender's hub  ──HTTPS──▶  recipient's hub  ──WSS──▶  recipient's device
//
// The sending hub needs no device of its own; it only originates. The receiving
// hub is the one holding a device socket, and is the only party that decides
// which device a push reaches — the sender never learns a device ID. That is
// deliberate: on the Resident protocol a device ID is effectively a credential,
// so federation is built so it never has to leave the hub that owns it.

const DEVICE_ITEM = "device-id"
const INBOX_PATH = "/federation/inbox"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

async function getDeviceId(env: Env): Promise<string | undefined> {
  return hubStore(env).getItem(NS.hub, DEVICE_ITEM)
}

/** Hand an app to a device via the same Durable Object the relay uses. */
async function deliverToDevice(
  env: Env,
  deviceId: string,
  message: unknown,
): Promise<Response> {
  const agent = await getAgentByName(env.DeviceAgent, deviceId)
  return agent.fetch(
    new Request(`https://hub/devices/${deviceId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    }),
  )
}

export async function routeFederationRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (!path.startsWith("/federation/") && path !== "/hub/device") return null

  try {
    // ── Which device this hub relays to ──────────────────────────────────
    // Stored on the hub rather than supplied per-push, so a device ID never
    // travels between hubs.
    if (path === "/hub/device") {
      // GET is guarded too: a device ID is effectively a credential on the
      // Resident protocol, so this must not be a public read.
      await requireOwner(env, request)
      if (request.method === "GET") {
        const deviceId = await getDeviceId(env)
        return deviceId ? json({ deviceId }) : json({ deviceId: null }, 404)
      }
      if (request.method === "POST") {
        const body = (await request.json()) as { deviceId?: string }
        const deviceId = body.deviceId?.trim()
        if (!deviceId || !/^[a-zA-Z0-9_-]{4,64}$/.test(deviceId)) {
          return json({ error: "bad_request", message: "deviceId required" }, 400)
        }
        await hubStore(env).setItem(NS.hub, DEVICE_ITEM, deviceId)
        return json({ ok: true, deviceId })
      }
    }

    // ── Outbound: push an app to someone else's device ───────────────────
    if (path === "/federation/push" && request.method === "POST") {
      // Without this, a stranger could make this hub push arbitrary code to
      // every one of its owner's mutuals, signed as the owner.
      await requireOwner(env, request)
      const owner = await getOwner(env)
      if (!owner) {
        return json({ error: "unclaimed", message: "sign in at /oauth/login first" }, 409)
      }

      const body = (await request.json()) as { to?: string; code?: string; force?: boolean }
      if (!body.to || !body.code) {
        return json({ error: "bad_request", message: "need { to, code }" }, 400)
      }

      // Where does the recipient keep their hub? Straight out of their repo.
      const recipient = await resolveIdentity(body.to)
      const record = await fetchHubRecordFor(recipient.did, recipient.pds)
      if (!record) {
        return json(
          {
            error: "no_hub",
            message: `${body.to} publishes no hub record — they are not running a hub`,
          },
          404,
        )
      }

      // Check our own side of the relationship first. The recipient checks it
      // too and THEIR answer is the one that counts — this is a courtesy so the
      // common case fails with a good local message instead of a remote 403.
      //
      // `force` skips this advisory check and lets the recipient decide. It
      // cannot grant access: the recipient's check is the one that enforces.
      // Useful when the two sides disagree (graph propagation lag), and it is
      // what makes the recipient's enforcement observable rather than masked.
      const rel = await getRelationship(owner, recipient.did)
      if (!rel.mutual && !body.force) {
        return json(
          {
            error: "not_mutual",
            message: `you and ${body.to} are not mutuals`,
            relationship: rel,
          },
          403,
        )
      }

      const payload = JSON.stringify({ type: "app", code: body.code })
      const headers = await signOutbound(env, {
        sender: owner,
        recipient: recipient.did,
        body: payload,
      })

      const target = `${record.endpoint.replace(/\/$/, "")}${INBOX_PATH}`
      const res = await fetch(target, { method: "POST", headers, body: payload })
      const text = await res.text()

      return json(
        {
          ok: res.ok,
          to: { handle: recipient.handle ?? body.to, did: recipient.did, hub: record.endpoint },
          status: res.status,
          response: (() => {
            try {
              return JSON.parse(text)
            } catch {
              return text
            }
          })(),
        },
        res.ok ? 200 : 502,
      )
    }

    // ── Inbound: someone else's hub pushing to our device ────────────────
    if (path === INBOX_PATH && request.method === "POST") {
      const owner = await getOwner(env)
      if (!owner) {
        return json({ error: "unclaimed", message: "this hub has no owner" }, 409)
      }

      // Read the body once: the signature covers these exact bytes.
      const bodyText = await request.text()

      // 1. Is this really from who it claims? Verified against the key that
      //    sender publishes in their own repo.
      const senderDid = await verifyInbound(env, request, bodyText, owner)

      // 2. Is that sender a mutual? Strong ties push code; nobody else does.
      await requireMutual(owner, senderDid)

      const deviceId = await getDeviceId(env)
      if (!deviceId) {
        return json(
          { error: "no_device", message: "this hub has no device configured" },
          503,
        )
      }

      const message = JSON.parse(bodyText) as { type?: string; code?: string }
      if (message.type !== "app" || typeof message.code !== "string") {
        return json({ error: "bad_request", message: "expected { type: 'app', code }" }, 400)
      }

      const res = await deliverToDevice(env, deviceId, message)
      const detail = await res.text()
      return json(
        {
          ok: res.ok,
          from: senderDid,
          delivered: res.ok,
          deviceStatus: res.status,
          message: res.ok
            ? "app delivered to device"
            : detail || "device not connected",
        },
        res.ok ? 200 : 503,
      )
    }

    // ── Is this account a mutual? (diagnostic) ───────────────────────────
    if (path.startsWith("/federation/relationship/") && request.method === "GET") {
      const owner = await getOwner(env)
      if (!owner) return json({ error: "unclaimed" }, 409)
      const other = await resolveIdentity(
        decodeURIComponent(path.slice("/federation/relationship/".length)),
      )
      return json({
        owner,
        other: { did: other.did, handle: other.handle ?? other.alsoKnownAs[0] },
        ...(await getRelationship(owner, other.did)),
      })
    }

    return null
  } catch (err) {
    if (err instanceof AuthError) {
      return json({ error: "unauthorized", message: err.message }, err.status)
    }
    if (err instanceof FederationError) {
      return json({ error: "federation_error", message: err.message }, err.status)
    }
    if (err instanceof IdentityError) {
      return json({ error: "identity_error", message: err.message }, err.status)
    }
    return json(
      {
        error: "federation_error",
        message: err instanceof Error ? err.message : String(err),
        detail: describeError(err),
      },
      500,
    )
  }
}
