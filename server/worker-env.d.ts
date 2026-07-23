// Bindings and secrets that `wrangler types` does not produce for us.
//
// Secrets live in Cloudflare's secret store rather than wrangler.jsonc, so they
// can never be generated. The HubStore namespace is declared here too because
// `wrangler types` refuses to regenerate over the existing env.d.ts.
// TypeScript merges this into the generated Env.
//
// Install the key with: npx wrangler secret put HUB_PRIVATE_JWK
// Generate one with:    npm run gen-key
interface Env {
  /** ES256 (P-256) private JWK, JSON-encoded. The hub's OAuth client key. */
  HUB_PRIVATE_JWK?: string;

  /** Singleton store for hub-level state: OAuth sessions and the owner DID. */
  HubStore: DurableObjectNamespace<import("./src/hub-store").HubStore>;
}
