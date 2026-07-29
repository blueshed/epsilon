/**
 * Passkeys — passwordless sign-in over the same wire (WebAuthn, level:
 * what every browser ships). The boundary rule, applied to auth: SQL owns
 * identity and state (db/002 — credentials beside users and sessions,
 * counter policy in credential_use), THIS file owns the ceremony —
 * pgcrypto has no ECDSA, so verification is WebCrypto's job the way
 * transport is TS's job. Zero dependencies: the attestation object is
 * CBOR, and the four fixed shapes it uses are ~60 lines to read.
 *
 *   const { pgPasskey } = await import("./epsilon/passkey");
 *   pgPasskey(host, sql, { rpName: "epsilon-app" });
 *
 * Four methods, begin/finish pairs (the challenge lives ON THE SOCKET —
 * ephemeral, single-use, dies with the connection; no table):
 *   passkey_register_begin/finish — add a passkey to the SIGNED-IN user
 *   passkey_login_begin/finish    — sign in with one; the finish returns
 *                                   {token, user} exactly like login()
 *
 * Origins: by default a ceremony must come from the same origin as the
 * WebSocket itself (the Origin header the socket connected with) — zero
 * config, and the browser's own scoping does the phishing resistance.
 * Pin `opts.origins` in production to be explicit. The RP ID is the
 * accepted origin's hostname; browsers default to the same, so `rp.id`
 * never needs to be sent.
 *
 * The CLI keeps its door: passwords still work, and a browser-minted
 * session token pastes into EPSILON_TOKEN.
 */

import type { Host } from "./doc";
import type { Sql } from "./pg";
import type { User } from "./pg";

// --- bytes ------------------------------------------------------------------

const b64u = {
  enc: (b: Uint8Array): string => Buffer.from(b).toString("base64url"),
  dec: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url")),
};

const utf8 = new TextDecoder();

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

// --- CBOR (decode only, the four shapes WebAuthn uses) ----------------------

/** Minimal CBOR: uints, negatives, byte/text strings, arrays, maps —
 *  attestation objects and COSE keys need nothing else. @internal */
export function cborDecode(bytes: Uint8Array): unknown {
  const [v, end] = cborItem(bytes, 0);
  if (end > bytes.length) throw new Error("cbor: truncated");
  return v;
}

/** Decode one item at offset i; returns [value, next offset]. @internal
 *  (parseAuthData needs "next offset" — the COSE key's length isn't
 *  written anywhere, it's wherever the CBOR item ends.) */
export function cborItem(b: Uint8Array, i: number): [unknown, number] {
  const head = b[i];
  if (head === undefined) throw new Error("cbor: truncated");
  const major = head >> 5;
  const info = head & 31;
  i++;
  let n = 0;
  if (info < 24) n = info;
  else if (info === 24) { n = b[i]!; i += 1; }
  else if (info === 25) { n = b[i]! * 256 + b[i + 1]!; i += 2; }
  else if (info === 26) { n = b[i]! * 2 ** 24 + b[i + 1]! * 2 ** 16 + b[i + 2]! * 256 + b[i + 3]!; i += 4; }
  else throw new Error("cbor: unsupported length");
  switch (major) {
    case 0: return [n, i];
    case 1: return [-1 - n, i];
    case 2: return [b.slice(i, i + n), i + n];
    case 3: return [utf8.decode(b.slice(i, i + n)), i + n];
    case 4: {
      const arr: unknown[] = [];
      for (let k = 0; k < n; k++) { const [v, ni] = cborItem(b, i); arr.push(v); i = ni; }
      return [arr, i];
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      for (let k = 0; k < n; k++) {
        const [key, ki] = cborItem(b, i);
        const [val, vi] = cborItem(b, ki);
        map.set(key, val); i = vi;
      }
      return [map, i];
    }
    default: throw new Error(`cbor: unsupported type ${major}`);
  }
}

// --- COSE key → JWK ---------------------------------------------------------

export interface Jwk { kty: string; crv?: string; x?: string; y?: string; n?: string; e?: string }

/** EC2/P-256 (ES256, -7) and RSA (RS256, -257) — what authenticators mint. @internal */
export function coseToJwk(cose: Map<unknown, unknown>): Jwk {
  const kty = cose.get(1);
  if (kty === 2) {
    if (cose.get(-1) !== 1) throw new Error("passkey: unsupported curve");
    return {
      kty: "EC", crv: "P-256",
      x: b64u.enc(cose.get(-2) as Uint8Array),
      y: b64u.enc(cose.get(-3) as Uint8Array),
    };
  }
  if (kty === 3) {
    return {
      kty: "RSA",
      n: b64u.enc(cose.get(-1) as Uint8Array),
      e: b64u.enc(cose.get(-2) as Uint8Array),
    };
  }
  throw new Error("passkey: unsupported key type");
}

// --- signatures -------------------------------------------------------------

/** WebAuthn ECDSA signatures arrive DER-wrapped; WebCrypto wants raw r‖s. @internal */
export function derToRaw(der: Uint8Array): Uint8Array {
  let i = 2;
  if ((der[1]! & 0x80) !== 0) i = 2 + (der[1]! & 0x7f);   // long-form length
  const out = new Uint8Array(64);
  for (const off of [0, 32]) {
    if (der[i] !== 0x02) throw new Error("passkey: bad signature");
    let len = der[i + 1]!;
    let start = i + 2;
    if (len === 33 && der[start] === 0) { start++; len--; }  // strip the sign byte
    if (len > 32) throw new Error("passkey: bad signature");
    out.set(der.slice(start, start + len), off + (32 - len));
    i = start + len;
  }
  return out;
}

async function verifySignature(jwk: Jwk, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  if (jwk.kty === "EC") {
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key,
      derToRaw(sig) as BufferSource, data as BufferSource);
  }
  const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig as BufferSource, data as BufferSource);
}

// --- authenticator data -----------------------------------------------------

const FLAG_UP = 0x01;
const FLAG_AT = 0x40;

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credId?: Uint8Array;
  coseKey?: Map<unknown, unknown>;
}

/** rpIdHash(32) ‖ flags(1) ‖ signCount(4) ‖ [attested credential]. @internal */
export function parseAuthData(b: Uint8Array): AuthData {
  if (b.length < 37) throw new Error("passkey: bad authenticator data");
  const flags = b[32]!;
  const out: AuthData = {
    rpIdHash: b.slice(0, 32),
    flags,
    signCount: b[33]! * 2 ** 24 + b[34]! * 2 ** 16 + b[35]! * 256 + b[36]!,
  };
  if ((flags & FLAG_AT) !== 0) {
    const credLen = b[53]! * 256 + b[54]!;
    out.credId = b.slice(55, 55 + credLen);
    const [cose] = cborItem(b, 55 + credLen);
    out.coseKey = cose as Map<unknown, unknown>;
  }
  return out;
}

// --- the ceremony -----------------------------------------------------------

interface ClientData { type: string; challenge: string; origin: string }

function readClientData(b64: string): { raw: Uint8Array; data: ClientData } {
  const raw = b64u.dec(b64);
  return { raw, data: JSON.parse(utf8.decode(raw)) as ClientData };
}

function asUser(u: { id: number | string; name: string; email: string }): User {
  return { id: Number(u.id), name: u.name, email: u.email };
}

export function pgPasskey(
  host: Host,
  sql: Sql,
  opts?: {
    /** Shown by the browser's passkey sheet. */
    rpName?: string;
    /** Pin the web origins allowed to run ceremonies (recommended in
     *  production). Default: the origin the SOCKET connected from. */
    origins?: string[];
  },
): void {
  const rpName = opts?.rpName ?? "epsilon-app";

  function checkOrigin(origin: string | undefined, ws: any): string {
    if (!origin) throw new Error("origin required");
    if (opts?.origins ? !opts.origins.includes(origin) : origin !== ws.data?.origin) {
      throw new Error("origin mismatch");
    }
    return new URL(origin).hostname;   // the RP ID — browsers default to the same
  }

  /** One outstanding challenge per socket, single use. */
  function mint(ws: any, type: "create" | "get"): string {
    const challenge = b64u.enc(crypto.getRandomValues(new Uint8Array(32)));
    ws.data ??= {};
    ws.data.passkey = { challenge, type };
    return challenge;
  }
  function spend(ws: any, type: "create" | "get"): string {
    const c = ws.data?.passkey as { challenge: string; type: string } | undefined;
    if (ws.data) delete ws.data.passkey;
    if (!c || c.type !== type) throw new Error("no ceremony in flight — call the begin method first");
    return c.challenge;
  }

  host.method("passkey_register_begin", (_params, ws) => {
    const user = ws.data?.user as User | undefined;
    if (!user) throw new Error("sign in first — a passkey is added to your account");
    return {
      challenge: mint(ws, "create"),
      rp: { name: rpName },
      user: {
        id: b64u.enc(new TextEncoder().encode(String(user.id))),
        name: user.email,
        displayName: user.name,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },     // ES256
        { type: "public-key", alg: -257 },   // RS256 (Windows Hello)
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      attestation: "none",
    };
  });

  host.method("passkey_register_finish", async (params: {
    id?: string; clientDataJSON?: string; attestationObject?: string; transports?: string[];
  }, ws) => {
    const user = ws.data?.user as User | undefined;
    if (!user) throw new Error("sign in first");
    const challenge = spend(ws, "create");
    if (!params?.id || !params.clientDataJSON || !params.attestationObject) {
      throw new Error("id, clientDataJSON, and attestationObject required");
    }
    const { data: client } = readClientData(params.clientDataJSON);
    if (client.type !== "webauthn.create") throw new Error("wrong ceremony type");
    if (client.challenge !== challenge) throw new Error("challenge mismatch");
    const rpId = checkOrigin(client.origin, ws);

    const att = cborDecode(b64u.dec(params.attestationObject)) as Map<unknown, unknown>;
    const auth = parseAuthData(att.get("authData") as Uint8Array);
    if ((auth.flags & FLAG_UP) === 0) throw new Error("user presence required");
    if (!auth.credId || !auth.coseKey) throw new Error("no attested credential");
    if (b64u.enc(await sha256(new TextEncoder().encode(rpId))) !== b64u.enc(auth.rpIdHash)) {
      throw new Error("rp mismatch");
    }
    const id = b64u.enc(auth.credId);
    if (id !== params.id) throw new Error("credential id mismatch");

    const jwk = coseToJwk(auth.coseKey);
    try {
      await sql`SELECT credential_register(${user.id}, ${id}, ${jwk as any}, ${(params.transports ?? null) as any})`;
    } catch (err) {
      if (String(err).includes("duplicate key")) throw new Error("passkey already registered");
      throw err;
    }
    return { ok: true, id };
  });

  host.method("passkey_login_begin", async (params: { email?: string }, ws) => {
    // With an email: that user's credential ids (the non-discoverable
    // path). Without: empty allowCredentials — the browser offers the
    // resident passkeys it holds for this site.
    let allowCredentials: unknown[] = [];
    if (params?.email) {
      const [row] = await sql`SELECT credential_list(${params.email}) AS c`;
      allowCredentials = ((row?.c ?? []) as { id: string }[])
        .map((c) => ({ type: "public-key", id: c.id }));
    }
    return { challenge: mint(ws, "get"), allowCredentials, userVerification: "preferred" };
  });

  host.method("passkey_login_finish", async (params: {
    id?: string; clientDataJSON?: string; authenticatorData?: string; signature?: string; userHandle?: string;
  }, ws) => {
    const challenge = spend(ws, "get");
    if (!params?.id || !params.clientDataJSON || !params.authenticatorData || !params.signature) {
      throw new Error("id, clientDataJSON, authenticatorData, and signature required");
    }
    const { raw: clientRaw, data: client } = readClientData(params.clientDataJSON);
    if (client.type !== "webauthn.get") throw new Error("wrong ceremony type");
    if (client.challenge !== challenge) throw new Error("challenge mismatch");
    const rpId = checkOrigin(client.origin, ws);

    const [row] = await sql`SELECT credential_get(${params.id}) AS c`;
    const cred = row?.c as { user_id: number; public_key: Jwk; sign_count: number } | null;
    // One refusal for unknown ids and failed ceremonies alike.
    if (!cred) throw new Error("passkey not recognized");

    const authBytes = b64u.dec(params.authenticatorData);
    const auth = parseAuthData(authBytes);
    if ((auth.flags & FLAG_UP) === 0) throw new Error("user presence required");
    if (b64u.enc(await sha256(new TextEncoder().encode(rpId))) !== b64u.enc(auth.rpIdHash)) {
      throw new Error("rp mismatch");
    }
    if (params.userHandle && utf8.decode(b64u.dec(params.userHandle)) !== String(cred.user_id)) {
      throw new Error("passkey not recognized");
    }
    const signed = concat(authBytes, await sha256(clientRaw));
    if (!(await verifySignature(cred.public_key, b64u.dec(params.signature), signed))) {
      throw new Error("passkey not recognized");
    }

    // Counter policy lives in SQL: NULL = regression (a clone replaying).
    const [used] = await sql`SELECT credential_use(${params.id}, ${auth.signCount}) AS u`;
    if (!used?.u) throw new Error("passkey not recognized — counter went backwards");
    const user = asUser(used.u);
    const [session] = await sql`SELECT session_start(${user.id}) AS token`;
    ws.data ??= {};
    ws.data.user = user;
    return { token: session.token as string, user };
  });
}
