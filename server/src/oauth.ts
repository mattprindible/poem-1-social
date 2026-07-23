// The hub's own OAuth client identity.
//
// atproto replaces client registration with a *client metadata document*: the
// client_id IS a public HTTPS URL serving JSON that describes the client. There
// is no central registry and no shared secret to obtain from anyone. That is
// unusually convenient for this project — every self-deployed hub is
// automatically its own OAuth client, with nobody's permission, which is what
// makes "everyone runs their own hub" survivable. See docs/social-plan.md.
//
// The hub is a *confidential* client: it holds a private key server-side and
// authenticates with private_key_jwt. Confidential clients get longer session
// lifetimes, and the key never leaves the Worker.

export interface ClientMetadata {
  client_id: string;
  client_name: string;
  client_uri: string;
  /** Non-empty tuple: the OAuth client types require at least one entry. */
  redirect_uris: [string, ...string[]];
  // Exact tuples, not string[] — the OAuth client's types require non-empty
  // tuples of known literals.
  grant_types: ["authorization_code", "refresh_token"];
  response_types: ["code"];
  scope: string;
  application_type: "web";
  token_endpoint_auth_method: "private_key_jwt";
  token_endpoint_auth_signing_alg: "ES256";
  dpop_bound_access_tokens: true;
  jwks_uri: string;
}

// `atproto` is mandatory for every atproto OAuth session.
//
// `transition:generic` is what currently authorises writing records to the
// user's repo, which is how the hub publishes its own hub record. It is a
// transitional scope carried over from the password-auth era and is broader
// than we want — it grants blob uploads and preference access we never use.
// Replace it with a granular permission scope once the Permissions Spec lands
// something narrower; that is a one-line change here plus a re-auth.
export const HUB_SCOPE = "atproto transition:generic";

export const CALLBACK_PATH = "/oauth/callback";
export const CLIENT_METADATA_PATH = "/client-metadata.json";
export const JWKS_PATH = "/.well-known/jwks.json";

/**
 * Build the metadata document. Everything is derived from the request origin so
 * a hub is correct wherever it is deployed — no hardcoded hostname, which also
 * means a fresh `wrangler deploy` under someone else's account just works.
 */
export function clientMetadata(origin: string): ClientMetadata {
  return {
    client_id: `${origin}${CLIENT_METADATA_PATH}`,
    client_name: "Poem/1 Social hub",
    client_uri: origin,
    redirect_uris: [`${origin}${CALLBACK_PATH}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: HUB_SCOPE,
    application_type: "web",
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${origin}${JWKS_PATH}`,
  };
}

export interface PrivateJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export class KeyError extends Error {}

export function parsePrivateJwk(raw: string | undefined): PrivateJwk {
  if (!raw) {
    throw new KeyError(
      "HUB_PRIVATE_JWK is not set. Generate one with `npm run gen-key` and " +
        "install it with `npx wrangler secret put HUB_PRIVATE_JWK`.",
    );
  }
  let jwk: PrivateJwk;
  try {
    jwk = JSON.parse(raw) as PrivateJwk;
  } catch {
    throw new KeyError("HUB_PRIVATE_JWK is not valid JSON");
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) {
    throw new KeyError("HUB_PRIVATE_JWK must be a P-256 (ES256) private JWK");
  }
  if (!jwk.kid) throw new KeyError("HUB_PRIVATE_JWK must include a 'kid'");
  return jwk;
}

/** The public half, for the JWKS endpoint. Strips the private component. */
export function publicJwk(priv: PrivateJwk): PrivateJwk {
  const { d: _discardPrivateComponent, ...pub } = priv;
  return { ...pub, alg: "ES256", use: "sig" };
}
