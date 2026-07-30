// Passkeys, pinned without a browser: this suite IS the authenticator — it
// mints P-256 keys, builds real CBOR attestations, signs real assertions
// (DER-wrapped, as hardware does) — and drives the ceremony over the wire.
// What the browser would do is exactly what these helpers do.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import { migrate, pgAuth } from "./pg";
import { pgPasskey, cborDecode, derToRaw } from "./passkey";

// Test db namespaced by app (package.json name) — see pg.test.ts's note.
const APP = ((await Bun.file(new URL("../package.json", import.meta.url)).json()).name as string)
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^(?![a-z_])/, "app_");
const DB = `${APP}_test_passkey`;
const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? `postgres://epsilon:epsilon@localhost:5599/${DB}`;
const DB_DIR = new URL("../db", import.meta.url).pathname;

const ORIGIN = "http://localhost";
const RPID = "localhost";

let sql: SQL;
const servers: ReturnType<typeof Bun.serve>[] = [];
const remotes: Remote[] = [];
let url: string;

// --- the software authenticator ---------------------------------------------

const te = new TextEncoder();
const b64uEnc = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** Minimal CBOR encoder — the inverse of the runtime's reader, for fixtures. */
function cborEncode(v: unknown): Uint8Array {
  const head = (major: number, n: number): number[] =>
    n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255];
  if (typeof v === "number") return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") { const b = te.encode(v); return Uint8Array.from([...head(3, b.length), ...b]); }
  if (v instanceof Uint8Array) return Uint8Array.from([...head(2, v.length), ...v]);
  if (v instanceof Map) {
    const parts: number[] = [...head(5, v.size)];
    for (const [k, val] of v) parts.push(...cborEncode(k), ...cborEncode(val));
    return Uint8Array.from(parts);
  }
  throw new Error("cborEncode: unsupported");
}

/** r‖s → DER, the wrapping hardware authenticators use. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = [...b.slice(i)];
    if ((v[0]! & 0x80) !== 0) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

interface SoftKey { credId: Uint8Array; priv: CryptoKey; cose: Map<number, unknown> }

async function makeKey(): Promise<SoftKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const dec = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  return {
    credId: crypto.getRandomValues(new Uint8Array(16)),
    priv: pair.privateKey,
    cose: new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, dec(jwk.x!)], [-3, dec(jwk.y!)]]),
  };
}

async function authDataBytes(flags: number, count: number, attested?: SoftKey): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(RPID)));
  const base = [...rpIdHash, flags, (count >>> 24) & 255, (count >>> 16) & 255, (count >>> 8) & 255, count & 255];
  if (!attested) return Uint8Array.from(base);
  return Uint8Array.from([
    ...base,
    ...new Uint8Array(16),                                             // AAGUID
    attested.credId.length >> 8, attested.credId.length & 255,
    ...attested.credId,
    ...cborEncode(attested.cose),
  ]);
}

async function registerPasskey(r: Remote, key: SoftKey) {
  const o = await r.call<{ challenge: string }>("passkey_register_begin");
  const cd = te.encode(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: ORIGIN }));
  const att = cborEncode(new Map<string, unknown>([
    ["fmt", "none"], ["attStmt", new Map()], ["authData", await authDataBytes(0x45, 0, key)],
  ]));
  return r.call<{ ok: boolean; id: string }>("passkey_register_finish", {
    id: b64uEnc(key.credId),
    clientDataJSON: b64uEnc(cd),
    attestationObject: b64uEnc(att),
    transports: ["internal"],
  });
}

async function loginPasskey(
  r: Remote,
  key: SoftKey,
  count: number,
  tweak?: { challenge?: string; origin?: string; breakSig?: boolean; id?: string },
) {
  const o = await r.call<{ challenge: string }>("passkey_login_begin", {});
  const cd = te.encode(JSON.stringify({
    type: "webauthn.get",
    challenge: tweak?.challenge ?? o.challenge,
    origin: tweak?.origin ?? ORIGIN,
  }));
  const ad = await authDataBytes(0x05, count);
  const cdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", cd));
  const raw = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key.priv,
    Uint8Array.from([...ad, ...cdHash]),
  ));
  if (tweak?.breakSig) raw[0]! ^= 0xff;
  return r.call<{ token: string; user: { id: number; name: string; email: string } }>("passkey_login_finish", {
    id: tweak?.id ?? b64uEnc(key.credId),
    clientDataJSON: b64uEnc(cd),
    authenticatorData: b64uEnc(ad),
    signature: b64uEnc(rawToDer(raw)),
  });
}

// --- harness ----------------------------------------------------------------

function client() {
  const r = connect(url);
  remotes.push(r);
  return r;
}

beforeAll(async () => {
  if (!process.env.EPSILON_TEST_PG_URL) {
    const admin = new SQL(ADMIN_URL);
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${DB}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE ${DB}`);
    await admin.end();
  }
  sql = new SQL(PG_URL, { max: 3 });
  // Fresh schema, fresh ledger — frozen files only re-apply from nothing
  // (see pg.test.ts).
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(sql, { dir: DB_DIR });

  const host: Host = createHost({ requireAuth: true });
  await pgAuth(host, sql);
  pgPasskey(host, sql, { rpName: "epsilon-test", origins: [ORIGIN] });
  const server = Bun.serve({ port: 0, fetch: host.fetch, websocket: host.websocket });
  host.setServer(server);
  servers.push(server);
  url = `ws://localhost:${server.port}${host.path}`;
});

afterAll(async () => {
  for (const r of remotes) r.close();
  for (const s of servers) s.stop(true);
  await sql.end();
});

const key = await makeKey();

describe("passkeys — passwordless over the same wire", () => {
  let uid: number;

  test("register while signed in; the credential is schema-native", async () => {
    const r = client();
    const me = await r.call<{ user: { id: number } }>("register", {
      name: "Passkey Pete", email: "pete@passkey.test", password: "pw",
    });
    uid = me.user.id;
    const res = await registerPasskey(r, key);
    expect(res.ok).toBe(true);

    const [row] = await sql`SELECT user_id, public_key, sign_count FROM credentials WHERE id = ${res.id}`;
    expect(Number(row.user_id)).toBe(uid);
    expect(row.public_key.kty).toBe("EC");            // WebCrypto-ready JWK
    expect(Number(row.sign_count)).toBe(0);
  });

  test("a NEW socket signs in with the passkey alone — token, session, docs", async () => {
    const r = client();                                // never typed a password
    const { token, user } = await loginPasskey(r, key, 1);
    expect(user.email).toBe("pete@passkey.test");
    expect(token).toBeTruthy();
    const [{ sign_count }] = await sql`SELECT sign_count FROM credentials WHERE user_id = ${uid}`;
    expect(Number(sign_count)).toBe(1);                // the counter advanced

    // The session is the same schema-native kind login() mints.
    const other = client();
    const who = await other.call<{ email: string }>("authenticate", { token });
    expect(who.email).toBe("pete@passkey.test");
  });

  test("login_begin with an email narrows allowCredentials to that account — however it's cased", async () => {
    const r = client();
    const o = await r.call<{ allowCredentials: { id: string }[] }>(
      "passkey_login_begin", { email: "  Pete@Passkey.TEST " });   // normalized at the door
    expect(o.allowCredentials.map((c) => c.id)).toContain(b64uEnc(key.credId));
  });

  test("every tamper refuses: challenge, origin, signature, unknown id, replay, counter", async () => {
    const r = client();
    await expect(loginPasskey(r, key, 2, { challenge: "not-the-challenge" }))
      .rejects.toThrow(/challenge mismatch/);
    await expect(loginPasskey(r, key, 2, { origin: "https://evil.example" }))
      .rejects.toThrow(/origin mismatch/);
    await expect(loginPasskey(r, key, 2, { breakSig: true }))
      .rejects.toThrow(/not recognized/);
    await expect(loginPasskey(r, key, 2, { id: b64uEnc(crypto.getRandomValues(new Uint8Array(16))) }))
      .rejects.toThrow(/not recognized/);

    // Challenges are single-use: a finish without a fresh begin refuses.
    await expect(r.call("passkey_login_finish", { id: "x", clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" }))
      .rejects.toThrow(/no ceremony in flight/);

    // A cloned authenticator replaying an old counter is refused IN SQL.
    await loginPasskey(r, key, 5);
    await expect(loginPasskey(client(), key, 5)).rejects.toThrow(/counter went backwards/);
  });

  test("register_begin refuses an unauthenticated socket", async () => {
    const r = client();
    await expect(r.call("passkey_register_begin")).rejects.toThrow(/sign in first/);
  });

  test("the runtime's decoders round-trip the fixtures", async () => {
    const m = new Map<unknown, unknown>([["fmt", "none"], [1, 2], [-2, Uint8Array.from([9, 8, 7])]]);
    const back = cborDecode(cborEncode(m)) as Map<unknown, unknown>;
    expect(back.get("fmt")).toBe("none");
    expect(back.get(1)).toBe(2);
    expect([...(back.get(-2) as Uint8Array)]).toEqual([9, 8, 7]);

    const raw = crypto.getRandomValues(new Uint8Array(64));
    raw[0] = 0x91; raw[32] = 0x80;              // force sign-byte padding both halves
    expect([...derToRaw(rawToDer(raw))]).toEqual([...raw]);
  });
});
