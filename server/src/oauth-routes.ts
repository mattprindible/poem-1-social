import { NS, hubStore } from "./hub-store"
import { IdentityError, resolveIdentity } from "./identity"
import { createOAuthClient } from "./oauth-client"
import { KeyError } from "./oauth"

// The hub's login flow. One hub, one owner: the first account to complete a
// login CLAIMS the hub, and after that only that DID may sign in.
//
// Without that rule a deployed hub is a land-grab — anyone who finds the URL
// could bind their own identity to a hub that relays to someone else's device.
// The claim is deliberately not tied to a password or invite: whoever can reach
// a freshly deployed hub first is its owner, which is fine because you deploy it
// and log in within the same minute. Re-claiming requires /oauth/logout, which
// only the current owner can call.

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Poem/1 hub</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem}
 code{background:#8881;padding:.15em .35em;border-radius:.25em}
 .err{color:#b00020} form{display:flex;gap:.5rem;margin:1.5rem 0}
 input{flex:1;padding:.5rem;font:inherit} button{padding:.5rem 1rem;font:inherit}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.err{color:#ff6b81}}
</style>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  )

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

async function getOwner(env: Env): Promise<string | undefined> {
  return hubStore(env).getItem(NS.hub, "owner")
}

/**
 * Walk the `cause` chain.
 *
 * The atproto errors wrap their real reason and present a generic message —
 * `JwtCreateError` in particular defaults to "Unable to create JWT" and hides
 * the underlying `JwkError` entirely. Reporting only `err.message` for those
 * says nothing at all, which cost a debugging round trip through a login flow
 * that can only be exercised by a human at a browser. So report the chain.
 */
function describeError(err: unknown, depth = 0): unknown {
  if (depth > 5 || err == null) return String(err)
  if (!(err instanceof Error)) return String(err)
  const out: Record<string, unknown> = { name: err.name, message: err.message }
  const code = (err as { code?: unknown }).code
  if (code !== undefined) out.code = code
  if (err.cause !== undefined) out.cause = describeError(err.cause, depth + 1)
  return out
}

export async function routeOAuthRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const origin = url.origin
  const path = url.pathname

  if (!path.startsWith("/oauth/")) return null

  try {
    // ── Start a login ────────────────────────────────────────────────────
    if (path === "/oauth/login") {
      const handle = url.searchParams.get("handle")?.trim()
      if (!handle) {
        const owner = await getOwner(env)
        return html(
          owner
            ? `<h1>Poem/1 hub</h1><p>This hub is owned by <code>${owner}</code>.</p>
               <p>Sign in again to refresh its authorization.</p>
               <form action="/oauth/login"><input name="handle" placeholder="you.bsky.social" autofocus>
               <button>Sign in</button></form>`
            : `<h1>Poem/1 hub</h1><p>This hub is <strong>unclaimed</strong>. The first account to
               sign in becomes its owner.</p>
               <form action="/oauth/login"><input name="handle" placeholder="you.bsky.social" autofocus>
               <button>Claim this hub</button></form>`,
        )
      }

      // Fail early with a useful message rather than deep inside the OAuth
      // machinery, and refuse a non-owner before sending them to a PDS at all.
      const identity = await resolveIdentity(handle)
      const owner = await getOwner(env)
      if (owner && owner !== identity.did) {
        return html(
          `<h1 class="err">Not your hub</h1><p>This hub belongs to <code>${owner}</code>.
           <code>${identity.handle ?? identity.did}</code> cannot sign in.</p>`,
          403,
        )
      }

      const client = await createOAuthClient(env, origin)
      const authUrl = await client.authorize(identity.did, {
        // Carried through the redirect and handed back at the callback.
        state: crypto.randomUUID(),
      })
      return Response.redirect(authUrl.toString(), 302)
    }

    // ── Return leg ───────────────────────────────────────────────────────
    if (path === "/oauth/callback") {
      // The PDS reports failures here too; surface them rather than throwing.
      const oauthError = url.searchParams.get("error")
      if (oauthError) {
        const desc = url.searchParams.get("error_description") ?? ""
        return html(`<h1 class="err">Authorization failed</h1><p><code>${oauthError}</code> ${desc}</p>`, 400)
      }

      const client = await createOAuthClient(env, origin)
      const { session } = await client.callback(url.searchParams)
      const did = session.did

      const store = hubStore(env)
      const owner = await getOwner(env)
      if (owner && owner !== did) {
        // Someone completed a flow for a different account. Drop the session we
        // just created rather than leaving a stranger's tokens on the hub.
        await client.revoke(did).catch(() => {})
        return html(`<h1 class="err">Not your hub</h1><p>This hub belongs to <code>${owner}</code>.</p>`, 403)
      }
      if (!owner) await store.setItem(NS.hub, "owner", did)

      return html(
        `<h1>Signed in</h1><p>This hub is authorized as <code>${did}</code>.</p>
         <p>Details: <a href="/oauth/session">/oauth/session</a></p>`,
      )
    }

    // ── Who is this hub? ─────────────────────────────────────────────────
    if (path === "/oauth/session") {
      const owner = await getOwner(env)
      if (!owner) return json({ claimed: false }, 404)

      const client = await createOAuthClient(env, origin)
      try {
        // restore() refreshes the token if needed, so this also proves the
        // stored session still actually works rather than merely existing.
        const session = await client.restore(owner)
        const identity = await resolveIdentity(session.did)
        return json({
          claimed: true,
          did: session.did,
          handle: identity.alsoKnownAs[0],
          pds: identity.pds,
          sessionValid: true,
        })
      } catch (err) {
        return json(
          {
            claimed: true,
            did: owner,
            sessionValid: false,
            message: err instanceof Error ? err.message : String(err),
          },
          503,
        )
      }
    }

    // ── Unbind the hub ───────────────────────────────────────────────────
    if (path === "/oauth/logout" && request.method === "POST") {
      const owner = await getOwner(env)
      if (owner) {
        const client = await createOAuthClient(env, origin)
        await client.revoke(owner).catch(() => {})
      }
      await hubStore(env).clearAll()
      return json({ ok: true, message: "hub unclaimed" })
    }

    return null
  } catch (err) {
    if (err instanceof KeyError) {
      return json({ error: "key_unavailable", message: err.message }, 503)
    }
    if (err instanceof IdentityError) {
      return json({ error: "identity_error", message: err.message }, err.status)
    }
    return json(
      {
        error: "oauth_error",
        message: err instanceof Error ? err.message : String(err),
        detail: describeError(err),
      },
      500,
    )
  }
}
