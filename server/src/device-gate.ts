import { AuthError, requireOwner } from "./auth"
import { isClaimed } from "./devices"

// The gate in front of the relay.
//
// THE HOLE THIS CLOSES: `POST /devices/<id>/send` accepted anything, from
// anyone, with no credential. Hub URLs are published in atproto repos by design
// and device ids are printed on the device's own screen, so "only mutuals can
// push code to your device" was true of the federated path and false of the
// front door beside it. Verified open on a live hub before this existed.
//
// It runs BEFORE upstream's routeDeviceRequest, because everything under
// /devices/ is forwarded straight into the Durable Object and there is no seam
// inside it we could use without forking Resident. A gate in front needs no
// fork, and keeps the whole policy readable in one file.
//
// ── The surface is wider than /send ──────────────────────────────────────────
// Three things live under /devices/<id>, and all three needed a decision:
//
//   POST /send        push code. The hole. Owner only.
//   WS  ?monitor=1    a MONITOR connection — upstream broadcasts every relayed
//                     message to monitors, so this is a live read channel on
//                     the device. Owner only. Easy to miss, because it is not
//                     a write and does not look dangerous.
//   WS  (no query)    the DEVICE connection. Must be a CLAIMED id.
//   GET /             connection count. Owner only; it is a presence oracle for
//                     anyone probing device ids.
//
// ── Where this gate stops, and what carries on ───────────────────────────────
// This gate answers "is this id one we carry, and is the caller the owner". It
// deliberately does NOT answer "is this really the device" — a WebSocket
// upgrade here is allowed on a claimed id alone, because at this point in the
// request no proof has been exchanged yet.
//
// That proof happens one layer in, in device-agent.ts: the connection is
// challenged on open and must sign a per-connection nonce with the key bound to
// that device. Until it does, it receives nothing. So a claimed id gets a
// SOCKET here and still gets no APPS there.
//
// Splitting it that way is not an accident of history. A gate is per-request
// and cannot hold the state a challenge-response needs; the Durable Object can,
// because it owns the connection for its lifetime. Trying to do identity here
// would mean either a stateless proof (a password, replayable) or duplicating
// connection state outside the object that already has it.

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket"
}

/**
 * Returns a Response to REFUSE the request, or null to let it through to the
 * relay. Never returns a success response — it only ever says no.
 */
export async function gateDeviceRequest(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/devices/")) return null

  const deviceId = url.pathname.split("/")[2]
  if (!deviceId) return null // upstream answers this with its own 400

  const subpath = url.pathname.replace(/^\/devices\/[^/]+/, "")
  const monitor = url.searchParams.get("monitor") === "1"

  // ── The device's own socket ────────────────────────────────────────────
  // Claim check only. Proving it IS the device happens after the upgrade, in
  // device-agent.ts — see the header for why the split is deliberate.
  if (isWebSocketUpgrade(request) && !monitor) {
    if (await isClaimed(env, deviceId)) return null
    // 403 and a plain reason: this is read by someone holding a device that
    // will not connect, and "unclaimed" is the actionable word.
    return json(
      {
        error: "unclaimed_device",
        message:
          `device '${deviceId}' is not claimed by this hub — ` +
          `claim it with POST /hub/devices`,
      },
      403,
    )
  }

  // ── Everything else needs the owner ────────────────────────────────────
  try {
    await requireOwner(env, request)
  } catch (err) {
    if (err instanceof AuthError) {
      return json(
        {
          error: "unauthorized",
          message:
            subpath === "/send"
              ? "pushing to a device requires the hub owner's credential — " +
                "send Authorization: Bearer <HUB_ADMIN_TOKEN>"
              : err.message,
        },
        err.status,
      )
    }
    throw err
  }

  // Owner-authenticated, but a hub still only carries what it has claimed —
  // otherwise the owner could use their own hub as an open relay onto somebody
  // else's device, which is the same hole facing outward.
  if (!(await isClaimed(env, deviceId))) {
    return json(
      {
        error: "unclaimed_device",
        message: `device '${deviceId}' is not claimed by this hub`,
      },
      404,
    )
  }

  return null
}
