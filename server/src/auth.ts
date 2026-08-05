import { NS, OWNER_ITEM, hubStore } from "./hub-store"

// Owner authentication for the hub's own control surface.
//
// Distinct from — and unrelated to — the hub-to-hub authentication in
// federation.ts. That answers "is this request really from that DID"; this
// answers "is the person making this request the owner of THIS hub".
//
// Missing it was a genuine hole. Every mutating route was reachable by anyone
// who knew the hub's URL, and hub URLs are published in atproto repos, so they
// are public by design. The worst chain was two requests long:
//
//   POST /oauth/logout   -> clears the owner, hub becomes unclaimed
//   GET  /oauth/login    -> attacker signs in and now owns the hub that a
//                           stranger's device relays through
//
// Two accepted credentials, because the control surface has two very different
// users:
//
//   - a browser session cookie, issued when the owner completes an OAuth login
//   - `Authorization: Bearer <HUB_ADMIN_TOKEN>`, a Worker secret, for CLI and
//     automation which have no cookie jar
//
// Bearer auth is only enabled when HUB_ADMIN_TOKEN is set, so a hub that never
// sets one is cookie-only rather than accidentally open.

const COOKIE_NAME = "san_hub_session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export class AuthError extends Error {
  constructor(
    message = "owner authentication required",
    readonly status = 401,
  ) {
    super(message)
    this.name = "AuthError"
  }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Length-independent, content-constant-time comparison. The lengths of these
 * values are not secret; their contents are.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return undefined
}

/**
 * Start a browser session for the owner. Returns the Set-Cookie value.
 *
 * The cookie is an opaque random id looked up server-side rather than a signed
 * assertion — no signature to get wrong, and revocation is a store delete.
 */
export async function createOwnerSession(env: Env, did: string): Promise<string> {
  const sessionId = randomToken()
  await hubStore(env).setItem(NS.ui, sessionId, did, SESSION_TTL_MS)
  return [
    `${COOKIE_NAME}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    // Lax rather than Strict: the OAuth callback is a cross-site redirect back
    // from the PDS, and Strict would withhold the cookie on that navigation.
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join("; ")
}

export async function clearOwnerSession(env: Env, request: Request): Promise<string> {
  const sessionId = readCookie(request, COOKIE_NAME)
  if (sessionId) await hubStore(env).delItem(NS.ui, sessionId)
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

async function didFromCookie(env: Env, request: Request): Promise<string | undefined> {
  const sessionId = readCookie(request, COOKIE_NAME)
  if (!sessionId) return undefined
  return hubStore(env).getItem(NS.ui, sessionId)
}

function bearerMatches(env: Env, request: Request): boolean {
  const expected = env.HUB_ADMIN_TOKEN
  if (!expected) return false // no token configured => bearer auth disabled
  const header = request.headers.get("Authorization") ?? ""
  const [scheme, ...rest] = header.split(" ")
  if (scheme?.toLowerCase() !== "bearer") return false
  return timingSafeEqual(rest.join(" ").trim(), expected)
}

/**
 * Gate for anything that mutates the hub or reveals its secrets.
 *
 * Deliberately NOT applied to `/federation/inbox`: that request is
 * authenticated by its signature, and requiring an owner credential there would
 * make federation impossible.
 */
export async function requireOwner(env: Env, request: Request): Promise<void> {
  if (bearerMatches(env, request)) return

  const sessionDid = await didFromCookie(env, request)
  if (sessionDid) {
    // A session cookie proves "this browser once signed in as that DID". It
    // does NOT prove "that DID still owns this hub", and the two come apart
    // exactly when it matters most: ownership can be released (POST
    // /oauth/logout) and the hub re-claimed by someone else, while sessions
    // issued to the previous owner stay valid for their full 30 days.
    //
    // Logout clears the session it was called with, so the obvious path
    // self-heals — but only that ONE browser. Any other session the previous
    // owner still holds would otherwise keep full control of a hub they no
    // longer own, including the device it relays to. Re-reading the owner on
    // every request is what makes an ownership change revoke sessions.
    const owner = await hubStore(env).getItem(NS.hub, OWNER_ITEM)
    if (owner && sessionDid === owner) return
    throw new AuthError(
      owner
        ? "this session belongs to an account that no longer owns this hub — sign in again"
        : "this hub is unclaimed; the session that created it is no longer valid",
      403,
    )
  }

  throw new AuthError(
    "owner authentication required — sign in at /oauth/login, or send " +
      "Authorization: Bearer <HUB_ADMIN_TOKEN>",
  )
}

/** True when the caller holds an owner credential. For conditional UI. */
export async function isOwner(env: Env, request: Request): Promise<boolean> {
  try {
    await requireOwner(env, request)
    return true
  } catch {
    return false
  }
}
