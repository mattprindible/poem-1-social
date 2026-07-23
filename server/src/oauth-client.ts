import { JoseKey } from "@atproto/jwk-jose"
import { WebcryptoKey } from "@atproto/jwk-webcrypto"
import {
  OAuthClient,
  type HandleResolver,
  type InternalStateData,
  type RuntimeImplementation,
  type SessionStore,
  type StateStore,
} from "@atproto/oauth-client"
import { asResolvedHandle, type ResolvedHandle } from "@atproto-labs/handle-resolver"
import type { DidResolver } from "@atproto-labs/did-resolver"

import { fetchDidDocument, resolveHandle } from "./identity"
import { NS, hubStore } from "./hub-store"
import { clientMetadata, parsePrivateJwk } from "./oauth"

// Wiring @atproto/oauth-client to run on Cloudflare Workers.
//
// The official Node client cannot run here and the community Workers fork is
// long stale, so this supplies the environment-specific pieces the maintained
// base package asks for. The gaps are exactly the ones catalogued in
// bluesky-social/atproto#3292:
//
//   1. fetch `cache` is unsupported          -> stripped below
//   2. fetch `redirect: "error"` unsupported -> our own DID resolver; see
//                                               makeDidResolver for why a fetch
//                                               wrapper cannot fix this one
//   3. keys don't survive JSON storage       -> serialised as JWK, rebuilt on read
//   4. handle resolution needs DNS           -> our own resolver from identity.ts
//
// Authorization states expire fast; nothing sweeps the store, so give them a
// bound. An hour is far longer than a login takes and short enough that
// abandoned flows don't accumulate.
const STATE_TTL_MS = 60 * 60 * 1000

/**
 * Workers reject `cache`, and `redirect: "error"` is not implemented. "manual"
 * is equivalent for our purposes: the client only ever wants to *not follow* a
 * redirect, and a non-ok response achieves that.
 */
const workersFetch: typeof globalThis.fetch = (input, init?) => {
  if (!init) return globalThis.fetch(input)
  // `cache` isn't in the Workers RequestInit type at all, but the library sets
  // it at runtime, so it has to be stripped through a loose view of the object.
  const { cache: _unsupportedOnWorkers, redirect, ...rest } = init as RequestInit & {
    cache?: unknown
  }
  return globalThis.fetch(input, {
    ...rest,
    ...(redirect ? { redirect: redirect === "error" ? "manual" : redirect } : {}),
  })
}

const runtimeImplementation: RuntimeImplementation = {
  // `extractable: true` is REQUIRED here, and the reason is not obvious.
  //
  // WebcryptoKey.fromKeypair exports the PUBLIC key when the private key is
  // non-extractable (the default), while WebcryptoKey.isPrivate still returns
  // true unconditionally. So a default-generated key reports a `privateJwk`
  // that silently contains no `d`. In memory it signs perfectly well, because
  // WebcryptoKey overrides getKeyObj to use the live CryptoKey — the damage
  // only appears after the key is persisted and revived, as a public key that
  // cannot sign: "CryptoKey instances for asymmetric algorithm signing must be
  // of type private".
  //
  // A browser client never notices because it keeps the CryptoKey in IndexedDB.
  // A server that serialises sessions does. keyToJwk below now also refuses a
  // JWK with no `d`, so this cannot regress quietly.
  createKey: (algs) => WebcryptoKey.generate([...algs], crypto.randomUUID(), { extractable: true }),
  getRandomValues: (length) => crypto.getRandomValues(new Uint8Array(length)),
  digest: async (data, alg) => {
    // 'sha256' -> 'SHA-256', which is what WebCrypto expects.
    const name = alg.name.replace(/^sha(\d+)$/, "SHA-$1")
    return new Uint8Array(await crypto.subtle.digest(name, data))
  },
}

/**
 * The client's DPoP keys are live crypto objects, so they cannot round-trip
 * through storage as-is. Persist the JWK and rebuild the key on read — point 3
 * of #3292, and the one most likely to fail silently if skipped.
 */
async function reviveKey(jwk: unknown) {
  return JoseKey.fromJWK(jwk as Record<string, unknown>)
}

function keyToJwk(key: { privateJwk?: unknown; alg?: string }) {
  const jwk = key.privateJwk as Record<string, unknown> | undefined
  if (!jwk) {
    throw new Error("DPoP key is not extractable — cannot persist the session")
  }
  // `privateJwk` being present is NOT proof the key is private: a
  // non-extractable WebcryptoKey hands back its public JWK while still
  // reporting isPrivate === true. Without `d` the revived key cannot sign, and
  // the failure surfaces much later as an opaque "Unable to create JWT".
  if (typeof jwk.d !== "string") {
    throw new Error(
      "refusing to persist a DPoP key with no private component — " +
        "it was generated non-extractable and would be unusable once revived",
    )
  }
  // WebCrypto omits `alg` when exporting an EC JWK, so carry the key's own
  // algorithm across explicitly rather than leaving the revived key to infer it
  // from the curve.
  return key.alg && !jwk.alg ? { ...jwk, alg: key.alg } : jwk
}

function makeStateStore(env: Env): StateStore {
  const store = hubStore(env)
  return {
    async get(key) {
      const raw = await store.getItem(NS.state, key)
      if (!raw) return undefined
      const data = JSON.parse(raw)
      return { ...data, dpopKey: await reviveKey(data.dpopKey) } as InternalStateData
    },
    async set(key, value) {
      const raw = JSON.stringify({ ...value, dpopKey: keyToJwk(value.dpopKey) })
      await store.setItem(NS.state, key, raw, STATE_TTL_MS)
    },
    async del(key) {
      await store.delItem(NS.state, key)
    },
  }
}

function makeSessionStore(env: Env): SessionStore {
  const store = hubStore(env)
  return {
    async get(sub) {
      const raw = await store.getItem(NS.session, sub)
      if (!raw) return undefined
      const data = JSON.parse(raw)
      return { ...data, dpopKey: await reviveKey(data.dpopKey) }
    },
    async set(sub, value) {
      // No TTL: the refresh token is what keeps this alive, and the client
      // refreshes it in place. Removal is explicit (logout, or revocation).
      await store.setItem(NS.session, sub, JSON.stringify({ ...value, dpopKey: keyToJwk(value.dpopKey) }))
    },
    async del(sub) {
      await store.delItem(NS.session, sub)
    },
  }
}

/**
 * Replace the bundled DID resolver with ours.
 *
 * Blocker #2 in earnest: @atproto-labs/did-resolver's PLC method calls fetch
 * with `redirect: "error"`, which Workers do not implement — and it goes through
 * bindFetch, which invokes fetch with a fully-built `Request`. So the option is
 * baked into the Request before our fetch wrapper can see it, and a wrapper
 * cannot repair it. Supplying the resolver outright is both the fix and the
 * simpler arrangement: DID resolution now takes one path through identity.ts,
 * which is already tested against real accounts.
 */
function makeDidResolver(): DidResolver<"plc" | "web"> {
  return {
    async resolve(did) {
      return (await fetchDidDocument(did)) as never
    },
  }
}

/**
 * Our resolver, adapted to the interface the OAuth client expects. It wants
 * `null` for "no such handle" and reserves throwing for real failures; ours
 * throws for both, so unresolvable handles are translated back to null.
 */
function makeHandleResolver(): HandleResolver {
  return {
    async resolve(handle: string): Promise<ResolvedHandle> {
      try {
        // Our resolver validates the DID shape already; asResolvedHandle
        // re-checks and applies the branded type the client expects.
        return asResolvedHandle(await resolveHandle(handle))
      } catch {
        return null
      }
    },
  }
}

export async function createOAuthClient(env: Env, origin: string): Promise<OAuthClient> {
  const clientKey = await JoseKey.fromJWK(
    parsePrivateJwk(env.HUB_PRIVATE_JWK) as unknown as Record<string, unknown>,
  )
  return new OAuthClient({
    // The callback is a plain server-side GET, so params arrive in the query.
    responseMode: "query",
    clientMetadata: clientMetadata(origin),
    keyset: [clientKey],
    stateStore: makeStateStore(env),
    sessionStore: makeSessionStore(env),
    runtimeImplementation,
    handleResolver: makeHandleResolver(),
    didResolver: makeDidResolver(),
    fetch: workersFetch,
  })
}
