import { listDevices } from "./devices"

// What this hub can accept, described so a mutual can ask instead of assume.
//
// THE RULE: a hub should never hold a cached belief about what a mutual has. It
// should ask. Beliefs go stale silently — someone retires a board, adds one,
// reflashes — and a stale belief is worse than none, because it gets acted on
// with confidence. Discovery here is a live question with a live answer.
//
// ── Profiles, never identities ───────────────────────────────────────────────
// This returns device PROFILES and deliberately not device ids, not counts, not
// names. A device id is a credential on the relay (device-gate.ts), and nothing
// about discovery justifies moving one between hubs — federation has protected
// that property since the first push and this must not be the thing that leaks
// it. Counts and names are the owner's business too: "I have four devices, one
// called bedroom" is not information a push needs.
//
// What a sender legitimately needs is narrow: "will an app shaped like this work
// on anything you have?" That is answerable from shape alone.
//
// ── Why it is the device's own word where possible ───────────────────────────
// A profile is built from what the device REPORTED about itself over a verified
// connection, falling back to what the owner declared at claim time. The
// distinction is carried in `source` rather than smoothed away, because "the
// device says it is a Poem/1" and "someone typed poem1" are different claims and
// a peer deciding what to push should be able to tell which one it got.

export interface DeviceProfile {
  deviceType: string
  /** Whatever the device reported about its display, when it reported any. */
  screen?: Record<string, unknown>
  /** `device` when self-reported over a proved connection, else `owner`. */
  source: "device" | "owner"
}

/**
 * Distinct profiles this hub can accept, deduplicated.
 *
 * Deduplication is not only tidiness: it is what stops the list being a device
 * count. Three identical Poem/1s and one Poem/1 answer the same, which is the
 * correct amount for a sender to learn.
 */
export async function hubProfiles(env: Env): Promise<DeviceProfile[]> {
  const devices = await listDevices(env)
  const seen = new Map<string, DeviceProfile>()

  for (const device of devices) {
    const reported = device.reported as { deviceType?: unknown; screen?: unknown } | undefined
    const fromDevice = typeof reported?.deviceType === "string" ? reported.deviceType : undefined
    const deviceType = fromDevice ?? device.deviceType
    if (!deviceType) continue // nothing known about it; say nothing rather than guess

    const screen =
      reported?.screen && typeof reported.screen === "object"
        ? (reported.screen as Record<string, unknown>)
        : undefined

    const profile: DeviceProfile = {
      deviceType,
      ...(screen ? { screen } : {}),
      source: fromDevice ? "device" : "owner",
    }

    // Key on the whole shape, so two boards of the same type with different
    // screens stay distinguishable — that difference is exactly what a sender
    // needs and exactly what a type name alone would hide.
    const key = JSON.stringify(profile)
    if (!seen.has(key)) seen.set(key, profile)
  }

  return [...seen.values()]
}
