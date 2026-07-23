// AT Protocol identity resolution, implemented for the Workers runtime.
//
// Why hand-rolled: the official @atproto handle resolvers resolve DNS directly,
// which edge runtimes cannot do (bluesky-social/atproto#3292, still open). The
// usual workaround is to ask Bluesky's XRPC resolver — but that would make every
// self-hosted hub depend on Bluesky to answer "who is this person", which is
// precisely the centralization docs/social-plan.md is trying to keep to a
// minimum. Both *canonical* resolution methods work fine on Workers with plain
// fetch, so we do those instead:
//
//   1. HTTPS well-known:  GET https://<handle>/.well-known/atproto-did
//   2. DNS TXT:           _atproto.<handle>, over DNS-over-HTTPS
//
// The spec allows either. We try the well-known first because it is one plain
// request with no third party in the path at all.

export type Did = string;

export interface ResolvedIdentity {
  did: Did;
  /** The handle we started from, when resolution began with a handle. */
  handle?: string;
  /** Base URL of the account's Personal Data Server. */
  pds: string;
  /** Handle(s) the DID document claims, as `at://` aka URIs, normalised. */
  alsoKnownAs: string[];
}

export class IdentityError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "IdentityError";
  }
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const PLC_DIRECTORY = "https://plc.directory";
const FETCH_TIMEOUT_MS = 5000;

/** Workers have no DNS and no `cache`/`redirect:"error"` fetch options. */
async function getJson(url: string, accept = "application/json"): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new IdentityError(`${url} -> HTTP ${res.status}`, 502);
  return res.json();
}

export function isDid(value: string): boolean {
  return /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9._%-]+)$/.test(value);
}

/**
 * Handles are domain names. Reject anything that isn't one before it reaches a
 * URL — this value is interpolated into a hostname.
 */
export function isHandle(value: string): boolean {
  if (value.length > 253 || value.length < 3) return false;
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(
    value,
  );
}

async function resolveHandleViaWellKnown(handle: string): Promise<Did | null> {
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, {
      // NB: not redirect:"error" — unsupported on Workers. "manual" means a
      // redirect surfaces as a non-ok response rather than being followed,
      // which is the behaviour we want anyway.
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return isDid(text) ? text : null;
  } catch {
    return null; // no such host, TLS failure, timeout — fall through to DNS
  }
}

async function resolveHandleViaDns(handle: string): Promise<Did | null> {
  try {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(`_atproto.${handle}`)}&type=TXT`;
    const data = (await getJson(url, "application/dns-json")) as {
      Answer?: { data?: string }[];
    };
    for (const answer of data.Answer ?? []) {
      // TXT records arrive quoted, and may be split into chunks.
      const txt = (answer.data ?? "").replace(/^"|"$/g, "").replace(/" "/g, "");
      if (txt.startsWith("did=")) {
        const did = txt.slice(4).trim();
        if (isDid(did)) return did;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveHandle(handle: string): Promise<Did> {
  if (!isHandle(handle)) {
    throw new IdentityError(`'${handle}' is not a valid handle`);
  }
  const did =
    (await resolveHandleViaWellKnown(handle)) ?? (await resolveHandleViaDns(handle));
  if (!did) {
    throw new IdentityError(
      `could not resolve handle '${handle}' (no /.well-known/atproto-did and no _atproto TXT record)`,
      404,
    );
  }
  return did;
}

interface DidDocument {
  id?: string;
  alsoKnownAs?: string[];
  service?: { id?: string; type?: string; serviceEndpoint?: string }[];
}

export async function fetchDidDocument(did: Did): Promise<DidDocument> {
  if (did.startsWith("did:plc:")) {
    return (await getJson(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`)) as DidDocument;
  }
  if (did.startsWith("did:web:")) {
    // did:web:example.com -> https://example.com/.well-known/did.json
    const host = decodeURIComponent(did.slice("did:web:".length));
    if (host.includes("/") || host.includes(":")) {
      throw new IdentityError(`unsupported did:web form '${did}'`);
    }
    return (await getJson(`https://${host}/.well-known/did.json`)) as DidDocument;
  }
  throw new IdentityError(`unsupported DID method: '${did}'`);
}

/** The PDS is the service entry with id `#atproto_pds`. */
export function pdsFromDidDocument(doc: DidDocument): string {
  for (const svc of doc.service ?? []) {
    const id = svc.id ?? "";
    if (id === "#atproto_pds" || id.endsWith("#atproto_pds")) {
      const endpoint = svc.serviceEndpoint;
      if (typeof endpoint === "string" && endpoint.startsWith("https://")) {
        return endpoint.replace(/\/$/, "");
      }
    }
  }
  throw new IdentityError("DID document has no #atproto_pds service endpoint", 502);
}

/**
 * Resolve a handle OR a DID all the way to the PDS that hosts the account.
 *
 * When given a handle, the DID document's alsoKnownAs is checked to confirm the
 * account claims that handle back. Handle -> DID is only an assertion by
 * whoever controls the domain; the DID document is the authority, and without
 * this check a domain could name someone else's DID and impersonate them.
 */
export async function resolveIdentity(handleOrDid: string): Promise<ResolvedIdentity> {
  const input = handleOrDid.trim().toLowerCase().replace(/^@/, "").replace(/^at:\/\//, "");

  let did: Did;
  let handle: string | undefined;
  if (isDid(input)) {
    did = input;
  } else if (input.startsWith("did:")) {
    // Reported as a bad DID rather than falling through to handle validation,
    // which would blame the wrong thing entirely.
    throw new IdentityError(
      `'${input}' is not a supported DID (expected did:plc:<24 chars> or did:web:<domain>)`,
    );
  } else {
    handle = input;
    did = await resolveHandle(handle);
  }

  const doc = await fetchDidDocument(did);
  if (doc.id && doc.id !== did) {
    throw new IdentityError(`DID document id '${doc.id}' does not match '${did}'`, 502);
  }

  const alsoKnownAs = (doc.alsoKnownAs ?? []).map((a) =>
    a.replace(/^at:\/\//, "").toLowerCase(),
  );
  if (handle && !alsoKnownAs.includes(handle)) {
    throw new IdentityError(
      `handle '${handle}' resolved to ${did}, but that DID document does not claim it back`,
      409,
    );
  }

  return { did, handle, pds: pdsFromDidDocument(doc), alsoKnownAs };
}
