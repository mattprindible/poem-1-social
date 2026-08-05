import { routeDeviceRequest } from "@inanimate/resident/cloudflare"
import { DeviceAgent } from "./device-agent"
import {
  CLIENT_METADATA_PATH,
  JWKS_PATH,
  clientMetadata,
  parsePrivateJwk,
  publicJwk,
  KeyError,
} from "./oauth"
import { IdentityError, resolveIdentity } from "./identity"
import { HubStore } from "./hub-store"
import { routeOAuthRequest } from "./oauth-routes"
import { routeHubIdentityRequest } from "./hub-routes"
import { routeFederationRequest } from "./federation-routes"

// Cloudflare needs the Durable Object classes re-exported at the worker entry
// so it can instantiate them for the bindings declared in wrangler.jsonc.
//
// `DeviceAgent` is OUR subclass (./device-agent), not upstream's, so the device
// can talk back — but it is exported under the same name upstream's had, which
// is what keeps the binding and its migration identity unchanged. See the
// header of device-agent.ts.
export { DeviceAgent, HubStore }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

/**
 * The hub's own routes, as distinct from the Resident device protocol.
 * Returns null when nothing here matches, so the caller can 404.
 */
async function routeHubRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const origin = url.origin

  // Advertise the hub as an OAuth client. The client_id IS this URL.
  if (url.pathname === CLIENT_METADATA_PATH && request.method === "GET") {
    return json(clientMetadata(origin))
  }

  // Public half of the client signing key, referenced by jwks_uri above.
  if (url.pathname === JWKS_PATH && request.method === "GET") {
    try {
      return json({ keys: [publicJwk(parsePrivateJwk(env.HUB_PRIVATE_JWK))] })
    } catch (err) {
      if (err instanceof KeyError) {
        // 503, not 500: the hub is deployed and healthy, it just has not been
        // given its key yet. Distinguishing the two matters during setup.
        return json({ error: "key_unavailable", message: err.message }, 503)
      }
      throw err
    }
  }

  // Resolve a handle or DID to its DID document and PDS. Read-only and
  // unauthenticated — it exposes nothing that is not already public — and it is
  // the first half of the trust chain in docs/social-plan.md, so being able to
  // check it directly is worth an endpoint.
  if (url.pathname.startsWith("/identity/") && request.method === "GET") {
    const subject = decodeURIComponent(url.pathname.slice("/identity/".length))
    if (!subject) return json({ error: "bad_request", message: "no handle or DID given" }, 400)
    try {
      return json(await resolveIdentity(subject))
    } catch (err) {
      if (err instanceof IdentityError) {
        return json({ error: "identity_error", message: err.message }, err.status)
      }
      throw err
    }
  }

  return null
}

export default {
  async fetch(request: Request, env: Env) {
    // Device protocol first: it owns /devices/* and GET /, the latter because
    // Courier reads the HTTP Date header there as its time-sync fallback.
    const res = await routeDeviceRequest(request, env.DeviceAgent)
    if (res) return res

    const hub = await routeHubRequest(request, env)
    if (hub) return hub

    const oauth = await routeOAuthRequest(request, env)
    if (oauth) return oauth

    const federation = await routeFederationRequest(request, env)
    if (federation) return federation

    const hubIdentity = await routeHubIdentityRequest(request, env)
    if (hubIdentity) return hubIdentity

    return new Response("Not found", { status: 404 })
  },
} satisfies ExportedHandler<Env>
