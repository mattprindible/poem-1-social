import { DurableObject } from "cloudflare:workers"

/**
 * Persistent storage for the hub itself, as opposed to the per-device relay
 * state that lives in DeviceAgent.
 *
 * A hub has exactly one owner, so this is a singleton Durable Object addressed
 * by a fixed name. It holds OAuth flow state, the owner's session, and (later)
 * the hub's published record.
 *
 * Namespaced key/value with optional expiry, because the two things it stores
 * have very different lifetimes: authorization states are short-lived and
 * disposable, sessions must survive.
 */
export class HubStore extends DurableObject {
  private key(ns: string, key: string) {
    return `${ns}:${key}`
  }

  async getItem(ns: string, key: string): Promise<string | undefined> {
    const record = await this.ctx.storage.get<{ v: string; exp?: number }>(this.key(ns, key))
    if (!record) return undefined
    if (record.exp !== undefined && Date.now() > record.exp) {
      // Lazy expiry: nothing sweeps these, so a stale read is what removes them.
      await this.ctx.storage.delete(this.key(ns, key))
      return undefined
    }
    return record.v
  }

  async setItem(ns: string, key: string, value: string, ttlMs?: number): Promise<void> {
    await this.ctx.storage.put(this.key(ns, key), {
      v: value,
      exp: ttlMs === undefined ? undefined : Date.now() + ttlMs,
    })
  }

  async delItem(ns: string, key: string): Promise<void> {
    await this.ctx.storage.delete(this.key(ns, key))
  }

  /**
   * Every live key/value in a namespace, as a plain object.
   *
   * Expiry is applied on read here exactly as getItem does it, so a caller
   * listing a namespace can never see an entry that a direct read would have
   * swept. Returning a plain object rather than a Map because this crosses a
   * Durable Object RPC boundary.
   */
  async listItems(ns: string): Promise<Record<string, string>> {
    const prefix = `${ns}:`
    const rows = await this.ctx.storage.list<{ v: string; exp?: number }>({ prefix })
    const now = Date.now()
    const out: Record<string, string> = {}
    for (const [key, record] of rows) {
      if (record.exp !== undefined && now > record.exp) {
        await this.ctx.storage.delete(key)
        continue
      }
      out[key.slice(prefix.length)] = record.v
    }
    return out
  }

  /** Wipe everything — used by /oauth/logout to fully unbind the hub. */
  async clearAll(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
}

export const HUB_SINGLETON = "hub"

/** Namespaces within the store. */
export const NS = {
  /** Short-lived OAuth authorization states, keyed by the `state` param. */
  state: "oauth-state",
  /** Long-lived OAuth sessions, keyed by the account DID. */
  session: "oauth-session",
  /** Hub-level facts: owner DID, federation key, the default device. */
  hub: "hub",
  /** Claimed devices, keyed by device id. One entry per device. */
  device: "device",
  /** Seen federation nonces, for replay rejection inside the skew window. */
  nonce: "fed-nonce",
  /** Browser sessions for the owner's control surface, keyed by session id. */
  ui: "ui-session",
} as const

/**
 * Key of the owner DID within `NS.hub`.
 *
 * Shared rather than spelled inline, because two very different modules now
 * depend on reading the same value — oauth-routes decides who may claim the
 * hub, auth decides whether a live session still belongs to whoever owns it.
 * A typo in either silently grants or denies control of the whole hub.
 */
export const OWNER_ITEM = "owner"

export function hubStore(env: Env): DurableObjectStub<HubStore> {
  return env.HubStore.get(env.HubStore.idFromName(HUB_SINGLETON))
}
