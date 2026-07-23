import { NS, hubStore } from "./hub-store"

// The hub's *federation* signing key: how this hub proves it is itself to other
// people's hubs.
//
// Deliberately NOT the OAuth client key (HUB_PRIVATE_JWK). They face different
// directions and belong to different trust domains:
//
//   OAuth client key  — proves the hub to the owner's PDS (private_key_jwt).
//                       Must be a stable, manually-installed secret, because it
//                       is advertised at /.well-known/jwks.json.
//   Federation key    — proves the hub to OTHER hubs, via the public half
//                       published in the owner's atproto repo.
//
// Keeping them separate means compromise of one does not imply the other, and
// either can be rotated without touching the other. It also means the
// federation key can generate itself on first use rather than requiring another
// setup step — which matters for the "one binary anyone can deploy" goal in
// docs/social-plan.md.
//
// Rotation is: delete it, let it regenerate, republish the record. Because the
// public half lives in a record the owner controls, publishing the new key is
// what revokes the old one — the revocation story the plan chose this design
// for in the first place.

const KEY_ITEM = "signing-key"

export interface PublicJwkEC {
  kty: "EC"
  crv: "P-256"
  x: string
  y: string
  kid: string
  alg: "ES256"
  use: "sig"
}

interface StoredKey {
  privateJwk: JsonWebKey & { kid?: string }
  publicJwk: PublicJwkEC
}

/** Short, stable id derived from the public key material. */
async function thumbprint(pub: JsonWebKey): Promise<string> {
  // RFC 7638 orders the members lexicographically for EC keys.
  const canonical = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  let binary = ""
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16)
}

async function generate(): Promise<StoredKey> {
  // Workers type generateKey as CryptoKey | CryptoKeyPair; ECDSA always yields
  // a pair.
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    // Extractable, and for good reason — see the WebcryptoKey trap documented in
    // oauth-client.ts: a non-extractable key cannot be persisted, and the
    // failure only appears much later as an unsignable revived key.
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
  const rawPublic = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey
  const kid = await thumbprint(rawPublic)

  return {
    privateJwk: { ...privateJwk, kid },
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: rawPublic.x as string,
      y: rawPublic.y as string,
      kid,
      alg: "ES256",
      use: "sig",
    },
  }
}

/**
 * Fetch the hub's federation key, generating and persisting one on first call.
 *
 * @note Two simultaneous first-calls could each generate a key and one would
 * win. Harmless in practice — the hub is single-owner and this runs at most
 * once per deployment — and the Durable Object serialises the writes.
 */
export async function getHubKey(env: Env): Promise<StoredKey> {
  const store = hubStore(env)
  const existing = await store.getItem(NS.hub, KEY_ITEM)
  if (existing) return JSON.parse(existing) as StoredKey

  const fresh = await generate()
  await store.setItem(NS.hub, KEY_ITEM, JSON.stringify(fresh))
  return fresh
}

export async function getHubPublicJwk(env: Env): Promise<PublicJwkEC> {
  return (await getHubKey(env)).publicJwk
}

/** Drop the key so the next call mints a new one. Republish the record after. */
export async function rotateHubKey(env: Env): Promise<PublicJwkEC> {
  await hubStore(env).delItem(NS.hub, KEY_ITEM)
  return getHubPublicJwk(env)
}

/** Sign bytes with the federation key. Used for hub-to-hub requests. */
export async function signWithHubKey(env: Env, data: Uint8Array): Promise<Uint8Array> {
  const { privateJwk } = await getHubKey(env)
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data)
  return new Uint8Array(sig)
}
