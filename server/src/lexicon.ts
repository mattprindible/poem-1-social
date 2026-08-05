import type { OAuthSession } from "@atproto/oauth-client"

import { APP_COLLECTION, MAX_CODE_BYTES } from "./app-record"
import { HUB_COLLECTION } from "./hub-record"
import { PdsError, publicXrpc, xrpc } from "./pds"
import { resolveIdentity } from "./identity"

// Publishing the schemas for the types this project defines.
//
// A record type is only fabric if other people's software can find out what it
// means. atproto resolves that through DNS: an NSID's authority is its domain
// reversed, a TXT record at `_lexicon.<authority>` names the DID holding the
// schemas, and the schema itself is a `com.atproto.lexicon.schema` record keyed
// by the NSID. So:
//
//   computer.haha.san.app
//     -> authority  san.haha.computer
//     -> TXT        _lexicon.san.haha.computer  = "did=did:plc:…"
//     -> record     at://did:plc:…/com.atproto.lexicon.schema/computer.haha.san.app
//
// ONE TXT record covers every type under the authority, because resolution is
// deliberately non-hierarchical — resolvers do not walk up or down the DNS tree.
//
// Note the DID in that TXT record is only a pointer. The DOMAIN is the
// authority, so the schemas can move to a different repo later without any NSID
// changing — which is what makes this a weaker commitment than it first looks.

export const LEXICON_COLLECTION = "com.atproto.lexicon.schema"

/**
 * An NSID's authority domain is its segments reversed, minus the name.
 * `computer.haha.san.app` -> `san.haha.computer`.
 */
export function authorityFor(nsid: string): string {
  return nsid.split(".").slice(0, -1).reverse().join(".")
}

/**
 * The schemas, written out rather than generated from the TypeScript types.
 *
 * Deliberate duplication. These are a PUBLIC CONTRACT — once other people's
 * software validates against them, changing one is a breaking change to
 * everybody. Deriving them from our interfaces would let an incidental
 * refactor silently rewrite that contract, which is exactly backwards. Making
 * them a separate artifact means changing the contract is a visible edit.
 */
export const SCHEMAS: Record<string, Record<string, unknown>> = {
  [HUB_COLLECTION]: {
    lexicon: 1,
    id: HUB_COLLECTION,
    defs: {
      main: {
        type: "record",
        key: "literal:self",
        description:
          "Declares the author's hub: where it is, and which key speaks for it. " +
          "One record does discovery, authentication and revocation — update or " +
          "delete it and the old key is dead.",
        record: {
          type: "object",
          required: ["endpoint", "publicKey", "createdAt", "updatedAt"],
          properties: {
            endpoint: {
              type: "string",
              format: "uri",
              description: "Base URL of the hub. Where other hubs send federated requests.",
            },
            publicKey: {
              type: "object",
              description: "Public half of the hub's federation signing key, as a JWK.",
              required: ["kty", "crv", "x", "y", "kid", "alg", "use"],
              properties: {
                kty: { type: "string" },
                crv: { type: "string" },
                x: { type: "string" },
                y: { type: "string" },
                kid: { type: "string" },
                alg: { type: "string" },
                use: { type: "string" },
              },
            },
            createdAt: { type: "string", format: "datetime" },
            updatedAt: { type: "string", format: "datetime" },
          },
        },
      },
    },
  },

  [APP_COLLECTION]: {
    lexicon: 1,
    id: APP_COLLECTION,
    defs: {
      main: {
        type: "record",
        key: "any",
        description:
          "A sandbox app: Lua source plus metadata, published by its author. " +
          "The record key is a slug derived from the name, so re-publishing a " +
          "name is an edit rather than a new app.",
        record: {
          type: "object",
          required: ["name", "code", "createdAt", "updatedAt"],
          properties: {
            name: {
              type: "string",
              maxLength: 640,
              description: "Human-readable name. The record key is derived from it.",
            },
            code: {
              type: "string",
              maxLength: MAX_CODE_BYTES,
              description: "The Lua source, inline.",
            },
            description: {
              type: "string",
              maxLength: 2000,
              description: "One line on what the app does.",
            },
            createdAt: { type: "string", format: "datetime" },
            updatedAt: { type: "string", format: "datetime" },
          },
        },
      },
    },
  },
}

export interface LexiconStatus {
  nsid: string
  authority: string
  /** DID the DNS TXT record names, or null when there is no such record. */
  dnsDid: string | null
  /** Whether a schema record actually exists in that DID's repo. */
  recordPublished: boolean
  /** True only when DNS and record agree and both exist. */
  resolves: boolean
  note: string
}

/**
 * Look up `_lexicon.<authority>` over DNS-over-HTTPS.
 *
 * Workers have no DNS resolver, so this goes through Cloudflare's DoH JSON
 * endpoint. Returns null rather than throwing for the ordinary "not published
 * yet" case, which is what a hub sees before the operator adds the record.
 */
export async function lexiconDidFromDns(authority: string): Promise<string | null> {
  const url = new URL("https://cloudflare-dns.com/dns-query")
  url.searchParams.set("name", `_lexicon.${authority}`)
  url.searchParams.set("type", "TXT")

  const res = await fetch(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return null

  const out = (await res.json()) as { Answer?: { data?: string }[] }
  for (const answer of out.Answer ?? []) {
    // DoH returns TXT data quoted; long records arrive as concatenated chunks.
    const value = (answer.data ?? "").replace(/"/g, "").trim()
    const match = /^did=(.+)$/.exec(value)
    if (match) return match[1]!.trim()
  }
  return null
}

/**
 * Answer the only question that matters about a lexicon: does it resolve for
 * somebody who is not us?
 *
 * Checks the whole chain independently — DNS, then the DID's repo — rather than
 * trusting that publishing succeeded. Publishing a schema record into a repo no
 * TXT record points at produces something that looks published and resolves for
 * nobody, and that failure is invisible from the inside.
 */
export async function checkLexicon(nsid: string): Promise<LexiconStatus> {
  const authority = authorityFor(nsid)
  const dnsDid = await lexiconDidFromDns(authority)

  if (!dnsDid) {
    return {
      nsid,
      authority,
      dnsDid: null,
      recordPublished: false,
      resolves: false,
      note: `no TXT record at _lexicon.${authority} — add one with value "did=<did>"`,
    }
  }

  let recordPublished = false
  try {
    const identity = await resolveIdentity(dnsDid)
    const out = (await publicXrpc(identity.pds, "com.atproto.repo.getRecord", {
      repo: dnsDid,
      collection: LEXICON_COLLECTION,
      rkey: nsid,
    })) as { value?: unknown }
    recordPublished = out.value !== undefined
  } catch (err) {
    if (!(err instanceof PdsError && err.status === 400)) throw err
  }

  return {
    nsid,
    authority,
    dnsDid,
    recordPublished,
    resolves: recordPublished,
    note: recordPublished
      ? "resolves: DNS names a DID, and that repo holds the schema"
      : `DNS names ${dnsDid}, but that repo holds no ${LEXICON_COLLECTION} record for ${nsid}`,
  }
}

/**
 * Publish the schemas into the signed-in account's repo.
 *
 * Only meaningful for whoever the authority's TXT record names. Anyone else
 * running this writes records that resolve for nobody — harmless, but pointless,
 * so the caller is told which case it is rather than being congratulated either
 * way.
 */
export async function publishLexicons(
  session: OAuthSession,
): Promise<{ nsid: string; uri: string; cid: string }[]> {
  const out: { nsid: string; uri: string; cid: string }[] = []

  for (const [nsid, schema] of Object.entries(SCHEMAS)) {
    const record = { $type: LEXICON_COLLECTION, ...schema }
    const res = (await xrpc(session, "com.atproto.repo.putRecord", {
      method: "POST",
      body: {
        repo: session.did,
        collection: LEXICON_COLLECTION,
        // The record key IS the NSID. That is what makes resolution a single
        // getRecord rather than a scan of the collection.
        rkey: nsid,
        record,
      },
    })) as { uri: string; cid: string }
    out.push({ nsid, uri: res.uri, cid: res.cid })
  }

  return out
}
