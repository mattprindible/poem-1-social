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
  /** Hub-level facts: owner DID, federation key, this hub's device. */
  hub: "hub",
  /** Seen federation nonces, for replay rejection inside the skew window. */
  nonce: "fed-nonce",
  /** Browser sessions for the owner's control surface, keyed by session id. */
  ui: "ui-session",
} as const

export function hubStore(env: Env): DurableObjectStub<HubStore> {
  return env.HubStore.get(env.HubStore.idFromName(HUB_SINGLETON))
}
