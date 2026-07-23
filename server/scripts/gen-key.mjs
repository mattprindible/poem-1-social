#!/usr/bin/env node
//
// Generate the hub's OAuth client signing key (ES256 / P-256) as a JWK.
//
//   npm run gen-key
//   npx wrangler secret put HUB_PRIVATE_JWK    # paste the JSON when prompted
//
// This key is how the hub proves it is itself to a PDS (private_key_jwt), and
// the public half is published at /.well-known/jwks.json. It is a secret: it
// stays in Cloudflare's secret store and is never committed. Losing it is not
// fatal — generate a new one and re-authorise; the old public key stops being
// advertised the moment the new one is installed.
//
// Uses WebCrypto only, so it needs no dependencies.

import { webcrypto } from "node:crypto";

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true, // extractable — we need to export it once, here
  ["sign", "verify"],
);

const priv = await webcrypto.subtle.exportKey("jwk", privateKey);
const pub = await webcrypto.subtle.exportKey("jwk", publicKey);

// A stable key id so a JWKS with several keys stays unambiguous during rotation.
const thumbprintInput = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y });
const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(thumbprintInput));
const kid = Buffer.from(digest).toString("base64url").slice(0, 16);

const jwk = {
  kty: priv.kty,
  crv: priv.crv,
  x: priv.x,
  y: priv.y,
  d: priv.d,
  kid,
  alg: "ES256",
  use: "sig",
};

console.error("\nPrivate JWK (secret — paste into `wrangler secret put HUB_PRIVATE_JWK`):\n");
console.log(JSON.stringify(jwk));
console.error(`\nkid: ${kid}`);
console.error("Public half is served automatically at /.well-known/jwks.json\n");
