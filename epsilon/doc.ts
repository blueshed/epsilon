/**
 * Doc — the wire. One Signal class on both sides; the WebSocket hides inside
 * apply().
 *
 * DRY rules this file lives by:
 *   - ONE vocabulary: even the open snapshot is an op — a root replace with a
 *     version. There is no second "snapshot" message shape.
 *   - ONE write path: a remote doc IS a Signal whose apply() sends instead of
 *     mutating; the server's echo performs the local apply. set(), update(),
 *     and every at() lens compose over the wire untouched — location
 *     transparency for free, because Lens only ever calls root.apply().
 *   - No optimistic apply. The echo renders the write (delta's rule): apply
 *     locally too and it double-applies.
 *
 * Server (authority):
 *   const host = createHost();
 *   const board = host.doc<Board>("board", empty);   // a real Signal
 *   const server = Bun.serve({ port, fetch: host.fetch, websocket: host.websocket });
 *   host.setServer(server);
 *   board.apply(ops)                                  // mutates + broadcasts
 *
 * Client:
 *   const remote = connect("ws://localhost:3000/ws");
 *   const board = remote.doc<Board>("board");
 *   await board.ready;
 *   board.at("/cards/1/done").set(true);              // → wire → echo → local
 *
 * Versioning: the server stamps a contiguous v per doc. The client applies
 * v === expected + 1, ignores replays, and re-opens on a gap. Reconnects
 * re-open every doc; the snapshot-as-op resets the baseline.
 */

import { Signal, signal, type OpSignal } from "./signal";
import { valueAt, type Op } from "./op";

type ClientMsg =
  | { action: "open"; doc: string }
  | { action: "close"; doc: string }
  // `id` OPTIONAL: without it a write is fire-and-forget (apply(), the
  // location-transparent path); with it the server replies on the SAME
  // frame shape a call() uses, so the resolved ops — server-minted ids
  // included — come home. No second message shape; see doc.write().
  | { action: "ops"; doc: string; ops: Op[]; id?: number }
  | { action: "call"; id: number; method: string; params?: unknown };

type ServerMsg =
  | { doc: string; v: number; ops: Op[] }
  // `write: true` marks a refused WRITE. Without it this frame is a refused
  // OPEN — two unrelated events that used to be indistinguishable, leaving
  // consumers to classify by regexing the error prose.
  | { doc: string; error: string; write?: true }
  | { id: number; result?: unknown; error?: string };

// ---------------------------------------------------------------------------
// Server — createHost()
// ---------------------------------------------------------------------------

export interface DocOpts {
  /**
   * Authority-replacement hook: when set, client ops are handed here INSTEAD
   * of being applied to the signal — for docs whose truth lives elsewhere
   * (relational tables behind a stored function). The implementation applies
   * to storage, then injects the resolved result via host.receive(). Server
   * minting included: `-` ids are storage's to assign on this path.
   * `userId` is the authenticated writer (audit trail — doc_ops.by_user).
   */
  write?: (ops: Op[], userId?: number | string) => void | Op[] | Promise<void | Op[]>;
  /**
   * Identity gate for the OPEN snapshot: return the snapshot for this user,
   * or null/undefined to refuse (the client sees "not found" and is NOT
   * subscribed). May be async — a membership check belongs in SQL. Docs
   * without it serve the hosted signal to any socket the host admits.
   */
  open?: (userId?: number | string) => unknown | Promise<unknown>;
}

/**
 * Decision 1 — the server mints ids, every tier. An `add` ending in `/-`
 * against a RECORD collection gets a server uuid (arrays keep native append
 * semantics). Storage-backed docs mint in storage instead (their write hook
 * sees the raw `-`; Postgres sequences assign).
 */
function mintIds(doc: unknown, ops: Op[]): Op[] {
  return ops.map((op) => {
    if (op.op !== "add" || !op.path.endsWith("/-")) return op;
    const parentPath = op.path.slice(0, -2);
    if (Array.isArray(valueAt(doc, parentPath))) return op;
    return { ...op, path: `${parentPath}/${crypto.randomUUID()}` };
  });
}

export interface Host {
  /** Register (or fetch) a hosted doc. The returned Signal is the authority —
   *  server code applies ops to it directly and they broadcast. */
  doc<T>(name: string, empty: T, opts?: DocOpts): Signal<T>;
  /** Load state from storage: broadcasts a snapshot at version v. */
  hydrate(name: string, v: number, data: unknown): void;
  /** Inject ops another process committed: broadcast + apply.
   *  Returns "gap" when v isn't contiguous — caller should reload + hydrate. */
  receive(name: string, v: number, ops: Op[]): "ok" | "stale" | "gap";
  /** Current version of a hosted doc. */
  v(name: string): number;
  /** Names of all hosted docs (storage sync iterates these). */
  names(): string[];
  /**
   * Un-host a doc that no longer exists: every watcher receives the snapshot
   * of nothing (root replace → null) and is unsubscribed; the entry is
   * forgotten. A dynamic name may meet its factory again on a later open —
   * which refuses now the backing rows are gone. Storage is the caller's
   * business: drop() only ends the hosting (the relational tier's doc_drop
   * already deleted the row and rang the doorbell). Unknown names no-op.
   */
  drop(name: string): void;
  /**
   * Revocation for the already-subscribed: re-ask the doc's `open` gate for
   * this user and, when it refuses, evict their sockets (snapshot of
   * nothing + unsubscribe). The gate answering the SAME question at open
   * time keeps one permit for both moments. No-op on docs without a gate —
   * an ungated doc has no permit to lose — and on users the gate still
   * admits (a remove+re-add batch nets to nothing).
   */
  expel(name: string, userId?: number | string): Promise<void>;
  /**
   * Register an RPC method, callable from clients via remote.call().
   *
   * On a `requireAuth` host a method needs a session on the socket, exactly
   * like doc traffic. `{ open: true }` is the opt-out, and it is only for
   * the methods that MINT a session (login, register, authenticate) or run
   * before one can exist (the passkey login ceremony) — the door has to be
   * reachable from outside the room. Anything that reads or writes app
   * state must not set it: `history` and `undo` did not have this gate
   * until 0.10.1, and a call-shaped read is not covered by the doc permit
   * a NULL user passes as "the host asking as itself".
   */
  method(
    name: string,
    fn: (params: any, ws: any) => unknown | Promise<unknown>,
    opts?: { open?: boolean },
  ): void;
  /**
   * Dynamic docs: when a client opens an unregistered name matching prefix,
   * the factory runs once (concurrent opens coalesce) and must register the
   * doc via host.doc(). Doc names are data — "board:42", "mine:7".
   * `userId` is the asking socket's authenticated user: throw BEFORE
   * registering to refuse ("unknown doc" — no existence oracle) and a probe
   * hosts and seeds nothing. Coalesced opens share the FIRST asker's run —
   * per-user refusal of an already-registered doc belongs to `open`/`guard`.
   */
  docs(prefix: string, factory: (name: string, userId?: number | string) => unknown | Promise<unknown>): void;
  fetch(req: Request, server: any): Response | undefined;
  websocket: {
    message(ws: any, raw: string | Buffer): void | Promise<void>;
    open(ws: any): void;
    close(ws: any): void;
  };
  setServer(s: any): void;
  path: string;
}

export function createHost(opts?: {
  path?: string;
  /** When set, open/ops AND calls require ws.data.user (set by an auth
   *  method registered with `{ open: true }`). */
  requireAuth?: boolean;
  /** Ops accepted in one write. One batch is one transaction holding one
   *  row lock, so this bounds how long a single client can stall a doc.
   *  Default 500. */
  maxOpsPerBatch?: number;
  /** Web origins allowed to open a socket. Unset = any (local dev, a public
   *  demo). Set it in production: a WebSocket is not bound by the same-origin
   *  policy, so without it any page can talk to your server as your signed-in
   *  user. Requests with no Origin header (CLI, tests) are unaffected. */
  origins?: string[];
  /** Fired after a socket's FIRST successful open of a doc (snapshot already
   *  sent, so ops applied here reach the new subscriber in order). Presence
   *  is built on this pair — see server.ts. */
  onSubscribe?: (doc: string, ws: any) => void;
  /** Fired when a socket releases a doc — close action or socket death —
   *  after any eviction, so writes back into an unwatched doc can check
   *  host.names() first. */
  onUnsubscribe?: (doc: string, ws: any) => void;
}): Host {
  const path = opts?.path ?? "/ws";
  // subs: the sockets currently subscribed (lifetime tax — and the set
  // drop/expel evict from). dynamic: hosted by a prefix factory, so it can
  // be re-hosted — and is EVICTED when the last subscriber leaves;
  // statically registered docs live for the process.
  type Entry = { sig: Signal<any>; v: number; subs: Set<any>; dynamic: boolean; write?: DocOpts["write"]; open?: DocOpts["open"] };
  const docs = new Map<string, Entry>();
  const maxOps = opts?.maxOpsPerBatch ?? 500;
  const allowedOrigins = opts?.origins ? new Set(opts.origins) : undefined;
  type Method = { fn: (params: any, ws: any) => unknown | Promise<unknown>; open: boolean };
  const methods = new Map<string, Method>();
  const prefixes = new Map<string, (name: string, userId?: number | string) => unknown | Promise<unknown>>();
  const pendingFactories = new Map<string, Promise<unknown>>();
  let server: any = null;

  function entryOf(name: string) {
    const entry = docs.get(name);
    if (!entry) throw new Error(`[epsilon/doc] unknown doc: ${name}`);
    return entry;
  }

  /** Registered entry, or run the matching prefix factory (coalesced). */
  async function resolveEntry(name: string, userId?: number | string): Promise<Entry | undefined> {
    const existing = docs.get(name);
    if (existing) return existing;
    // What was hosted before any factory ran — so everything the factory
    // registers can be found afterwards, siblings included. Everything from
    // the `await` below to the end of the loop body is synchronous, so a
    // coalesced second opener cannot observe the half-checked state.
    const before = new Set(docs.keys());
    // LONGEST prefix wins. Iterating the Map in insertion order made the
    // answer depend on registration order, so registering "board:" before
    // "board:archived:" silently shadowed the second — a bug that looks like
    // the factory never running. Most specific is the only order that can't
    // surprise you.
    for (const [prefix, factory] of [...prefixes].sort((a, b) => b[0].length - a[0].length)) {
      if (!name.startsWith(prefix)) continue;
      let pending = pendingFactories.get(name);
      if (!pending) {
        pending = Promise.resolve(factory(name, userId));
        pendingFactories.set(name, pending);
        pending.finally(() => pendingFactories.delete(name)).catch(() => {});
      }
      await pending;
      // Everything the factory registered is dynamic — re-hostable, and
      // evicted when unwatched. Siblings were missed here until 0.10.3,
      // which also leaked them (dynamic=false lives for the process).
      for (const n of docs.keys()) if (!before.has(n)) docs.get(n)!.dynamic = true;
      // A factory refusal guards only the FIRST open — the doc outlives its
      // opener. Relational docs stay safe because pgDoc's default gate asks
      // doc_open(name, user) per open; an in-memory doc has no such default,
      // so hosting one WITHOUT a gate on an auth-gated host would fail open
      // for as long as anyone watches it. Refuse at hosting time — the one
      // moment the mistake is cheap — and un-host, so the next open meets
      // the factory (and this error) again.
      //
      // Every doc the factory registered is checked, not just the name that
      // was asked for: a factory may host siblings (a "room:x" factory that
      // also hosts "room:x:meta"), and those are reached later by the
      // registered-entry fast path above, which never runs a factory and so
      // never reaches this check. Missing them left exactly the hole this
      // guard exists to close.
      if (opts?.requireAuth) {
        const gateless = [...docs.keys()].filter((n) => !before.has(n) && !docs.get(n)!.open);
        if (gateless.length) {
          for (const n of gateless) docs.delete(n);
          throw new Error(
            `[epsilon/doc] ${gateless.join(", ")}: a dynamic doc on a requireAuth host needs an ` +
              `open gate — the factory refusal guards only the first open. Pass { open } to ` +
              `host.doc() (an intentionally public doc states it: open: () => sig.peek()).`,
          );
        }
      }
      return docs.get(name);
    }
    return undefined;
  }

  /** Drop a socket's subscription; evict a dynamic doc nobody watches —
   *  its factory re-hosts it (and recomposes) on the next open. */
  function unsubscribe(ws: any, name: string): void {
    if (!ws.data?.docs?.delete(name)) return;
    try { ws.unsubscribe(name); } catch { /* socket already gone */ }
    const entry = docs.get(name);
    if (entry) {
      entry.subs.delete(ws);
      if (entry.subs.size === 0 && entry.dynamic) docs.delete(name);
    }
    try { opts?.onUnsubscribe?.(name, ws); }
    catch (err) { console.error("[epsilon/doc] onUnsubscribe hook threw:", err); }
  }

  /** End one socket's subscription FROM the server: push the snapshot of
   *  nothing — a root replace to null, the same value every doc holds before
   *  its first snapshot, over the one message shape — then release it
   *  (hooks fire as usual). The client's copy empties reactively. */
  function evict(name: string, entry: Entry, ws: any): void {
    try {
      ws.send(JSON.stringify({
        doc: name, v: entry.v,
        ops: [{ op: "replace", path: "", value: null }],
      } satisfies ServerMsg));
    } catch { /* socket already gone */ }
    unsubscribe(ws, name);
  }

  return {
    path,
    setServer(s: any) { server = s; },

    doc<T>(name: string, empty: T, docOpts?: DocOpts): Signal<T> {
      const existing = docs.get(name);
      if (existing) return existing.sig as Signal<T>;
      const sig = signal<T>(empty);
      const entry: Entry = { sig, v: 0, subs: new Set(), dynamic: false, write: docOpts?.write, open: docOpts?.open };
      docs.set(name, entry);
      // Broadcast is just the doc's own ops channel piped to subscribers —
      // whether the write came from a client, server code, or storage
      // (hydrate/receive pre-set the version so this bump lands on it).
      sig.onOps((ops) => {
        entry.v++;
        server?.publish(name, JSON.stringify({ doc: name, v: entry.v, ops } satisfies ServerMsg));
      });
      return sig;
    },

    hydrate(name, v, data) {
      const entry = entryOf(name);
      entry.v = v - 1;              // the apply below bumps it back to v
      entry.sig.apply([{ op: "replace", path: "", value: data }]);
    },

    receive(name, v, ops) {
      const entry = entryOf(name);
      if (v <= entry.v) return "stale";
      if (v > entry.v + 1) return "gap";
      entry.v = v - 1;
      entry.sig.apply(ops);
      return "ok";
    },

    v(name) {
      return entryOf(name).v;
    },

    names() {
      return [...docs.keys()];
    },

    drop(name) {
      const entry = docs.get(name);
      if (!entry) return;
      for (const ws of [...entry.subs]) evict(name, entry, ws);
      docs.delete(name);
    },

    async expel(name, userId) {
      const entry = docs.get(name);
      if (!entry?.open) return;
      const targets = [...entry.subs].filter((ws) => ws.data?.user?.id === userId);
      if (targets.length === 0) return;
      let snapshot: unknown = null;
      try { snapshot = await entry.open(userId); } catch { snapshot = null; }
      if (snapshot != null) return;
      for (const ws of targets) evict(name, entry, ws);
    },

    method(name, fn, mopts) {
      methods.set(name, { fn, open: mopts?.open === true });
    },

    docs(prefix, factory) {
      prefixes.set(prefix, factory);
    },

    fetch(req: Request, srv: any) {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      const origin = req.headers.get("origin");
      // WebSockets are NOT subject to the same-origin policy: without this
      // check any page the user visits can open a socket to a deployment they
      // are signed in to and speak the protocol as them. `origins` is the
      // allowlist; unset keeps every origin, which is right for local work
      // and for a public read-only demo, and wrong for anything with a
      // session behind it. A missing Origin header is a non-browser client
      // (the CLI, a test) and is not what this defends against.
      if (allowedOrigins && origin && !allowedOrigins.has(origin)) {
        return new Response("forbidden origin", { status: 403 });
      }
      // The socket remembers where it came from — passkey ceremonies bind
      // to this origin by default (epsilon/passkey.ts).
      if (srv.upgrade(req, { data: { origin } })) return undefined;
      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws: any) {
        ws.data ??= {};                     // upgrade data (origin) rides along
        ws.data.docs = new Set<string>();   // this socket's subscriptions
      },
      close(ws: any) {
        for (const name of [...(ws.data?.docs ?? [])]) unsubscribe(ws, name);
      },
      async message(ws: any, raw: string | Buffer) {
        let msg: ClientMsg;
        try { msg = JSON.parse(String(raw)); } catch { return; }

        if (msg.action === "call") {
          const m = methods.get(msg.method);
          if (!m) {
            ws.send(JSON.stringify({ id: msg.id, error: `unknown method: ${msg.method}` } satisfies ServerMsg));
            return;
          }
          // The SAME gate doc traffic gets, on the same socket state. This
          // branch used to return before it, which made every method — the
          // audit log read, undo, the operator's door — reachable without a
          // session, and a NULL user reads as "the host itself" inside the
          // SQL permits. Only session-minting methods opt out.
          if (opts?.requireAuth && !m.open && ws.data?.user == null) {
            ws.send(JSON.stringify({ id: msg.id, error: "unauthenticated" } satisfies ServerMsg));
            return;
          }
          try {
            const result = await m.fn(msg.params, ws);
            ws.send(JSON.stringify({ id: msg.id, result } satisfies ServerMsg));
          } catch (err) {
            ws.send(JSON.stringify({ id: msg.id, error: String(err) } satisfies ServerMsg));
          }
          return;
        }

        if (msg.action === "close") {
          unsubscribe(ws, msg.doc);   // idempotent; unknown names no-op
          return;
        }

        // Doc traffic — gated when the host requires auth (an auth method
        // sets ws.data.user; docs stay closed until it has).
        if (opts?.requireAuth && ws.data?.user == null) {
          ws.send(JSON.stringify({ doc: msg.doc, error: "unauthenticated" } satisfies ServerMsg));
          return;
        }
        let entry: Entry | undefined;
        try {
          entry = await resolveEntry(msg.doc, ws.data?.user?.id);
        } catch (err) {
          ws.send(JSON.stringify({ doc: msg.doc, error: String(err) } satisfies ServerMsg));
          return;
        }
        if (!entry) {
          ws.send(JSON.stringify({ doc: msg.doc, error: `unknown doc: ${msg.doc}` } satisfies ServerMsg));
          return;
        }
        if (msg.action === "open") {
          // Identity-gated docs choose their snapshot per user — a refusal
          // reads exactly like a missing doc (no existence oracle) and does
          // NOT subscribe the socket.
          let snapshot: unknown;
          try {
            snapshot = entry.open ? await entry.open(ws.data?.user?.id) : entry.sig.peek();
          } catch (err) {
            ws.send(JSON.stringify({ doc: msg.doc, error: String(err) } satisfies ServerMsg));
            return;
          }
          if (entry.open && snapshot == null) {
            ws.send(JSON.stringify({ doc: msg.doc, error: `unknown doc: ${msg.doc}` } satisfies ServerMsg));
            return;
          }
          // Pair the version with the snapshot HERE, while nothing has been
          // awaited since it was taken. A snapshot sent under a v it doesn't
          // match is the one desync the protocol cannot detect: the client
          // accepts the baseline, then silently ignores every op it already
          // "has". The invariant an `open` hook must keep is the same one —
          // return a value current as of the moment it returns, not one
          // computed before its last await.
          const v = entry.v;
          ws.subscribe(msg.doc);
          // Count each socket once — a gap-triggered re-open isn't a new sub.
          const isNew = !ws.data.docs.has(msg.doc);
          if (isNew) {
            ws.data.docs.add(msg.doc);
            entry.subs.add(ws);
          }
          // The snapshot IS an op — same vocabulary, same client code path.
          ws.send(JSON.stringify({
            doc: msg.doc, v,
            ops: [{ op: "replace", path: "", value: snapshot }],
          } satisfies ServerMsg));
          // After the send: ops the hook applies follow the snapshot in order.
          if (isNew) {
            try { opts?.onSubscribe?.(msg.doc, ws); }
            catch (err) { console.error("[epsilon/doc] onSubscribe hook threw:", err); }
          }
        } else if (msg.action === "ops") {
          // One batch is one transaction, and on the relational tier it holds
          // the doc's row lock for its whole length — so an unbounded batch is
          // an unbounded hold, and the embedded engine runs every query through
          // one chain, which means one client can make that everyone's problem.
          // It also writes the ops AND their inverse into a single doc_ops row.
          // The bound is structural, not tuned to a benchmark; 500 is far above
          // any real edit, and maxOpsPerBatch raises it if you disagree.
          if (!Array.isArray(msg.ops) || msg.ops.length > maxOps) {
            ws.send(JSON.stringify({
              doc: msg.doc, write: true,
              error: Array.isArray(msg.ops)
                ? `too many ops in one write: ${msg.ops.length} (max ${maxOps})`
                : "ops must be an array",
            } satisfies ServerMsg));
            return;
          }
          try {
            let resolved: Op[];
            if (entry.write) {
              // Storage is the authority (relational tier): it applies,
              // mints ids, and re-enters via host.receive().
              resolved = (await entry.write(msg.ops, ws.data?.user?.id)) || msg.ops;
            } else {
              resolved = mintIds(entry.sig.peek(), msg.ops);
              entry.sig.apply(resolved);
            }
            // Only an id-bearing write gets a reply — apply() stays exactly
            // as silent as it was, so this is additive on the wire.
            if (msg.id != null) {
              ws.send(JSON.stringify({ id: msg.id, result: resolved } satisfies ServerMsg));
            }
          } catch (err) {
            // The refusal goes back to the WRITER via its id when it has one
            // (a rejected promise at the call site); otherwise it takes the
            // doc-scoped path, now marked so it can be told from a refused open.
            if (msg.id != null) {
              ws.send(JSON.stringify({ id: msg.id, error: String(err) } satisfies ServerMsg));
            } else {
              ws.send(JSON.stringify({ doc: msg.doc, error: String(err), write: true } satisfies ServerMsg));
            }
          }
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Client — connect()
// ---------------------------------------------------------------------------

/** A synced doc: a Signal whose apply() SENDS. The echo mutates. */
class RemoteDoc<T> extends Signal<T | null> {
  /** Settles when the first snapshot lands; REJECTS when the server refuses
   *  the open (unknown doc, unauthenticated). Re-asking after a refusal
   *  re-arms it — read `.ready` fresh rather than caching the promise. */
  ready!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: Error) => void;
  private state: "pending" | "open" | "refused" = "pending";
  /** Last server version applied; 0 = no snapshot yet. */
  v = 0;
  /** Live handles from remote.doc() — close() releases one. @internal */
  refs = 0;
  private closed = false;

  constructor(
    private send: (ops: Op[]) => void,
    private release: () => void,
    private sendAwaited: (ops: Op[]) => Promise<Op[]> = () => {
      throw new Error("[epsilon/doc] write() needs a remote");
    },
  ) {
    super(null);
    this.arm();
  }

  /** Release one handle. The LAST close unsubscribes on the server, stops
   *  reconnect re-opens, and drops queued writes — the doc is gone; a later
   *  remote.doc(name) starts fresh. Lifetime is paid here, not at restart. */
  close(): void {
    if (this.closed || --this.refs > 0) return;
    this.closed = true;
    this.release();
  }

  /** Writes through a closed handle are bugs — refuse loudly, not silently. */
  private assertOpen(): void {
    if (this.closed) throw new Error("[epsilon/doc] doc is closed");
  }

  private arm(): void {
    this.state = "pending";
    this.ready = new Promise<void>((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
    // A refusal also reports through onError — never an unhandled rejection.
    this.ready.catch(() => {});
  }

  /** Location transparency: writes go to the authority, never local. */
  override apply(ops: Op[]): void {
    this.assertOpen();
    this.send(ops);
  }

  /**
   * apply(), but the authority answers. Resolves with the RESOLVED ops —
   * server-minted ids in their paths — and REJECTS if the write is refused.
   *
   *   const [minted] = await trip.write([{ op: "add", path: "/legs/-", value }]);
   *   select(minted.path.split("/").pop()!);          // the real id, first try
   *
   * Why it exists: apply() returns void so that one call works on a local
   * signal, a lens, and a remote doc alike — location transparency. The
   * shadow of that is a writer who cannot learn the id storage minted, and
   * every app grew the same workaround: watch the echo and guess which row
   * is yours by matching its VALUE. Two people adding "Kyoto" in the same
   * second guess wrong.
   *
   * It lives on DocHandle ONLY, never on OpSignal or a lens — Lens.apply
   * delegates to the root and returns void, so a lens cannot honour this
   * contract, and pretending otherwise would break the one-write-path rule.
   * Reach for apply() by default; reach for write() when you need the id
   * back or the refusal in a catch.
   */
  write(ops: Op[]): Promise<Op[]> {
    this.assertOpen();
    return this.sendAwaited(ops);
  }

  /** Fresh pending `ready` after a refusal — called before a re-ask. @internal */
  reopen(): void {
    if (this.state === "refused") this.arm();
  }

  /** The echo path — the only place local state actually changes. @internal */
  receive(v: number, ops: Op[]): "ok" | "gap" | "stale" {
    const isSnapshot = ops.length === 1 && ops[0]!.path === "" && ops[0]!.op === "replace";
    if (isSnapshot) {
      this.v = v;
    } else {
      if (v <= this.v) return "stale";      // replay — already applied
      if (v > this.v + 1) return "gap";     // missed one — caller re-opens
      this.v = v;
    }
    super.apply(ops);
    this.reopen();          // a reconnect can succeed without a re-ask
    this.state = "open";
    this.resolveReady();
    return "ok";
  }

  /** Server refused this doc before any snapshot landed: settle ready so
   *  awaiting callers don't hang. Later write errors don't touch it. @internal */
  refuse(error: string): void {
    if (this.state !== "pending") return;
    this.state = "refused";
    this.rejectReady(new Error(error));
  }
}

/** What remote.doc() hands back: the doc plus its lifetime and version. */
export type DocHandle<T> = OpSignal<T | null> & {
  ready: Promise<void>;
  /** Last server version applied; 0 = no snapshot yet. */
  readonly v: number;
  /** apply() with an answer: resolves with the RESOLVED ops (server-minted
   *  ids in their paths), rejects if the write is refused. Handle-only —
   *  a lens delegates apply() to the root and cannot honour it. */
  write(ops: Op[]): Promise<Op[]>;
  /** Release this handle; the last one closes the doc (see RemoteDoc.close). */
  close(): void;
};

export interface Remote {
  doc<T>(name: string): DocHandle<T>;
  /** Invoke a host method (auth, RPC). Rejects on error or transport drop. */
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): void;
}

export function connect(
  url: string,
  opts?: {
    /** A doc-scoped refusal. `meta.write` is true when a WRITE was refused
     *  and false/absent when an OPEN was — two unrelated events that shared
     *  one shape until 0.8.1, leaving consumers to classify by error prose.
     *  Third argument, so existing two-argument handlers still compile. */
    onError?: (doc: string, error: string, meta?: { write?: true }) => void;
    /** Awaited on EVERY socket open — first connect and each reconnect —
     *  BEFORE queued calls flush and before docs (re)open. Authenticate here
     *  and a requireAuth host serves everything that follows. */
    onConnect?: (remote: Remote) => void | Promise<void>;
    /** Fires on EVERY socket close, deliberate or not — the symmetric half
     *  of onConnect. Doc signals keep their last value on a drop (the
     *  reconnect's snapshot resets them), so anything rendered as live —
     *  presence, a connection dot — must hear the drop from HERE, or it
     *  testifies stale. willRetry is false only for remote.close(). */
    onDisconnect?: (willRetry: boolean) => void;
  },
): Remote {
  const docs = new Map<string, RemoteDoc<any>>();
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const queued: ClientMsg[] = [];    // calls made before the socket opened
  const queuedOps: ClientMsg[] = []; // writes made while the socket was down
  let nextId = 1;
  let ws: WebSocket;
  let closed = false;
  let backoff = 100;

  const send = (msg: ClientMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const remote: Remote = {
    doc<T>(name: string) {
      // Same guard call() has. Without it a doc asked for after close() gets
      // a handle whose `ready` never settles and whose writes go nowhere —
      // a hang with no error, which is the worst of both.
      if (closed) throw new Error("closed");
      let doc = docs.get(name) as RemoteDoc<T> | undefined;
      if (!doc) {
        doc = new RemoteDoc<T>(
          (ops) => {
            // Never drop a write silently: while the socket is down, ops queue
            // and flush on reconnect — after the connect hook and the re-opens,
            // so a requireAuth host accepts them and echoes flow normally.
            const msg: ClientMsg = { action: "ops", doc: name, ops };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
            else queuedOps.push(msg);
          },
          () => {
            // Last handle closed: forget the doc (reconnects stop re-opening
            // it), abandon its queued writes, tell the server. A close while
            // the socket is down needs no message — the socket's death
            // already unsubscribed us there.
            docs.delete(name);
            for (let i = queuedOps.length - 1; i >= 0; i--) {
              if ((queuedOps[i] as { doc?: string }).doc === name) queuedOps.splice(i, 1);
            }
            send({ action: "close", doc: name });
          },
          (ops) => {
            // The awaited write. Same queue as apply()'s — a write made
            // while the socket is down flushes on reconnect — but it also
            // registers a pending reply, so ws.onclose rejects it rather
            // than leaving the caller hanging. Identical discipline to
            // call(): a retry after reconnect is the caller's decision,
            // because a write is not necessarily idempotent.
            const id = nextId++;
            const msg: ClientMsg = { action: "ops", doc: name, ops, id };
            return new Promise<Op[]>((resolve, reject) => {
              pending.set(id, { resolve, reject });
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
              else queuedOps.push(msg);
            });
          },
        );
        docs.set(name, doc);
        send({ action: "open", doc: name }); // no-op if not connected yet
      } else if (doc.v === 0) {
        // Asked again before any snapshot landed — the first open may have
        // been refused (e.g. pre-auth on a requireAuth host). Ask again.
        doc.reopen();
        send({ action: "open", doc: name });
      }
      doc.refs++;
      return doc;
    },
    call<T>(method: string, params?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (closed) return reject(new Error("closed"));
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const msg: ClientMsg = { action: "call", id, method, params };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        else queued.push(msg);   // sent on open; rejected if the dial fails (onclose drains pending)
      });
    },
    close() {
      closed = true;
      for (const [, p] of pending) p.reject(new Error("closed"));
      pending.clear();
      queuedOps.length = 0;   // a deliberate close abandons unflushed writes
      try { ws.close(); } catch { /* already closed */ }
    },
  };

  function wire() {
    ws = new WebSocket(url);
    ws.onopen = async () => {
      backoff = 100;
      // The connect hook FIRST, then everything that was waiting on the
      // socket: queued calls, then (re)open every doc — the snapshot-as-op
      // resets each baseline. It used to be the other way round, and a call
      // issued before the dial completed — which is every call a one-shot
      // CLI makes — overtook its own authenticate and landed on a
      // session-less socket. The hook's own calls do not queue: the socket
      // is OPEN by the time it runs, so they send directly.
      try {
        await opts?.onConnect?.(remote);
      } catch (err) {
        // Opens proceed regardless — refusals surface through onError.
        console.error("[epsilon/doc] onConnect hook failed:", err);
      }
      for (const msg of queued.splice(0)) ws.send(JSON.stringify(msg));
      for (const name of docs.keys()) send({ action: "open", doc: name });
      for (const msg of queuedOps.splice(0)) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      if ("id" in msg) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error != null) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if ("error" in msg) {
        // Only an OPEN refusal settles `ready` — a rejected write must not
        // tear down a doc that is open and working.
        if (!msg.write) docs.get(msg.doc)?.refuse(msg.error);
        opts?.onError?.(msg.doc, msg.error, msg.write ? { write: true } : undefined);
        return;
      }
      const doc = docs.get(msg.doc);
      if (!doc) return;
      if (doc.receive(msg.v, msg.ops) === "gap") send({ action: "open", doc: msg.doc });
    };
    ws.onclose = () => {
      // Fail fast rather than hang — a retried call after reconnect is the
      // caller's decision (it may not be idempotent, e.g. register).
      //
      // Then DROP what we just rejected. An id-bearing message is one whose
      // promise has an owner; telling that owner "disconnected" and flushing
      // the message anyway on reconnect means the server runs it while the
      // caller believes it failed — so a caller who does the documented thing
      // and retries executes it twice (a `register` rejected as disconnected
      // still registered). Fire-and-forget writes carry no id and no promise:
      // those keep queueing and flushing, which is apply()'s contract.
      for (const [, p] of pending) p.reject(new Error("disconnected"));
      pending.clear();
      const drop = (q: ClientMsg[]) => {
        for (let i = q.length - 1; i >= 0; i--) {
          if ((q[i] as { id?: number }).id !== undefined) q.splice(i, 1);
        }
      };
      drop(queuedOps);
      drop(queued);
      try {
        opts?.onDisconnect?.(!closed);
      } catch (err) {
        console.error("[epsilon/doc] onDisconnect hook failed:", err);
      }
      if (closed) return;
      setTimeout(wire, (backoff = Math.min(backoff * 2, 10_000)));
    };
  }
  wire();

  return remote;
}
