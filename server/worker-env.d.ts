// Declarations `wrangler types` cannot produce, merged into the generated Env.
//
// wrangler discovers bindings from wrangler.jsonc and secrets from .dev.vars, so
// HUB_PRIVATE_JWK and the Durable Object namespaces come from env.d.ts and are
// deliberately not repeated here.
//
// HUB_ADMIN_TOKEN is absent from .dev.vars on purpose — it is an optional
// production credential, and a hub that never sets one is cookie-only rather
// than accidentally open — so it is the one thing that has to be declared by
// hand.
//
// Install with: npx wrangler secret put HUB_ADMIN_TOKEN
interface Env {
  /**
   * Shared secret accepted as `Authorization: Bearer` on owner-only routes, for
   * CLI and automation, which have no cookie jar. Optional: when unset, those
   * routes accept only the browser session cookie issued by /oauth/login.
   */
  HUB_ADMIN_TOKEN?: string;
}
