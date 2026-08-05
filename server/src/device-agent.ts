import { DeviceAgent as RelayAgent } from "@inanimate/resident/cloudflare"
import type { Connection, ConnectionContext, WSMessage } from "agents"

import { getDevice, updateDevice } from "./devices"
import { closePairWindow, fingerprintOf, judgeIdentity, newChallenge } from "./device-identity"

// The relay Durable Object, extended so the device can talk BACK.
//
// Upstream's `DeviceAgent.onMessage` is an empty function — deliberately, since
// the canonical relay's job is to carry pushes *to* a device and it has nowhere
// to put anything coming the other way. So every frame a device emits reaches
// this hub and is dropped on the floor. That is open decision #5 in
// docs/social-plan.md, and it costs more than it looks:
//
//   - `set-hub.sh` can only confirm a hub switch by watching the DESTINATION's
//     connection count rise. Durable Objects keep hibernating WebSockets from
//     old boots, so a hub the device left hours ago still reports connections,
//     and a naive non-zero check produced a confident false positive during
//     testing. A message the device sent, with a timestamp, is the answer that
//     count can never be.
//   - There is no channel for compile or runtime errors, so a pushed app that
//     fails to load fails silently unless someone is holding a USB cable.
//
// The device end of this already exists in stock Resident: `events.send(name,
// data)` in Lua and `Sandbox::publishEvent` in C++ both emit
// `{channel:"app", type, data, from, nonce, ts_ms}` over the same WebSocket the
// relay already holds. So the missing half was never on the device — it was
// here. Nothing is forked and nothing is reflashed to turn this on.
//
// NAMING IS LOAD-BEARING: this class is exported as `DeviceAgent` — the name
// wrangler.jsonc already binds — rather than something more descriptive like
// `PoemDeviceAgent`. A Durable Object's class name is part of its migration
// identity, so renaming it would need a `renamed_classes` migration against a
// live object that is currently holding this hub's device socket. Subclassing
// under the same exported name keeps that entirely off the table.

/** Per-connection state, persisted in the socket attachment across hibernation. */
interface ConnState {
  challenge?: string
  verified?: boolean
  fingerprint?: string
}

/** Ring size. Bounded because a chatty app could otherwise fill the DO. */
const MAX_EVENTS = 200

/** Per-frame cap. `events.send` builds at most ~256 bytes of data, but the
 *  device is not the only thing that could ever speak on this socket. */
const MAX_BODY = 4096

// The index signature is what SqlStorage's row generic requires; the named
// fields are the actual shape.
export interface DeviceEvent extends Record<string, SqlStorageValue> {
  seq: number
  at: number
  channel: string | null
  type: string | null
  /** Runtime telemetry's own discriminator: `compile_error`, `runtime_error`,
   *  `app_compiled`, … Null for app events, whose `type` is already the name. */
  name: string | null
  body: string
}

export class DeviceAgent extends RelayAgent<Env> {
  private tableReady = false

  private ensureTable(): void {
    if (this.tableReady) return
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS device_events (
         seq     INTEGER PRIMARY KEY AUTOINCREMENT,
         at      INTEGER NOT NULL,
         channel TEXT,
         type    TEXT,
         name    TEXT,
         body    TEXT NOT NULL
       )`,
    )

    // `name` arrived after the table did, and CREATE TABLE IF NOT EXISTS is a
    // no-op on an existing one — so a hub that recorded anything before
    // telemetry forwarding has the old shape and would throw on every insert.
    // Reconciling here (rather than dropping the table) keeps whatever the
    // device has already reported, which is the point of storing it.
    const columns = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>("PRAGMA table_info(device_events)")
      .toArray()
    if (!columns.some((c) => c.name === "name")) {
      this.ctx.storage.sql.exec("ALTER TABLE device_events ADD COLUMN name TEXT")
    }

    this.tableReady = true
  }

  /**
   * Is this the device's socket, or a monitor's?
   *
   * Upstream tags connections "device" / "monitor" in `getConnectionTags`, and
   * the monitor socket receives an echo of every relayed message. Recording
   * untagged would therefore log this hub's own pushes back to itself as though
   * the device had said them — which is precisely the confusion this endpoint
   * exists to remove.
   */
  private isDevice(connection: Connection): boolean {
    for (const c of this.getConnections("device")) {
      if (c.id === connection.id) return true
    }
    return false
  }

  /**
   * Challenge every device connection the moment it opens.
   *
   * Per CONNECTION, not per device: a nonce reused across connections is a
   * password, and the whole point of a challenge is that a replayed proof is
   * worthless. Held in memory rather than storage because it is meaningless
   * once this socket closes.
   */
  onConnect(connection: Connection, ctx: ConnectionContext): void {
    super.onConnect(connection, ctx)
    const url = new URL(ctx.request.url)
    if (url.searchParams.get("monitor") === "1") return

    const challenge = newChallenge()
    // Connection state, NOT an in-memory map: Durable Objects hibernate with
    // their WebSockets still open, and a map would come back empty while the
    // sockets came back live — turning the real device unverified and cutting
    // it off. setState persists in the socket's own attachment.
    connection.setState({ challenge, verified: false })
    connection.send(JSON.stringify({ channel: "system", type: "identify", challenge }))
  }


  async onMessage(connection: Connection, data: WSMessage): Promise<void> {
    if (typeof data === "string" && this.isDevice(connection)) {
      // The auth frame is consumed here and never recorded: it is handshake,
      // not something the device said, and logging signatures would put a
      // replayable-looking artefact in a ring buffer the owner reads.
      if (await this.handleAuth(connection, data)) return

      // A device with a key on file speaks only through a proved connection.
      // Otherwise anyone holding the id could write the owner's event log —
      // the log being the thing the owner reads to decide the device is fine.
      if (!(await this.speaksForDevice(connection))) return
      this.record(data)
    }
    // Then the canonical behaviour, unchanged. Ours is additive: if upstream
    // ever gives onMessage a body, we inherit it rather than shadow it.
    await super.onMessage(connection, data)
  }


  /**
   * Returns true when the frame WAS the auth response, so the caller stops.
   *
   * A device with a bound key that fails this is disconnected rather than
   * merely ignored: leaving it attached would let it keep occupying the
   * device slot and emitting frames that look like presence.
   */
  /**
   * May this connection act as the device?
   *
   * True for a proved connection, and true for any connection when no key is
   * bound (the legacy path — a hub whose device has never paired still works).
   * The asymmetry is the point: binding a key is one-way, so a paired device
   * can never be impersonated by simply staying quiet.
   */
  private async speaksForDevice(connection: Connection): Promise<boolean> {
    const stored = await getDevice(this.env, this.name)
    if (!stored?.key) return true
    return (connection.state as ConnState | null)?.verified === true
  }

  /**
   * Deliver only to connections entitled to be the device.
   *
   * THE ENFORCEMENT POINT. Refusing to *verify* is not enough on its own: an
   * impostor can simply never answer the challenge, and a connection that is
   * merely unverified still sits in upstream's "device" tag and would receive
   * every pushed app. Gating delivery is what makes silence useless.
   */
  async handleSend(request: Request): Promise<Response> {
    const stored = await getDevice(this.env, this.name)
    if (!stored?.key) return super.handleSend(request)

    const entitled = Array.from(this.getConnections("device")).filter(
      (c) => (c.state as ConnState | null)?.verified === true,
    )
    if (entitled.length === 0) {
      return new Response("Device not connected", { status: 503 })
    }

    const raw = await request.text()
    for (const c of entitled) c.send(raw)
    for (const c of this.getConnections("monitor")) c.send(raw)
    return new Response("OK", { status: 200 })
  }

  private async handleAuth(connection: Connection, raw: string): Promise<boolean> {
    let msg: { channel?: unknown; type?: unknown; pubkey?: unknown; sig?: unknown; device?: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      return false
    }
    if (msg.channel !== "system" || msg.type !== "identify") return false

    const challenge = (connection.state as ConnState | null)?.challenge
    if (!challenge) {
      connection.close(1008, "no challenge outstanding")
      return true
    }

    const stored = await getDevice(this.env, this.name)
    const verdict = await judgeIdentity(
      this.env,
      this.name,
      stored?.key,
      {
        pubkey: typeof msg.pubkey === "string" ? msg.pubkey : undefined,
        sig: typeof msg.sig === "string" ? msg.sig : undefined,
      },
      challenge,
    )

    if (verdict.state === "refused") {
      connection.close(1008, verdict.reason)
      return true
    }

    if (verdict.state === "bound") {
      const pubkey = msg.pubkey as string
      await updateDevice(this.env, this.name, {
        key: {
          pubkey,
          boundAt: new Date().toISOString(),
          fingerprint: await fingerprintOf(pubkey),
        },
      })
      // One window, one device. Leaving it open would let a second device bind
      // over the first on the same authorization the owner gave once.
      await closePairWindow(this.env)
    }

    connection.setState({
      challenge: undefined,
      verified: verdict.state !== "legacy",
      ...(verdict.state === "legacy" ? {} : { fingerprint: verdict.fingerprint }),
    })

    // Whatever the device says about itself rides on the auth frame, so it is
    // only ever recorded once identity has been proved. An unverified device's
    // self-description is just a claim by whoever opened the socket.
    if (verdict.state !== "legacy" && msg.device && typeof msg.device === "object") {
      await updateDevice(this.env, this.name, {
        reported: msg.device as Record<string, unknown>,
      })
    }

    connection.send(
      JSON.stringify({
        channel: "system",
        type: "identified",
        state: verdict.state,
        ...(verdict.state === "legacy" ? {} : { fingerprint: verdict.fingerprint }),
      }),
    )
    return true
  }

  private record(raw: string): void {
    this.ensureTable()

    // `channel` and `type` are lifted into columns so this is queryable without
    // parsing every row, but the raw frame is kept verbatim. The device's
    // envelope is Resident's to change, not ours, and a decoded-only record
    // would silently lose whatever upstream adds next.
    let channel: string | null = null
    let type: string | null = null
    let name: string | null = null
    try {
      const parsed = JSON.parse(raw) as {
        channel?: unknown
        type?: unknown
        name?: unknown
      }
      if (typeof parsed.channel === "string") channel = parsed.channel
      if (typeof parsed.type === "string") type = parsed.type
      // Runtime telemetry is all one `type`, so without this every compile
      // error and every successful load would look alike in the column that
      // exists to tell them apart.
      if (typeof parsed.name === "string") name = parsed.name
    } catch {
      // Not JSON. Store it anyway — a malformed frame is exactly the kind of
      // thing you want to SEE when a device is misbehaving, and discarding it
      // would rebuild the silence this whole file exists to end.
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO device_events (at, channel, type, name, body) VALUES (?, ?, ?, ?, ?)",
      Date.now(),
      channel,
      type,
      name,
      raw.length > MAX_BODY ? raw.slice(0, MAX_BODY) : raw,
    )

    this.ctx.storage.sql.exec(
      "DELETE FROM device_events WHERE seq NOT IN (SELECT seq FROM device_events ORDER BY seq DESC LIMIT ?)",
      MAX_EVENTS,
    )
  }

  /**
   * Read back what the device has said. Called over RPC by the owner-gated hub
   * route — deliberately NOT exposed on the device's own `/devices/<id>/...`
   * surface, which is authenticated only by knowing the device ID.
   *
   * `deviceConnected` is reported but is NOT proof of life, for the hibernating
   * -socket reason in the header comment. `lastEventAt` is the honest signal:
   * it is a wall-clock time this hub recorded when the device actually spoke.
   */
  async recentEvents(limit = 50): Promise<{
    events: DeviceEvent[]
    deviceConnected: boolean
    lastEventAt: number | null
  }> {
    this.ensureTable()
    const capped = Math.max(1, Math.min(Math.trunc(limit) || 1, MAX_EVENTS))
    const rows = this.ctx.storage.sql
      .exec<DeviceEvent>(
        "SELECT seq, at, channel, type, name, body FROM device_events ORDER BY seq DESC LIMIT ?",
        capped,
      )
      .toArray()

    return {
      events: rows,
      deviceConnected: Array.from(this.getConnections("device")).length > 0,
      lastEventAt: rows.length > 0 ? Math.max(...rows.map((r) => r.at)) : null,
    }
  }
}
