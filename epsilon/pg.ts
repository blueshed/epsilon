/**
 * Postgres — durability and fan-out for docs as lenses over TABLES, plus
 * schema-native users.
 *
 * The tables are the truth. A write is one stored function in one
 * transaction: it mints ids from sequences, touches every table the change
 * implies, logs doc_ops (with the undo), bumps v and NOTIFYs. Composition is
 * open-time (`doc_open`), never per write — which is why multi-table writes
 * and composition live in SQL, where they are optimal.
 * Listeners fetch missed ops from doc_ops and inject them via
 * host.receive(); a gap falls back to reload + hydrate.
 *
 * Uses Bun's built-in SQL client — zero dependencies, one language.
 *
 *   const sql = new SQL(process.env.EPSILON_PG_URL!);
 *   await migrate(sql);           // db/*.sql, in order, hash-recorded
 *   const board = await pgDoc<Board>(host, sql, "board:1", null, { apply: "board_apply" });
 *   await pgAuth(host, sql);      // register/login/authenticate/logout
 *   await pgSync(host, sql);      // cross-process fan-out (LISTEN/NOTIFY)
 */

import type { Host } from "./doc";
import type { Op } from "./op";
import type { Signal } from "./signal";

/**
 * The slice of a Postgres client epsilon actually uses. Bun's `SQL`
 * satisfies it structurally (wire Postgres); `pglite.ts` implements it over
 * an IN-PROCESS database. Everything in this file — and migrate.ts, and the
 * stored functions themselves — runs unchanged on either engine.
 */
export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<any>;
  unsafe(query: string, params?: any): PromiseLike<any>;
  /** One session for the whole call — advisory locks are session-scoped. */
  reserve?(): PromiseLike<any>;
  end?(): PromiseLike<void> | void;
}

const CHANNEL = "epsilon_ops";

export { migrate, migrationFiles } from "./migrate";

/**
 * Host a doc backed by Postgres. The TABLES are the truth.
 *
 * (There was a second, doc-native tier until 0.10.0: the doc as a JSONB blob,
 * TS applying ops, one guarded UPDATE persisting. DESIGN.md called it v0 and
 * relational "next"; relational arrived, no app ever hosted a blob, and the
 * dead branch was the sole reason `DocOpts.persist` and the host's `muted`
 * flag existed — the trickiest invariant in doc.ts, maintained for nobody.)
 *
 * `opts.apply` is a stored function name. Client ops go to
 * `<apply>(name, ops, user)` in ONE transaction — it
 * mints ids from sequences, updates tables, logs doc_ops (with the undo),
 * bumps v, NOTIFYs — and returns `{v, ops}` with resolved paths/rows, which
 * re-enter through pgReceive. A dispatch that doc_drops other docs lists
 * them as `gone` and the hook un-hosts each (watchers receive the snapshot
 * of nothing); siblings hear the same through doc_drop's doorbell. A write never recomposes the doc: composition
 * is open-time (`doc_open`), and the host composes AS ITSELF — doc_open with
 * no user is the full copy (001's rule). Multi-table writes and composition
 * live in SQL, where they're optimal.
 */
export async function pgDoc<T>(
  host: Host,
  sql: Sql,
  name: string,
  empty: T,
  opts: {
    /** The stored function that owns this doc's writes. */
    apply: string;
    /** Create the docs row on first host (dynamic docs — mine:<uid>). */
    seed?: { open_fn: string };
    /** Who may receive the hosted snapshot over the wire. DEFAULT (relational
     *  docs): `doc_open(name, user) IS NOT NULL` — the composition function
     *  IS the permit (001's rule), asked fresh at every open, so ownership
     *  and membership changes bite at the next open with no app code.
     *  Override only to skip that SQL round trip — and never capture mutable
     *  row state at hosting time: a doc can be claimed while hosted.
     *  Refusals read as "unknown doc" — no existence oracle. */
    guard?: (userId?: number | string) => boolean | Promise<boolean>;
  },
): Promise<Signal<T>> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.apply)) {
    throw new Error(`[epsilon/pg] apply must be a plain function name: ${opts.apply}`);
  }
  const applyFn = opts.apply;
  const guard = opts.guard;
  let sig!: Signal<T>;
  sig = host.doc<T>(name, empty, {
    async write(ops, userId) {
      // ops bind RAW — Bun encodes arrays/objects as jsonb; a pre-stringified
      // value + ::jsonb double-encodes into a string scalar.
      const rows = await sql.unsafe(
          `SELECT ${applyFn}($1, $2, $3) AS r`,
        [name, ops as unknown, userId ?? null],
      );
      const r = rows[0]!.r as { v: number | string; ops: Op[]; gone?: string[] };
      await pgReceive(host, sql, name, r);
      // Docs this write dropped (`gone` — a board deleted from a mine
      // list) un-host HERE, watchers included: doc_drop's doorbell only
      // reaches processes with a listener, and the writer may have none
      // (PGlite; poll mode).
      for (const g of r.gone ?? []) host.drop(g);
      // The dispatch already resolved `-` against a sequence; hand those
      // ops back so an awaited write() can report the id it minted.
      return r.ops;
    },
    async open(userId) {
      if (guard) return (await guard(userId)) ? sig.peek() : null;
      const [r] = await sql`SELECT doc_open(${name}, ${userId == null ? null : Number(userId)}) IS NOT NULL AS ok`;
      return r?.ok ? sig.peek() : null;
    },
  });
  if (opts.seed) {
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${name}, 0, NULL, ${opts.seed.open_fn})
              ON CONFLICT (name) DO NOTHING`;
  }
  // Composition happens HERE, at open — never per write. The host composes
  // AS ITSELF: doc_open(name, NULL) is the full copy (001's rule), written
  // out — the NULL is the ceremony (007) — and the open gate above decides
  // who may receive it.
  const [row] = await sql`SELECT v, doc_open(name, NULL) AS data FROM docs WHERE name = ${name}`;
  if (!row) {
    // host.doc() registered the entry above, so throwing here would leave the
    // name HOSTED and serving `empty` at v=0 to everyone who opens it — a
    // failure that looks like an empty document rather than an error. Un-host
    // it so the next open meets the factory again (and fails honestly).
    host.drop(name);
    throw new Error(`[epsilon/pg] doc ${name} not seeded — your SQL file should INSERT its docs row`);
  }
  host.hydrate(name, Number(row.v), row.data);
  return sig;
}


/**
 * Re-enter a stored write's `{v, ops}` into the hosted doc — the same dance
 * pgDoc's write hook does. Use it after calling a stored function OUTSIDE
 * that hook (doc_undo, scheduled jobs): apply in order; on a gap, reload the
 * host's own composition. No-op when this process doesn't host the doc —
 * the NOTIFY the commit already rang reaches whoever does.
 */
export async function pgReceive(
  host: Host,
  sql: Sql,
  name: string,
  r: { v: number | string; ops: Op[] },
): Promise<void> {
  try { host.v(name); } catch { return; }   // not hosted here
  if (host.receive(name, Number(r.v), r.ops) === "gap") {
    const [doc] = await sql`SELECT v, doc_open(name, NULL) AS data FROM docs WHERE name = ${name}`;
    if (doc) host.hydrate(name, Number(doc.v), doc.data);
  }
}

/**
 * Undo as a host method: `remote.call("undo", { doc, v? })` reverts version
 * v — or the CALLER's latest undoable write when v is omitted — by applying
 * the inverse doc_commit recorded (003), dispatched through the type's own
 * apply function: the permit is re-checked there, and the undo of an undo
 * is the redo. Refuses (the caller's promise rejects) when nothing was
 * recorded or later ops touched the same paths. `applyOf` names the
 * dispatch function per doc; return undefined for docs that don't undo.
 */
export function pgUndo(host: Host, sql: Sql, applyOf: (doc: string) => string | undefined): void {
  host.method("undo", async (params: { doc?: string; v?: number }, ws) => {
    const name = String(params?.doc ?? "");
    const applyFn = name ? applyOf(name) : undefined;
    if (!applyFn) throw new Error(`no undo: ${name || "(no doc)"}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(applyFn)) {
      throw new Error(`[epsilon/pg] apply must be a plain function name: ${applyFn}`);
    }
    const rows = await sql.unsafe(
      `SELECT doc_undo($1, $2, $3, $4) AS r`,
      [name, params?.v ?? null, ws.data?.user?.id ?? null, applyFn],
    );
    const r = rows[0]!.r as { v: number | string; ops: Op[]; gone?: string[] };
    await pgReceive(host, sql, name, r);
    for (const g of r.gone ?? []) host.drop(g);
    return r;
  });
}

/**
 * History as a host method: `remote.call("history", { doc, before?, after?,
 * limit? })` reads the doc's own op log back (the kit, db/003) — newest first, names
 * joined at read time, paged by version cursor. `before` pages backwards,
 * `after` fetches only what is newer than a version you already have.
 *
 * It is a READ of the audit every write already makes, gated by the doc's
 * own permit (doc_open) in SQL — so it can't become a side door into a doc
 * the caller may not open, and adding it costs a doc type nothing. Depth is
 * whatever epsilon_prune keeps (004); a row's own updated_by/updated_at, if
 * the type stamps them, outlives the log.
 */
export function pgHistory(host: Host, sql: Sql, opts?: { limit?: number }): void {
  host.method("history", async (
    params: { doc?: string; before?: number; after?: number; limit?: number },
    ws,
  ) => {
    const name = String(params?.doc ?? "");
    if (!name) throw new Error("doc required");
    const [row] = await sql`SELECT doc_history(
      ${name},
      ${ws.data?.user?.id == null ? null : Number(ws.data.user.id)},
      ${params?.before ?? null},
      ${params?.after ?? null},
      ${params?.limit ?? opts?.limit ?? 100}) AS h`;
    return row.h as unknown[];
  });
}

/**
 * The operator's door: `remote.call("admin", { sql })` runs one statement and
 * returns its rows — the CLI's `call admin '{"sql":"…"}'`.
 *
 * It exists because the EMBEDDED tier has no port. PGlite lives inside the
 * app process, so there is no psql, no console, no way to inspect or repair a
 * running deployment except the wire the app already speaks. (Born the night
 * a typo'd registration could be neither found nor fixed.)
 *
 * Gated by an explicit list of registered emails — `EPSILON_ADMIN`, or
 * `admins`. NO LIST, NO DOOR: with none configured the method is never
 * registered, so a deployment that didn't opt in doesn't have one to attack.
 * When it IS configured, refusals SPEAK rather than hiding behind a uniform
 * "unknown method": the door is only reachable by an authenticated socket,
 * and an operator who cannot tell "no session" from "not on the list" from
 * "not deployed" spends the evening guessing which. Returns whether a door
 * was opened, so a boot log can say so.
 *
 * Writes made here BYPASS the op log: right for users and sessions, and
 * reload-worthy for doc tables — hosted docs will not hear about them.
 */
/** Constant-time string compare — a secret checked with === leaks its prefix
 *  to anyone willing to time the answer. @internal */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  // Compare a fixed-size digest so differing LENGTHS don't short-circuit.
  const ah = Bun.SHA256.hash(ab) as Uint8Array;
  const bh = Bun.SHA256.hash(bb) as Uint8Array;
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ah.length; i++) diff |= ah[i]! ^ bh[i]!;
  return diff === 0;
}

export function pgAdmin(
  host: Host,
  sql: Sql,
  opts?: { admins?: string[]; maxRows?: number; secret?: string },
): boolean {
  const admins = (opts?.admins ?? process.env.EPSILON_ADMIN?.split(",") ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (admins.length === 0) return false;
  const maxRows = opts?.maxRows ?? 500;

  // An email is not a secret: registration is open and unverified, so on a
  // fresh deployment whoever registers the operator's address FIRST inherits
  // arbitrary SQL — and an operator's address is usually public. The list
  // says WHO may knock; this secret proves it is really them. It is required
  // whenever the door is configured, because an optional one is off by
  // default exactly where it matters.
  const secret = opts?.secret ?? process.env.EPSILON_ADMIN_SECRET ?? "";
  if (!secret) {
    console.error(
      "[epsilon] EPSILON_ADMIN is set but EPSILON_ADMIN_SECRET is not — the admin door stays CLOSED.\n" +
      "  The door runs arbitrary SQL and its allowlist is an email anyone can register,\n" +
      "  so it needs a second factor. Generate one:  openssl rand -hex 32",
    );
    return false;
  }

  host.method("admin", async (params: { sql?: string; secret?: string }, ws) => {
    const user = ws.data?.user as { id?: number | string; email?: string } | undefined;
    if (user?.id == null) throw new Error("admin: no session on this socket — log in first");
    if (!user.email || !admins.includes(user.email.toLowerCase())) {
      throw new Error(`admin: not permitted for ${user.email ?? user.id}`);
    }
    if (!timingSafeEqual(String(params?.secret ?? ""), secret)) {
      throw new Error("admin: bad or missing secret (EPSILON_ADMIN_SECRET)");
    }
    if (!params?.sql) throw new Error("admin: sql required");
    // The door bypasses the op log, so it also bypasses the audit trail every
    // ordinary write leaves. Log it: an operator's own statements are the one
    // thing worth finding in the journal after something goes wrong.
    console.log(`[epsilon/admin] ${user.email} ran: ${params.sql.slice(0, 500)}`);
    const rows = (await sql.unsafe(params.sql)) as unknown[];
    // Bound the FRAME, not the query — the tail is still in the database, and
    // a truncated answer that says so beats a socket killed by a stray SELECT *.
    return Array.isArray(rows) && rows.length > maxRows
      ? { rows: rows.slice(0, maxRows), truncated: true, total: rows.length }
      : { rows: rows ?? [] };
  });
  return true;
}

// ---------------------------------------------------------------------------
// Views — nouns are docs. A view is a READ-ONLY doc whose value is one
// composition query over other docs' tables, recomposed when any of its
// DECLARED dependencies commits. It satisfies the law by construction: it IS
// recompute-from-state — the always-correct channel with no fast path to get
// wrong — pushed as a root replace (the snapshot shape every client and
// ui.ts already render; list() reconciles it by key set, so a recompose
// lands as minimal DOM churn).
//
// Why it exists (the japan grain lesson, 2026-08-01): anything you RENDER is
// a noun, and a noun must arrive as a doc — live, permitted, versioned —
// because a `call()` that returns rows is a read that escaped the permit
// lifetime ("a subscription never outlives its permit" can't bite data a
// call already handed out). call() is for VERBS. If no doc exposes what
// you're about to render, you add a view — never a fetch.
//
// The costs, named: recompose is EAGER — O(view) per matching doorbell where
// a fetch is lazy — bounded by eviction (a view composes only while
// watched), per-name coalescing, and an equality skip (`on` prefixes are
// coarse; most doorbells change nothing). Delivery is pgSync's, like every
// commit made outside a write hook (0.6.0): LISTEN taps the doorbell, poll
// mode sweeps the dependencies' version rows. No pgSync, no updates.
// ---------------------------------------------------------------------------

interface ViewEntry {
  prefix: string;
  fn: string;
  on: string[];
  sql: Sql;
  /** Per-name coalescing latch: doorbells during a recompose fold into one
   *  re-run instead of stacking queries. */
  busy: Map<string, { again: boolean }>;
}

const views = new WeakMap<Host, ViewEntry[]>();

function viewsOf(host: Host): ViewEntry[] {
  return views.get(host) ?? [];
}

/**
 * Host a read-only view: `pgView(host, sql, "tally:", { open: "tally_open",
 * on: ["board:", "mine:"] })`. Names are data, like every dynamic doc —
 * `tally:<uid>` is a per-identity view exactly the way `mine:<uid>` is a
 * per-identity doc (the decree holds: one name reads the same to everyone
 * permitted; different views for different people are different names).
 *
 * `open` is an app SQL function `<fn>(name, user)` — the composition AND
 * the permit, 001's rule verbatim: NULL user composes the host's full copy;
 * NULL result refuses (the wire reads "unknown doc" — no existence oracle),
 * asked fresh at EVERY open. No docs row, no version, no op log — a view
 * has nothing to migrate and nothing to undo.
 *
 * `on` lists the doc-name prefixes whose commits recompose it. Declared,
 * not inferred — that is the whole tractability of the feature (see
 * DESIGN.md "Non-goals": no UNDECLARED live queries).
 */
export function pgView(
  host: Host,
  sql: Sql,
  prefix: string,
  opts: { open: string; on: string[] },
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.open)) {
    throw new Error(`[epsilon/pg] view open must be a plain function name: ${opts.open}`);
  }
  const view: ViewEntry = { prefix, fn: opts.open, on: opts.on, sql, busy: new Map() };
  let list = views.get(host);
  if (!list) views.set(host, (list = []));
  list.push(view);

  host.docs(prefix, async (name, userId) => {
    // The first opener's permit — the composition function itself, asked
    // with their identity BEFORE anything is hosted: probes cost nothing.
    const asked = await sql.unsafe(`SELECT ${view.fn}($1, $2) AS d`, [name, userId ?? null]);
    if (asked[0]?.d == null) throw new Error(`unknown doc: ${name}`);
    let sig!: Signal<unknown>;
    sig = host.doc<unknown>(name, null, {
      // Read-only: the ONE thing a view refuses. Writes belong to the docs
      // it composes from.
      write() { throw new Error(`read-only view: ${name}`); },
      // The gate re-asks the composition per open (pgDoc's default, by hand
      // — a view has no docs row for doc_open to find).
      async open(u) {
        const rows = await sql.unsafe(`SELECT ${view.fn}($1, $2) IS NOT NULL AS ok`, [name, u ?? null]);
        return rows[0]?.ok ? sig.peek() : null;
      },
    });
    // The host composes as itself (001's rule); the gate decides who may
    // receive it. Evicted with its last watcher like any dynamic doc — this
    // factory recomposes on the next open.
    const full = await sql.unsafe(`SELECT ${view.fn}($1) AS d`, [name]);
    sig.apply([{ op: "replace", path: "", value: full[0]?.d ?? null }]);
  });
}

/** Recompose one hosted view name — coalesced per name, pushed only when
 *  the value actually moved. */
async function recompose(host: Host, view: ViewEntry, name: string): Promise<void> {
  const running = view.busy.get(name);
  if (running) { running.again = true; return; }
  const mine = { again: false };
  view.busy.set(name, mine);
  try {
    do {
      mine.again = false;
      const rows = await view.sql.unsafe(`SELECT ${view.fn}($1) AS d`, [name]);
      const data = (rows[0] as { d?: unknown } | undefined)?.d ?? null;
      // Evicted while composing: nothing to update — the factory recomposes
      // on the next open. Checked synchronously against the set-or-push.
      if (!host.names().includes(name)) return;
      const sig = host.doc<unknown>(name, null);
      // The equality skip. jsonb serializes with canonical key order and JS
      // preserves it through parse, so two equal compositions stringify
      // identically — a doorbell that changed nothing pushes nothing.
      if (JSON.stringify(sig.peek()) !== JSON.stringify(data)) {
        sig.apply([{ op: "replace", path: "", value: data }]);
      }
    } while (mine.again);
  } catch (err) {
    console.error(`[epsilon/pg] view ${name} recompose failed:`, err);
  } finally {
    view.busy.delete(name);
  }
}

/** A dependency committed (or died): recompose every hosted view that
 *  declared it. pgSync calls this from both delivery modes. */
function notifyViews(host: Host, changed: string): void {
  for (const view of viewsOf(host)) {
    if (!view.on.some((p) => changed.startsWith(p))) continue;
    for (const name of host.names()) {
      if (name.startsWith(view.prefix)) void recompose(host, view, name);
    }
  }
}

/** Recompose every hosted view — reconnect catch-up: doorbells rung while
 *  the listener was down reached nobody. */
function refreshViews(host: Host): void {
  for (const view of viewsOf(host)) {
    for (const name of host.names()) {
      if (name.startsWith(view.prefix)) void recompose(host, view, name);
    }
  }
}

/** Bring one hosted doc up to the database's version. Idempotent — receive()
 *  drops stale versions, so overlapping calls can't double-apply. */
async function catchUp(host: Host, sql: Sql, name: string): Promise<void> {
  let current: number;
  try { current = host.v(name); } catch { return; }        // not hosted here
  const missed = await sql`
    SELECT v, ops FROM doc_ops WHERE name = ${name} AND v > ${current} ORDER BY v`;
  for (const m of missed) {
    if (host.receive(name, Number(m.v), m.ops as Op[]) === "gap") {
      const [doc] = await sql`SELECT v, doc_open(name, NULL) AS data FROM docs WHERE name = ${name}`;
      if (doc) host.hydrate(name, Number(doc.v), doc.data);
      return;
    }
  }
}

export interface Sync {
  /** "listen" — pg LISTEN/NOTIFY push. "poll" — interval fallback. */
  mode: "listen" | "poll";
  stop(): void;
}

/**
 * Cross-process fan-out. Prefers real push: when the optional `pg` package
 * is installed, a dedicated connection LISTENs on the channel every persist
 * already NOTIFYs, with reconnect + full catch-up. Without `pg`, falls back
 * to polling hosted docs' versions. Deletions travel too: a `gone` doorbell
 * (or, polling, a row that stops coming back) un-hosts the doc here.
 *
 * The pg dependency exists ONLY because Bun's SQL client has no LISTEN
 * callbacks yet (verified, 1.3.14). The day `sql.listen` ships, the listen
 * branch moves to Bun and `pg` retires — the seam and tests don't change.
 */
export async function pgSync(
  host: Host,
  sql: Sql,
  opts?: { ms?: number; url?: string; mode?: "listen" | "poll" },
): Promise<Sync> {
  const url = opts?.url ?? process.env.EPSILON_PG_URL;

  // Names a sweep has seen a `docs` row for. Shared by BOTH delivery modes:
  // a name that was present and stops being present was doc_dropped under
  // us. Docs that never had a row (in-memory presence docs sharing the
  // host) are never eligible, which is why membership is earned, not assumed.
  const known = new Set<string>();

  /** Which hosted docs still exist? Drops the ones that stopped existing.
   *  The poll loop gets this for free from its own sweep; the listener needs
   *  it explicitly on reconnect — doc_drop DELETEs the op log, so a doc that
   *  died while the connection was down leaves catchUp() nothing to find and
   *  it reports success over a corpse. */
  async function sweepGone(): Promise<void> {
    const names = host.names();
    if (!names.length) return;
    const rows = await sql`
      SELECT name FROM docs
      WHERE name IN (SELECT jsonb_array_elements_text(${names as any}))`;
    const present = new Set<string>(rows.map((r: { name: string }) => r.name));
    for (const name of names) {
      if (present.has(name)) known.add(name);
      else if (known.delete(name)) host.drop(name);
    }
  }

  // --- listen mode (pg installed, url known) ------------------------------
  if (url && opts?.mode !== "poll") {
    let ClientCtor: any;
    try {
      const pg: any = await import("pg");
      ClientCtor = pg.Client ?? pg.default?.Client;
    } catch { /* pg not installed — fall through to polling */ }

    if (ClientCtor) {
      let client: any = null;
      let stopped = false;
      let backoff = 200;

      async function start(): Promise<void> {
        if (stopped) return;
        try {
          client = new ClientCtor({ connectionString: url });
          client.on("error", () => { if (!stopped) retry(); });
          await client.connect();
          await client.query(`LISTEN ${CHANNEL}`);
          client.on("notification", (msg: { payload?: string }) => {
            if (stopped || !msg.payload) return;
            try {
              const { name, gone } = JSON.parse(msg.payload) as { name: string; gone?: boolean };
              // Views hear every doorbell — a commit AND a death both change
              // what a dependent view composes to.
              notifyViews(host, name);
              // doc_drop's doorbell: the doc no longer exists anywhere —
              // un-host it and its watchers hear the snapshot of nothing.
              if (gone) return host.drop(name);
              void catchUp(host, sql, name).catch((err) =>
                console.error("[epsilon/pg] catch-up failed:", err));
            } catch { /* malformed payload — ignore */ }
          });
          backoff = 200;
          // Anything committed while we were (re)connecting was NOTIFYd to
          // nobody — catch every hosted doc up now, views included. A DEATH
          // in that window notifies nobody either and leaves no op to catch
          // up on, so ask the registry directly before recomposing views.
          for (const name of host.names()) await catchUp(host, sql, name);
          await sweepGone();
          refreshViews(host);
        } catch (err) {
          console.error("[epsilon/pg] listen connect failed:", err);
          retry();
        }
      }

      function retry(): void {
        try { client?.end(); } catch { /* closing */ }
        client = null;
        if (stopped) return;
        setTimeout(() => void start(), (backoff = Math.min(backoff * 2, 10_000)));
      }

      await start();
      return {
        mode: "listen",
        stop() {
          stopped = true;
          try { client?.end(); } catch { /* closing */ }
        },
      };
    }
  }

  // --- poll fallback ------------------------------------------------------
  let stopped = false;
  let inFlight = false;
  // (`known` is declared above — both modes share one death-detector.)
  // Views watch docs this process may not host: their dependencies' (name, v)
  // pairs, remembered between sweeps — a bump, a new name, or a vanished one
  // is that view's doorbell. Swept only while a view is actually hosted.
  const depV = new Map<string, string>();
  async function tickViews(hosted: string[]): Promise<void> {
    const active = viewsOf(host).filter((view) => hosted.some((n) => n.startsWith(view.prefix)));
    if (active.length === 0) { depV.clear(); return; }
    const patterns = [...new Set(active.flatMap((view) => view.on))]
      .map((p) => p.replace(/([\\%_])/g, "\\$1") + "%");
    const rows = await sql`
      SELECT name, v FROM docs
      WHERE name LIKE ANY (SELECT jsonb_array_elements_text(${patterns as any}))`;
    const seen = new Set<string>();
    const changed: string[] = [];
    for (const row of rows) {
      const name = row.name as string;
      seen.add(name);
      if (depV.get(name) !== String(row.v)) { depV.set(name, String(row.v)); changed.push(name); }
    }
    for (const name of [...depV.keys()]) {
      if (!seen.has(name)) { depV.delete(name); changed.push(name); }
    }
    // The first sweep reads everything as changed — recompose is coalesced
    // and the equality skip keeps a no-op sweep silent.
    for (const name of changed) notifyViews(host, name);
  }
  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const names = host.names();
      if (names.length === 0) return;
      // One sweep, not one query per doc. Bind as jsonb (Bun encodes JS
      // arrays that way) and unnest server-side.
      const rows = await sql`
        SELECT name, v FROM docs
        WHERE name IN (SELECT jsonb_array_elements_text(${names as any}))`;
      const present = new Set<string>();
      for (const row of rows) {
        present.add(row.name as string);
        let current: number;
        try { current = host.v(row.name as string); } catch { continue; }
        if (Number(row.v) > current) await catchUp(host, sql, row.name as string);
      }
      for (const name of names) {
        if (present.has(name)) known.add(name);
        else if (known.delete(name)) host.drop(name);
      }
      await tickViews(names);
    } catch (err) {
      console.error("[epsilon/pg] sync tick failed:", err);
    } finally {
      inFlight = false;
    }
  }
  const timer = setInterval(tick, opts?.ms ?? 250);
  return {
    mode: "poll",
    stop() { stopped = true; clearInterval(timer); },
  };
}

// ---------------------------------------------------------------------------
// Users — schema-native auth. The CONTRACT is SQL (db/002-auth.sql):
// register / login / session_start / session_user / session_end. Hashing is
// pgcrypto bcrypt, where the data lives. This module is only the wire
// adapter — swap the functions in a later migration and nothing here changes.
// ---------------------------------------------------------------------------

export interface User { id: number; name: string; email: string }

function asUser(row: any): User {
  return { id: Number(row.id), name: row.name, email: row.email };
}

/**
 * A fixed-window counter, in this process. `hit(key)` returns false once a
 * key has been seen more than `max` times inside `windowMs`.
 *
 * In-process on purpose: it protects THIS process's CPU, so it needs no
 * shared store and it cannot be reset by reconnecting. Memory is bounded by
 * sweeping EXPIRED slots first — clearing the whole map under pressure would
 * let a flood reset everyone's live window, which is the throttle paying for
 * its own defeat. @internal
 */
export function rateLimiter(max: number, windowMs: number) {
  const slots = new Map<string, { n: number; resetAt: number }>();
  return {
    hit(key: string): boolean {
      const now = Date.now();
      const slot = slots.get(key);
      if (!slot || now >= slot.resetAt) {
        if (slots.size > 10_000) {
          for (const [k, s] of slots) if (now >= s.resetAt) slots.delete(k);
          if (slots.size > 10_000) slots.clear();   // still full: stay bounded
        }
        slots.set(key, { n: 1, resetAt: now + windowMs });
        return true;
      }
      return ++slot.n <= max;
    },
  };
}

export async function pgAuth(
  host: Host,
  sql: Sql,
  opts?: { maxAttempts?: number; windowMs?: number; maxAttemptsPerIp?: number },
): Promise<void> {
  // bcrypt (cost 12) is deliberately expensive, which makes register/login a
  // CPU faucet for anyone hammering them — a fixed window caps that.
  // In-process on purpose: it protects THIS process's CPU; the SQL contract
  // stays unthrottled. `authenticate` is exempt — it's one indexed SELECT,
  // and every reconnect re-auths through it (onConnect).
  //
  // Keyed on IP **and email**, not IP alone. Behind a PaaS edge — which
  // README's "Deploying" recommends — `remoteAddress` is the load balancer, so an
  // IP-only key hands every user of the deployment ONE shared budget: ten
  // logins a minute for everybody, and the first person to fat-finger a
  // password locks out the rest. Adding the email splits the namespace by
  // the thing actually under attack, so a real user's own retries are what
  // count against them. Not per-SOCKET: that is free to reset by
  // reconnecting, which is no throttle at all.
  // The IP+email key alone does NOT bound CPU: rotating the email mints a
  // fresh budget every time, so one host can hold the bcrypt faucet fully
  // open. So there are two counters, and an attempt must pass both — a tight
  // per-ACCOUNT budget (what stops guessing a password) and a loose
  // per-ADDRESS one (what stops the faucet). The per-address cap is
  // deliberately generous, because behind a PaaS edge it is shared by every
  // user of the deployment; it exists to make a flood expensive, not to
  // police a household.
  const maxAttempts = opts?.maxAttempts ?? 10;
  const windowMs = opts?.windowMs ?? 60_000;
  const maxPerIp = opts?.maxAttemptsPerIp ?? 100;
  const perAccount = rateLimiter(maxAttempts, windowMs);
  const perAddress = rateLimiter(maxPerIp, windowMs);
  function throttle(ws: any, email?: string): void {
    const ip = String(ws?.remoteAddress ?? "?");
    if (!perAddress.hit(ip)) throw new Error("too many attempts — try again later");
    if (!perAccount.hit(`${ip}|${String(email ?? "").toLowerCase().trim()}`)) {
      throw new Error("too many attempts — try again later");
    }
  }

  async function startSession(ws: any, user: User): Promise<{ token: string; user: User }> {
    const [row] = await sql`SELECT session_start(${user.id}) AS token`;
    ws.data ??= {};
    ws.data.user = user;
    return { token: row.token as string, user };
  }

  host.method("register", async (params: { name?: string; email?: string; password?: string }, ws) => {
    const { name, email, password } = params ?? {};
    throttle(ws, email);
    if (!name || !email || !password) throw new Error("name, email, and password required");
    let rows;
    try {
      rows = await sql`SELECT register(${name}, ${email}, ${password}) AS u`;
    } catch (err) {
      // Bun's PostgresError puts ERR_POSTGRES_SERVER_ERROR in .code; match the
      // constraint violation by message rather than chasing the SQLSTATE.
      if (String(err).includes("duplicate key")) throw new Error("email already registered");
      throw err;
    }
    return startSession(ws, asUser(rows[0]!.u));
  }, { open: true });

  host.method("login", async (params: { email?: string; password?: string }, ws) => {
    const { email, password } = params ?? {};
    throttle(ws, email);
    if (!email || !password) throw new Error("email and password required");
    // login() returns NULL for unknown email AND wrong password alike, with
    // uniform timing — the distinction never reaches the wire.
    const [row] = await sql`SELECT login(${email}, ${password}) AS u`;
    if (!row?.u) throw new Error("invalid credentials");
    return startSession(ws, asUser(row.u));
  }, { open: true });

  host.method("authenticate", async (params: { token?: string }, ws) => {
    const { token } = params ?? {};
    if (!token) throw new Error("token required");
    const [row] = await sql`SELECT session_get(${token}) AS u`;
    if (!row?.u) throw new Error("invalid or expired session");
    const user = asUser(row.u);
    ws.data ??= {};
    ws.data.user = user;
    return user;
  }, { open: true });

  host.method("logout", async (params: { token?: string; everywhere?: boolean }, ws) => {
    // `everywhere` needs a session on the socket, not just a token — it ends
    // sessions this caller may not be holding.
    if (params?.everywhere) {
      const uid = (ws.data?.user as User | undefined)?.id;
      if (uid == null) throw new Error("sign in first");
      await sql`SELECT session_end_all(${uid})`;
    } else if (params?.token) {
      await sql`SELECT session_end(${params.token})`;
    }
    if (ws.data) delete ws.data.user;
    return { ok: true };
  }, { open: true });
}
