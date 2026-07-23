// Secrets live in Cloudflare's secret store, not in wrangler.jsonc, so
// `wrangler types` cannot discover them and env.d.ts will never list them.
// Declared here instead; TypeScript merges this into the generated Env.
//
// Install with:  npx wrangler secret put HUB_PRIVATE_JWK
// Generate with: npm run gen-key
interface Env {
  /** ES256 (P-256) private JWK, JSON-encoded. The hub's OAuth client key. */
  HUB_PRIVATE_JWK?: string;
}
