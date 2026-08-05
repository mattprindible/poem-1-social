import { NS, hubStore } from "./hub-store"

// The device registry: which devices this hub will carry, and which one an
// inbound federated push lands on.
//
// Before this, a hub held ONE device id in a single key, and that id gated
// nothing — it only told federation where to deliver. The relay itself accepted
// any device id at all, from anyone, with no credential (docs/san.md). So
// "claimed" was a word in the design and nothing in the code.
//
// A claim is now the thing the relay checks. An unclaimed id gets no socket and
// no traffic, which means a hub carries its owner's devices rather than
// whatever happens to connect to it.
//
// One owner, N devices — the cardinality docs/san.md defines. Upstream's relay
// was always per-device (a Durable Object each, keyed by id); it was only this
// hub's bookkeeping that assumed one.

/** Key in NS.hub naming which device inbound federation delivers to. */
const DEFAULT_ITEM = "default-device"

/** The pre-registry single-device key, read once during migration. */
const LEGACY_ITEM = "device-id"

/** Device ids are opaque to us; this only bounds what can be stored. */
export const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{4,64}$/

export interface DeviceRecord {
  /** Owner-supplied label. The id is the identity; this is for humans. */
  name?: string
  claimedAt: string
  /**
   * What kind of board this is — `poem1`, `m5stick`, and so on.
   *
   * Owner-declared at claim time, because apps are NOT portable across boards:
   * Lua written for a Poem/1 panel compiles cleanly on an M5Stick and renders
   * garbage, which is the worst failure mode available since the error channel
   * reports success. Knowing what a device is has to precede warning about it.
   *
   * The firmware already knows (`cfg.deviceType`) but does not send it, so this
   * is the owner's word for now and the device's own later — that half needs a
   * reflash. See "Devices are not interchangeable" in docs/san.md.
   */
  deviceType?: string
}

export interface Device extends DeviceRecord {
  deviceId: string
  isDefault: boolean
}

export class DeviceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = "DeviceError"
  }
}

/**
 * Fold the old single-device key into the registry, once.
 *
 * A hub that has been relaying happily for weeks must not lose its device the
 * moment it deploys this — and worse, must not have that device silently
 * refused by the new gate. Migration is therefore lazy and idempotent: it runs
 * on any read, and does nothing once the registry is non-empty.
 */
async function migrateLegacy(env: Env): Promise<void> {
  const store = hubStore(env)
  const legacy = await store.getItem(NS.hub, LEGACY_ITEM)
  if (!legacy) return

  const existing = await store.listItems(NS.device)
  if (Object.keys(existing).length === 0) {
    const record: DeviceRecord = { claimedAt: new Date().toISOString(), name: "migrated" }
    await store.setItem(NS.device, legacy, JSON.stringify(record))
    await store.setItem(NS.hub, DEFAULT_ITEM, legacy)
  }
  // Drop the old key either way: leaving it would make it ambiguous which of
  // the two is authoritative next time someone reads it.
  await store.delItem(NS.hub, LEGACY_ITEM)
}

export async function listDevices(env: Env): Promise<Device[]> {
  await migrateLegacy(env)
  const store = hubStore(env)
  const [rows, fallback] = await Promise.all([
    store.listItems(NS.device),
    store.getItem(NS.hub, DEFAULT_ITEM),
  ])

  return Object.entries(rows).map(([deviceId, raw]) => ({
    deviceId,
    isDefault: deviceId === fallback,
    ...(JSON.parse(raw) as DeviceRecord),
  }))
}

/**
 * THE GATE'S QUESTION. Kept deliberately small and cheap: it is on the path of
 * every relay request and every WebSocket upgrade.
 */
export async function isClaimed(env: Env, deviceId: string): Promise<boolean> {
  await migrateLegacy(env)
  return (await hubStore(env).getItem(NS.device, deviceId)) !== undefined
}

/**
 * Which device an inbound federated push lands on.
 *
 * The SENDER must never choose. A sender does not learn a device id today and
 * that should not change — so with several devices claimed, the choice is the
 * recipient's, expressed as this default rather than as anything on the wire.
 */
export async function defaultDevice(env: Env): Promise<string | undefined> {
  const devices = await listDevices(env)
  if (devices.length === 0) return undefined
  // A lone device is the default whether or not anyone said so, which keeps the
  // common case free of a setup step nobody would understand the need for.
  if (devices.length === 1) return devices[0]!.deviceId
  return devices.find((d) => d.isDefault)?.deviceId
}

export async function claimDevice(
  env: Env,
  deviceId: string,
  opts: { name?: string; deviceType?: string; makeDefault?: boolean } = {},
): Promise<Device> {
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new DeviceError(`'${deviceId}' is not a valid device id`)
  }
  await migrateLegacy(env)

  const store = hubStore(env)
  const existingRaw = await store.getItem(NS.device, deviceId)
  const existing = existingRaw ? (JSON.parse(existingRaw) as DeviceRecord) : undefined

  const record: DeviceRecord = {
    ...existing,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.deviceType !== undefined ? { deviceType: opts.deviceType } : {}),
    claimedAt: existing?.claimedAt ?? new Date().toISOString(),
  }
  await store.setItem(NS.device, deviceId, JSON.stringify(record))

  const current = await store.getItem(NS.hub, DEFAULT_ITEM)
  if (opts.makeDefault || !current) {
    await store.setItem(NS.hub, DEFAULT_ITEM, deviceId)
  }

  const devices = await listDevices(env)
  return devices.find((d) => d.deviceId === deviceId)!
}

/**
 * Release a device. It stops being carried by this hub immediately — the gate
 * reads the registry per request, so an open socket's next reconnect is refused.
 */
export async function releaseDevice(env: Env, deviceId: string): Promise<void> {
  await migrateLegacy(env)
  const store = hubStore(env)
  if ((await store.getItem(NS.device, deviceId)) === undefined) {
    throw new DeviceError(`'${deviceId}' is not claimed by this hub`, 404)
  }
  await store.delItem(NS.device, deviceId)

  // Never leave the default pointing at a device that is gone: federation would
  // fail with a confusing "not connected" instead of an honest "no device".
  if ((await store.getItem(NS.hub, DEFAULT_ITEM)) === deviceId) {
    const remaining = await listDevices(env)
    if (remaining.length > 0) {
      await store.setItem(NS.hub, DEFAULT_ITEM, remaining[0]!.deviceId)
    } else {
      await store.delItem(NS.hub, DEFAULT_ITEM)
    }
  }
}
