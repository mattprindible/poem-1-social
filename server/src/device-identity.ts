import { NS, hubStore } from "./hub-store"

// Real device identity: a key the device generates, keeps, and proves.
//
// The relay gate (device-gate.ts) can tell a CLAIMED device id from an
// unclaimed one. It cannot tell a device from somebody who read the id off the
// device's screen — ids are printed there, and they are the only thing a device
// presents. This is the half that closes that.
//
// The device generates a P-256 keypair on first boot and keeps the private half
// in NVS. It never sends it. Not a hub-issued shared secret: a secret has to be
// DELIVERED, which means either a per-device firmware build (exactly what
// runtime hub config exists to avoid) or a provisioning channel that is itself
// unauthenticated. A device-generated key needs no delivery.
//
// P-256 because mbedtls has it on the ESP32-S3 and the hub already speaks ES256
// for federation — one curve, one set of mistakes to avoid.
//
// ── The handshake ────────────────────────────────────────────────────────────
//   hub  -> device   challenge: a fresh random nonce, per CONNECTION
//   device -> hub    { pubkey, sig } over that nonce
//   hub              verify against the key bound to this device id
//
// The nonce is what makes it a proof rather than a password. A replayed hello is
// worthless because the nonce it signed is never issued twice.

/** Per-device identity, stored alongside the claim in NS.device. */
export interface DeviceKey {
  /** Base64 of the uncompressed P-256 point (0x04 ‖ X ‖ Y), 65 bytes. */
  pubkey: string
  boundAt: string
  /** Short, human-comparable digest — the device draws this on its own screen. */
  fingerprint: string
}

/** Key of the open pairing window within NS.hub. */
const WINDOW_ITEM = "pair-window"

/** Long enough to power-cycle a device and watch it come up; short enough to matter. */
export const PAIR_WINDOW_MS = 5 * 60 * 1000

const b64 = {
  decode(s: string): Uint8Array {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  },
  encode(b: Uint8Array): string {
    return btoa(String.fromCharCode(...b))
  },
}

/**
 * Six hex characters of SHA-256 over the public key.
 *
 * Short on purpose: its job is to be read off a small screen and compared by a
 * human, and a fingerprint nobody actually compares protects nothing. It is a
 * confirmation that the key the hub bound is the key the device holds — not a
 * primary defence, which is what the pairing window is for.
 */
export async function fingerprintOf(pubkeyB64: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", b64.decode(pubkeyB64) as BufferSource)
  return [...new Uint8Array(digest).slice(0, 3)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Verify a signature over the challenge.
 *
 * Raw r‖s (64 bytes), not DER: WebCrypto's ECDSA verify wants raw, and mbedtls
 * hands the firmware r and s as separate integers anyway, so DER would mean
 * both sides doing extra work to meet in a format neither wanted.
 */
export async function verifySignature(
  pubkeyB64: string,
  challenge: string,
  sigB64: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64.decode(pubkeyB64) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64.decode(sigB64) as BufferSource,
      new TextEncoder().encode(challenge) as BufferSource,
    )
  } catch {
    // A malformed key or signature is a failed proof, not an exception — this
    // is reached by anything that can open a socket, so it must not be a way to
    // make the hub throw.
    return false
  }
}

export function newChallenge(): string {
  return b64.encode(crypto.getRandomValues(new Uint8Array(32)))
}

// ── Pairing window ───────────────────────────────────────────────────────────
// The hub has no key for a new device, so someone must say "this one is mine".
// The owner opens a window; the first device presenting a key for that id during
// it gets bound; every later connection must match.
//
// Not permanent trust-on-first-use: a device reconnects constantly, so an
// attacker gets many chances to be first, and "first" is not something anyone
// can check afterwards. A window makes the risky moment short and deliberate.

interface PairWindow {
  deviceId: string
  expiresAt: number
}

export async function openPairWindow(env: Env, deviceId: string): Promise<PairWindow> {
  const win: PairWindow = { deviceId, expiresAt: Date.now() + PAIR_WINDOW_MS }
  await hubStore(env).setItem(NS.hub, WINDOW_ITEM, JSON.stringify(win), PAIR_WINDOW_MS)
  return win
}

export async function readPairWindow(env: Env): Promise<PairWindow | null> {
  const raw = await hubStore(env).getItem(NS.hub, WINDOW_ITEM)
  if (!raw) return null
  const win = JSON.parse(raw) as PairWindow
  return win.expiresAt > Date.now() ? win : null
}

export async function closePairWindow(env: Env): Promise<void> {
  await hubStore(env).delItem(NS.hub, WINDOW_ITEM)
}

/**
 * What a hub should do with a connection presenting (or not presenting) a key.
 *
 * `legacy` is the migration path and the one worth being careful about. A device
 * on firmware without identity has no key to offer, and refusing it would brick
 * every running hub the moment this deploys. So a device with NO BOUND KEY is
 * allowed through as before — but once a key is bound, that device can never go
 * back to unauthenticated. The weaker mode is only reachable by a device that
 * has never proved anything, never as a downgrade.
 */
export type IdentityVerdict =
  | { state: "verified"; fingerprint: string }
  | { state: "bound"; fingerprint: string } // just paired
  | { state: "legacy" } // no key on file, none offered
  | { state: "refused"; reason: string }

export async function judgeIdentity(
  env: Env,
  deviceId: string,
  stored: DeviceKey | undefined,
  offered: { pubkey?: string; sig?: string } | null,
  challenge: string,
): Promise<IdentityVerdict> {
  // ── The device has a key on file ───────────────────────────────────────
  if (stored) {
    if (!offered?.pubkey || !offered.sig) {
      return {
        state: "refused",
        reason: "this device has an identity key on file but presented none — refusing to downgrade",
      }
    }
    if (offered.pubkey !== stored.pubkey) {
      return { state: "refused", reason: "presented key does not match the one bound to this device" }
    }
    if (!(await verifySignature(stored.pubkey, challenge, offered.sig))) {
      return { state: "refused", reason: "signature did not verify against the bound key" }
    }
    return { state: "verified", fingerprint: stored.fingerprint }
  }

  // ── No key on file ─────────────────────────────────────────────────────
  if (!offered?.pubkey || !offered.sig) return { state: "legacy" }

  const win = await readPairWindow(env)
  if (!win || win.deviceId !== deviceId) {
    // A key was offered but nobody asked for one. Not an error — the device is
    // simply running ahead of its pairing — but it must not bind silently.
    return { state: "legacy" }
  }
  if (!(await verifySignature(offered.pubkey, challenge, offered.sig))) {
    return { state: "refused", reason: "signature did not verify against the offered key" }
  }

  return { state: "bound", fingerprint: await fingerprintOf(offered.pubkey) }
}
