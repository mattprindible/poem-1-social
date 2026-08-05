import { DeviceAgent as RelayAgent } from "@inanimate/resident/cloudflare"
import type { Connection, WSMessage } from "agents"

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

  async onMessage(connection: Connection, data: WSMessage): Promise<void> {
    if (typeof data === "string" && this.isDevice(connection)) {
      this.record(data)
    }
    // Then the canonical behaviour, unchanged. Ours is additive: if upstream
    // ever gives onMessage a body, we inherit it rather than shadow it.
    await super.onMessage(connection, data)
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
