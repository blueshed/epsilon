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
  | { action: "ops"; doc: string; ops: Op[] }
  | { action: "call"; id: number; method: string; params?: unknown };

type ServerMsg =
  | { doc: string; v: number; ops: Op[] }
  | { doc: string; error: string }
  | { id: number; result?: unknown; error?: string };

// ---------------------------------------------------------------------------
// Server — createHost()
// ---------------------------------------------------------------------------

export interface DocOpts {
  /** Durability hook — called after each local write with the new version,
   *  the ops, and the post-apply state. NOT called for hydrate/receive
   *  (those ops came FROM storage). */
  persist?: (v: number, ops: Op[], data: unknown) => void;
  /**
   * Authority-replacement hook: when set, client ops are handed here INSTEAD
   * of being applied to the signal — for docs whose truth lives elsewhere
   * (relational tables behind a stored function). The implementation applies
   * to storage, then injects the resolved result via host.receive(). Server
   * minting included: `-` ids are storage's to assign on this path.
   * `userId` is the authenticated writer (audit trail — doc_ops.by_user).
   */
  write?: (ops: Op[], userId?: number | string) => void | Promise<void>;
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
  /** Load state from storage: broadcasts a snapshot at version v, skips persist. */
  hydrate(name: string, v: number, data: unknown): void;
  /** Inject ops another process persisted: broadcast + apply, skip persist.
   *  Returns "gap" when v isn't contiguous — caller should reload + hydrate. */
  receive(name: string, v: number, ops: Op[]): "ok" | "stale" | "gap";
  /** Current version of a hosted doc. */
  v(name: string): number;
  /** Names of all hosted docs (storage sync iterates these). */
  names(): string[];
  /** Register an RPC method, callable from clients via remote.call(). */
  method(name: string, fn: (params: any, ws: any) => unknown | Promise<unknown>): void;
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
  /** When set, open/ops require ws.data.user (set by an auth method). */
  requireAuth?: boolean;
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
  // muted: this entry's ops came FROM storage (hydrate/receive), so its
  // persist must not re-run. PER ENTRY — a synchronous cascade that writes a
  // DIFFERENT doc during the apply still persists that doc normally.
  // subs: sockets currently subscribed (lifetime tax). dynamic: hosted by a
  // prefix factory, so it can be re-hosted — and is EVICTED when the last
  // subscriber leaves; statically registered docs live for the process.
  type Entry = { sig: Signal<any>; v: number; muted: boolean; subs: number; dynamic: boolean; persist?: DocOpts["persist"]; write?: DocOpts["write"]; open?: DocOpts["open"] };
  const docs = new Map<string, Entry>();
  const methods = new Map<string, (params: any, ws: any) => unknown | Promise<unknown>>();
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
    for (const [prefix, factory] of prefixes) {
      if (!name.startsWith(prefix)) continue;
      let pending = pendingFactories.get(name);
      if (!pending) {
        pending = Promise.resolve(factory(name, userId));
        pendingFactories.set(name, pending);
        pending.finally(() => pendingFactories.delete(name)).catch(() => {});
      }
      await pending;
      const made = docs.get(name);
      if (made) made.dynamic = true;   // re-hostable — evict when unwatched
      return made;
    }
    return undefined;
  }

  /** Drop a socket's subscription; evict a dynamic doc nobody watches —
   *  its factory re-hosts it (and recomposes) on the next open. */
  function unsubscribe(ws: any, name: string): void {
    if (!ws.data?.docs?.delete(name)) return;
    try { ws.unsubscribe(name); } catch { /* socket already gone */ }
    const entry = docs.get(name);
    if (entry && --entry.subs <= 0 && entry.dynamic) docs.delete(name);
    try { opts?.onUnsubscribe?.(name, ws); }
    catch (err) { console.error("[epsilon/doc] onUnsubscribe hook threw:", err); }
  }

  return {
    path,
    setServer(s: any) { server = s; },

    doc<T>(name: string, empty: T, docOpts?: DocOpts): Signal<T> {
      const existing = docs.get(name);
      if (existing) return existing.sig as Signal<T>;
      const sig = signal<T>(empty);
      const entry: Entry = { sig, v: 0, muted: false, subs: 0, dynamic: false, persist: docOpts?.persist, write: docOpts?.write, open: docOpts?.open };
      docs.set(name, entry);
      // Broadcast is just the doc's own ops channel piped to subscribers —
      // whether the write came from a client, server code, or storage
      // (hydrate/receive pre-set the version and mute THIS doc's persist).
      sig.onOps((ops) => {
        if (!ops) return;
        entry.v++;
        server?.publish(name, JSON.stringify({ doc: name, v: entry.v, ops } satisfies ServerMsg));
        if (!entry.muted) entry.persist?.(entry.v, ops, sig.peek());
      });
      return sig;
    },

    hydrate(name, v, data) {
      const entry = entryOf(name);
      entry.v = v - 1;              // the apply below bumps it back to v
      entry.muted = true;
      try { entry.sig.apply([{ op: "replace", path: "", value: data }]); }
      finally { entry.muted = false; }
    },

    receive(name, v, ops) {
      const entry = entryOf(name);
      if (v <= entry.v) return "stale";
      if (v > entry.v + 1) return "gap";
      entry.v = v - 1;
      entry.muted = true;
      try { entry.sig.apply(ops); }
      finally { entry.muted = false; }
      return "ok";
    },

    v(name) {
      return entryOf(name).v;
    },

    names() {
      return [...docs.keys()];
    },

    method(name, fn) {
      methods.set(name, fn);
    },

    docs(prefix, factory) {
      prefixes.set(prefix, factory);
    },

    fetch(req: Request, srv: any) {
      const url = new URL(req.url);
      if (url.pathname === path && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws: any) {
        ws.data ??= {};
        ws.data.docs = new Set<string>();   // this socket's subscriptions
      },
      close(ws: any) {
        for (const name of [...(ws.data?.docs ?? [])]) unsubscribe(ws, name);
      },
      async message(ws: any, raw: string | Buffer) {
        let msg: ClientMsg;
        try { msg = JSON.parse(String(raw)); } catch { return; }

        if (msg.action === "call") {
          const fn = methods.get(msg.method);
          if (!fn) {
            ws.send(JSON.stringify({ id: msg.id, error: `unknown method: ${msg.method}` } satisfies ServerMsg));
            return;
          }
          try {
            const result = await fn(msg.params, ws);
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
          ws.subscribe(msg.doc);
          // Count each socket once — a gap-triggered re-open isn't a new sub.
          const isNew = !ws.data.docs.has(msg.doc);
          if (isNew) {
            ws.data.docs.add(msg.doc);
            entry.subs++;
          }
          // The snapshot IS an op — same vocabulary, same client code path.
          ws.send(JSON.stringify({
            doc: msg.doc, v: entry.v,
            ops: [{ op: "replace", path: "", value: snapshot }],
          } satisfies ServerMsg));
          // After the send: ops the hook applies follow the snapshot in order.
          if (isNew) {
            try { opts?.onSubscribe?.(msg.doc, ws); }
            catch (err) { console.error("[epsilon/doc] onSubscribe hook threw:", err); }
          }
        } else if (msg.action === "ops") {
          try {
            if (entry.write) {
              // Storage is the authority (relational tier): it applies,
              // mints ids, and re-enters via host.receive().
              await entry.write(msg.ops, ws.data?.user?.id);
            } else {
              entry.sig.apply(mintIds(entry.sig.peek(), msg.ops));
            }
          } catch (err) {
            ws.send(JSON.stringify({ doc: msg.doc, error: String(err) } satisfies ServerMsg));
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
    onError?: (doc: string, error: string) => void;
    /** Awaited on EVERY socket open — first connect and each reconnect —
     *  after queued calls flush and BEFORE docs (re)open. Authenticate here
     *  and a requireAuth host serves the re-opens that follow. */
    onConnect?: (remote: Remote) => void | Promise<void>;
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
      // Queued calls first, then the connect hook — authenticate there and a
      // requireAuth host serves the re-opens — then (re)open every doc; the
      // snapshot-as-op resets each baseline.
      for (const msg of queued.splice(0)) ws.send(JSON.stringify(msg));
      try {
        await opts?.onConnect?.(remote);
      } catch (err) {
        // Opens proceed regardless — refusals surface through onError.
        console.error("[epsilon/doc] onConnect hook failed:", err);
      }
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
        docs.get(msg.doc)?.refuse(msg.error);
        opts?.onError?.(msg.doc, msg.error);
        return;
      }
      const doc = docs.get(msg.doc);
      if (!doc) return;
      if (doc.receive(msg.v, msg.ops) === "gap") send({ action: "open", doc: msg.doc });
    };
    ws.onclose = () => {
      // Fail fast rather than hang — a retried call after reconnect is the
      // caller's decision (it may not be idempotent, e.g. register).
      for (const [, p] of pending) p.reject(new Error("disconnected"));
      pending.clear();
      if (closed) return;
      setTimeout(wire, (backoff = Math.min(backoff * 2, 10_000)));
    };
  }
  wire();

  return remote;
}
