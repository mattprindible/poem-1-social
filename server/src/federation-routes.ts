import { getAgentByName } from "agents"

import {
  FederationError,
  getRelationship,
  requireMutual,
  signOutbound,
  verifyInbound,
} from "./federation"
import { fetchHubRecordFor } from "./hub-record"
import { IdentityError, resolveIdentity } from "./identity"
import { describeError, getOwner } from "./oauth-routes"
import { AuthError, requireOwner } from "./auth"
import { AppError } from "./app-record"
import { PAIR_WINDOW_MS, openPairWindow, readPairWindow } from "./device-identity"
import {
  DeviceError,
  claimDevice,
  getDevice,
  updateDevice,
  defaultDevice,
  listDevices,
  releaseDevice,
} from "./devices"
import { resolveAppRef } from "./app-routes"
import { hubProfiles } from "./capabilities"

// The federated push path.
//
//   sender's hub  ──HTTPS──▶  recipient's hub  ──WSS──▶  recipient's device
//
// The sending hub needs no device of its own; it only originates. The receiving
// hub is the one holding a device socket, and is the only party that decides
// which device a push reaches — the sender never learns a device ID. That is
// deliberate: on the Resident protocol a device ID is effectively a credential,
// so federation is built so it never has to leave the hub that owns it.

const INBOX_PATH = "/federation/inbox"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

/**
 * Which device inbound federation and the local run-route deliver to.
 *
 * A hub may carry several; the sender never picks. See defaultDevice() in
 * devices.ts — the choice belongs to the recipient, and is expressed as hub
 * state rather than as anything a peer can put on the wire.
 */
async function getDeviceId(env: Env): Promise<string | undefined> {
  return defaultDevice(env)
}

/**
 * Hand an app to a device via the same Durable Object the relay uses.
 *
 * THE TRANSLATION BOUNDARY. Inbound federation bodies are in our own frozen
 * wire format ({type, code}); devices speak Resident's protocol, which evolves
 * on upstream's schedule. This is the one place the two meet, so a change to
 * Resident's envelope is a change to this function and nothing else — in
 * particular it never becomes a change our federation peers have to follow.
 *
 * `channel:"system"` puts the message on Resident's control plane (0.7.0+),
 * where "app" is a reserved type handled by the runtime itself. Un-channelled
 * messages still work but log a deprecation on the device for every push.
 *
 * Takes the CODE, not the peer's message object, and builds the device envelope
 * field by field. It used to spread the inbound body over the envelope
 * (`{channel: "system", ...message}`) — but a spread comes last and therefore
 * WINS, so any peer could override the channel simply by including one, and any
 * extra field they invented rode along to the device. That quietly inverted this
 * function's whole purpose: the boundary that exists to stop Resident's
 * protocol leaking into federation was itself letting peers steer it. Nothing a
 * mutual sends is a credential for anything beyond "here is some Lua", so only
 * the Lua crosses.
 */
async function deliverAppToDevice(
  env: Env,
  deviceId: string,
  code: string,
): Promise<Response> {
  const agent = await getAgentByName(env.DeviceAgent, deviceId)
  return agent.fetch(
    new Request(`https://hub/devices/${deviceId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "system", type: "app", code }),
    }),
  )
}

/** What was pushed, for the RESPONSE — never for the wire. See sourceFor(). */
interface Provenance {
  app: { name: string; rkey: string; uri: string; cid: string; author: string }
}

/**
 * Work out what Lua to send, from either half of the push grammar:
 *
 *   { code }  raw source, as it has always been
 *   { app }   a reference into somebody's published library (app-routes.ts)
 *
 * Both collapse to a string of Lua before anything leaves this hub, which is
 * deliberate. The federation wire format is OURS and frozen at {type, code};
 * peers run hubs we cannot update, so every field added there is one we are
 * committing to support forever. Resolving references SENDER-side means app
 * records cost the protocol nothing — a recipient on the old code path cannot
 * tell the difference, because there is no difference.
 *
 * The provenance comes back for the caller's benefit only. Whether the
 * RECIPIENT should learn the name and CID of what landed on their device is a
 * real question, and a genuine extension to the wire — see "update semantics"
 * in docs/social-plan.md. It is not settled, so it is not shipped.
 */
async function sourceFor(
  env: Env,
  origin: string,
  body: { code?: string; app?: string },
): Promise<{ code: string; provenance?: Provenance }> {
  if (body.code !== undefined && body.app !== undefined) {
    throw new AppError("give either { code } or { app }, not both")
  }
  if (body.code !== undefined) {
    if (!body.code.trim()) throw new AppError("app source is empty")
    return { code: body.code }
  }
  if (body.app === undefined) {
    throw new AppError("need { code } or { app }")
  }

  const { entry, author } = await resolveAppRef(env, origin, body.app)
  return {
    code: entry.value.code,
    provenance: {
      app: {
        name: entry.value.name,
        rkey: entry.rkey,
        uri: entry.uri,
        cid: entry.cid,
        author,
      },
    },
  }
}

export async function routeFederationRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (
    !path.startsWith("/federation/") &&
    path !== "/hub/device" &&
    path !== "/hub/device/events" &&
    path !== "/hub/device/app" &&
    path !== "/hub/devices" &&
    !path.startsWith("/hub/devices/")
  ) {
    return null
  }

  try {
    // ── The claimed devices ──────────────────────────────────────────────
    // Owner-gated throughout, reads included: a device id is what the relay
    // keys on, so listing them is not a public read.
    if (path === "/hub/devices") {
      await requireOwner(env, request)

      if (request.method === "GET") {
        const [devices, win] = await Promise.all([listDevices(env), readPairWindow(env)])
        return json({
          count: devices.length,
          ...(win ? { pairing: { deviceId: win.deviceId, expiresAt: new Date(win.expiresAt).toISOString() } } : {}),
          devices,
        })
      }

      // Claiming is the act that makes a hub carry a device at all — before
      // this, the relay carried anything that connected.
      if (request.method === "POST") {
        const body = (await request.json()) as {
          deviceId?: string
          name?: string
          deviceType?: string
          makeDefault?: boolean
        }
        const deviceId = body.deviceId?.trim()
        if (!deviceId) {
          return json({ error: "bad_request", message: "need { deviceId }" }, 400)
        }
        const device = await claimDevice(env, deviceId, {
          name: body.name,
          deviceType: body.deviceType,
          makeDefault: body.makeDefault,
        })
        return json({ ok: true, device })
      }
    }

    // ── Open a pairing window ────────────────────────────────────────────
    // The hub has no key for a new device, so the owner has to vouch once. The
    // first device presenting a key for this id during the window is bound;
    // afterwards only that key may act as the device.
    if (path.endsWith("/pair") && path.startsWith("/hub/devices/") && request.method === "POST") {
      await requireOwner(env, request)
      const deviceId = decodeURIComponent(
        path.slice("/hub/devices/".length, path.length - "/pair".length),
      )
      const device = await getDevice(env, deviceId)
      if (!device) throw new DeviceError(`'${deviceId}' is not claimed by this hub`, 404)

      // Re-pairing drops the old key deliberately: a device that was reflashed
      // or factory-reset holds a NEW key, and refusing to rebind would leave
      // the owner locked out of their own hardware with no way back.
      if (device.key) await updateDevice(env, deviceId, { key: undefined })

      const win = await openPairWindow(env, deviceId)
      return json({
        ok: true,
        deviceId,
        expiresAt: new Date(win.expiresAt).toISOString(),
        windowSeconds: PAIR_WINDOW_MS / 1000,
        rebound: Boolean(device.key),
        message: device.key
          ? "previous key cleared; reconnect the device now to bind its new one"
          : "reconnect the device now to bind its key",
      })
    }

    if (path.startsWith("/hub/devices/") && request.method === "DELETE") {
      await requireOwner(env, request)
      const deviceId = decodeURIComponent(path.slice("/hub/devices/".length))
      await releaseDevice(env, deviceId)
      return json({
        ok: true,
        deviceId,
        message: "device released; this hub will no longer carry it",
      })
    }

    // ── Which device inbound federation lands on ─────────────────────────
    // Kept as its own route because it answers a different question from
    // "what do I carry": with several devices claimed, the recipient decides
    // where a mutual's push goes, and no sender can influence it.
    if (path === "/hub/device") {
      await requireOwner(env, request)
      if (request.method === "GET") {
        const deviceId = await getDeviceId(env)
        return deviceId
          ? json({ deviceId })
          : json(
              {
                deviceId: null,
                message:
                  "no default device — claim one with POST /hub/devices, or set " +
                  "makeDefault when several are claimed",
              },
              404,
            )
      }
      if (request.method === "POST") {
        const body = (await request.json()) as { deviceId?: string }
        const deviceId = body.deviceId?.trim()
        if (!deviceId) {
          return json({ error: "bad_request", message: "need { deviceId }" }, 400)
        }
        const device = await claimDevice(env, deviceId, { makeDefault: true })
        return json({ ok: true, deviceId: device.deviceId })
      }
    }

    // ── What the device has said back ────────────────────────────────────
    // The return path for `events.send` in a Lua app (and for anything the
    // firmware emits via publishEvent). Owner-gated, not device-ID-gated: a
    // device ID is the credential for PUSHING to a device, and it is already
    // known to this hub — but what a device EMITS is the owner's, and could
    // carry anything an app chose to report.
    //
    // JSON, and read-only. This is the agent-drivable answer to "is my device
    // actually alive, and what has it been doing" — deliberately not a
    // dashboard.
    if (path === "/hub/device/events" && request.method === "GET") {
      await requireOwner(env, request)
      const deviceId = await getDeviceId(env)
      if (!deviceId) {
        return json({ error: "no_device", message: "this hub has no device set" }, 404)
      }
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const agent = await getAgentByName(env.DeviceAgent, deviceId)
      const report = await agent.recentEvents(Number.isFinite(limit) ? limit : 50)
      return json({ deviceId, ...report })
    }

    // ── Run an app on YOUR OWN device ────────────────────────────────────
    // The local half of the same grammar: `{ app }` from your library or
    // anyone's, `{ code }` for something you have not published.
    //
    // send-app.sh posts raw Lua to the relay's /devices/<id>/send and always
    // will — it is the cable-and-a-file path, and it deliberately needs no
    // login. This route is for the case that path cannot serve: running
    // something with a NAME, out of a library, without a copy of the file.
    if (path === "/hub/device/app" && request.method === "POST") {
      await requireOwner(env, request)
      const deviceId = await getDeviceId(env)
      if (!deviceId) {
        return json({ error: "no_device", message: "this hub has no device set" }, 404)
      }

      const body = (await request.json()) as { app?: string; code?: string }
      const { code, provenance } = await sourceFor(env, url.origin, body)

      const res = await deliverAppToDevice(env, deviceId, code)
      const detail = await res.text()
      return json(
        {
          ok: res.ok,
          deviceId,
          ...(provenance ?? {}),
          deviceStatus: res.status,
          message: res.ok ? "app delivered to device" : detail || "device not connected",
        },
        res.ok ? 200 : 503,
      )
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

      const body = (await request.json()) as {
        to?: string
        code?: string
        app?: string
        force?: boolean
      }
      if (!body.to) {
        return json({ error: "bad_request", message: "need { to } and { code } or { app }" }, 400)
      }
      const { code, provenance } = await sourceFor(env, url.origin, body)

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

      // The federation wire format is OURS and deliberately frozen: {type, code}.
      // Resident's device-protocol concepts (the `channel` envelope field, its
      // reserved types, its deprecation schedule) must NOT leak into it — peers
      // run hubs we cannot update, so anything added here we are committing to
      // supporting forever. Translation to whatever the recipient's device
      // currently speaks happens at the boundary, in deliverAppToDevice().
      const payload = JSON.stringify({ type: "app", code })
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
          ...(provenance ?? {}),
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

    // ── Outbound: ask a mutual what they can accept ──────────────────────
    // Probe, do not remember. The answer is fetched live every time and is
    // deliberately NOT cached anywhere: the whole point is that a belief about
    // someone else's hardware goes stale silently, and a stale belief gets
    // acted on with more confidence than no belief at all.
    if (path.startsWith("/federation/probe/") && request.method === "GET") {
      await requireOwner(env, request)
      const owner = await getOwner(env)
      if (!owner) return json({ error: "unclaimed" }, 409)

      const subject = decodeURIComponent(path.slice("/federation/probe/".length))
      const peer = await resolveIdentity(subject)
      const record = await fetchHubRecordFor(peer.did, peer.pds)
      if (!record) {
        return json(
          { error: "no_hub", message: `${subject} publishes no hub record` },
          404,
        )
      }

      // Signed exactly like a push, because it IS the same trust question asked
      // in the other direction — and reusing the path means discovery cannot
      // drift into a second, weaker way of proving who is asking.
      const payload = JSON.stringify({ type: "capabilities" })
      const headers = await signOutbound(env, {
        sender: owner,
        recipient: peer.did,
        body: payload,
      })
      const target = `${record.endpoint.replace(/\/$/, "")}/federation/capabilities`
      const res = await fetch(target, { method: "POST", headers, body: payload })
      const text = await res.text()

      return json(
        {
          ok: res.ok,
          peer: { handle: peer.handle ?? subject, did: peer.did, hub: record.endpoint },
          probedAt: new Date().toISOString(),
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

    // ── Inbound: a mutual asking what we can accept ──────────────────────
    // Same authentication as the inbox — signature, then mutual follow — and
    // mutuals only on purpose. What hardware someone owns is theirs to
    // disclose; a mutual can already push code to it, so learning what SHAPE to
    // push is strictly less than what they hold already. Refusing would only
    // mean they push blind.
    if (path === "/federation/capabilities" && request.method === "POST") {
      const owner = await getOwner(env)
      if (!owner) return json({ error: "unclaimed", message: "this hub has no owner" }, 409)

      const bodyText = await request.text()
      const senderDid = await verifyInbound(env, request, bodyText, owner)
      await requireMutual(owner, senderDid, "ask what this hub can accept")

      return json({ profiles: await hubProfiles(env) })
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

      const res = await deliverAppToDevice(env, deviceId, message.code)
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
    if (err instanceof AppError) {
      return json({ error: "app_error", message: err.message }, err.status)
    }
    if (err instanceof DeviceError) {
      return json({ error: "device_error", message: err.message }, err.status)
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
