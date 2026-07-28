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
   * subscribed). Docs without it serve the hosted signal to any socket the
   * host admits.
   */
  open?: (userId?: number | string) => unknown;
}

/**
 * Decision 1 — the server mints ids, every tier. An `add` ending in `/-`
 * against a RECORD collection gets a server uuid (arrays keep native append
 * semantics). Storage-backed docs mint in storage instead (their write hook
 * sees the raw `-`; Postgres sequences assign).
 */
export function mintIds(doc: unknown, ops: Op[]): Op[] {
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
   */
  docs(prefix: string, factory: (name: string) => unknown | Promise<unknown>): void;
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
}): Host {
  const path = opts?.path ?? "/ws";
  type Entry = { sig: Signal<any>; v: number; persist?: DocOpts["persist"]; write?: DocOpts["write"]; open?: DocOpts["open"] };
  const docs = new Map<string, Entry>();
  const methods = new Map<string, (params: any, ws: any) => unknown | Promise<unknown>>();
  const prefixes = new Map<string, (name: string) => unknown | Promise<unknown>>();
  const pendingFactories = new Map<string, Promise<unknown>>();
  let server: any = null;
  let skipPersist = false;

  function entryOf(name: string) {
    const entry = docs.get(name);
    if (!entry) throw new Error(`[epsilon/doc] unknown doc: ${name}`);
    return entry;
  }

  /** Registered entry, or run the matching prefix factory (coalesced). */
  async function resolveEntry(name: string): Promise<Entry | undefined> {
    const existing = docs.get(name);
    if (existing) return existing;
    for (const [prefix, factory] of prefixes) {
      if (!name.startsWith(prefix)) continue;
      let pending = pendingFactories.get(name);
      if (!pending) {
        pending = Promise.resolve(factory(name));
        pendingFactories.set(name, pending);
        pending.finally(() => pendingFactories.delete(name)).catch(() => {});
      }
      await pending;
      return docs.get(name);
    }
    return undefined;
  }

  return {
    path,
    setServer(s: any) { server = s; },

    doc<T>(name: string, empty: T, docOpts?: DocOpts): Signal<T> {
      const existing = docs.get(name);
      if (existing) return existing.sig as Signal<T>;
      const sig = signal<T>(empty);
      const entry: Entry = { sig, v: 0, persist: docOpts?.persist, write: docOpts?.write, open: docOpts?.open };
      docs.set(name, entry);
      // Broadcast is just the doc's own ops channel piped to subscribers —
      // whether the write came from a client, server code, or storage
      // (hydrate/receive pre-set the version and mute persistence).
      sig.onOps((ops) => {
        if (!ops) return;
        entry.v++;
        server?.publish(name, JSON.stringify({ doc: name, v: entry.v, ops } satisfies ServerMsg));
        if (!skipPersist) entry.persist?.(entry.v, ops, sig.peek());
      });
      return sig;
    },

    hydrate(name, v, data) {
      const entry = entryOf(name);
      entry.v = v - 1;              // the apply below bumps it back to v
      skipPersist = true;
      try { entry.sig.apply([{ op: "replace", path: "", value: data }]); }
      finally { skipPersist = false; }
    },

    receive(name, v, ops) {
      const entry = entryOf(name);
      if (v <= entry.v) return "stale";
      if (v > entry.v + 1) return "gap";
      entry.v = v - 1;
      skipPersist = true;
      try { entry.sig.apply(ops); }
      finally { skipPersist = false; }
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
      open(_ws: any) {},
      close(_ws: any) {},
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

        // Doc traffic — gated when the host requires auth (an auth method
        // sets ws.data.user; docs stay closed until it has).
        if (opts?.requireAuth && ws.data?.user == null) {
          ws.send(JSON.stringify({ doc: msg.doc, error: "unauthenticated" } satisfies ServerMsg));
          return;
        }
        let entry: Entry | undefined;
        try {
          entry = await resolveEntry(msg.doc);
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
          const snapshot = entry.open ? entry.open(ws.data?.user?.id) : entry.sig.peek();
          if (entry.open && snapshot == null) {
            ws.send(JSON.stringify({ doc: msg.doc, error: `unknown doc: ${msg.doc}` } satisfies ServerMsg));
            return;
          }
          ws.subscribe(msg.doc);
          // The snapshot IS an op — same vocabulary, same client code path.
          ws.send(JSON.stringify({
            doc: msg.doc, v: entry.v,
            ops: [{ op: "replace", path: "", value: snapshot }],
          } satisfies ServerMsg));
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

  constructor(private send: (ops: Op[]) => void) {
    super(null);
    this.arm();
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

export interface Remote {
  doc<T>(name: string): OpSignal<T | null> & { ready: Promise<void> };
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
  const queued: ClientMsg[] = [];   // calls made before the socket opened
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
        doc = new RemoteDoc<T>((ops) => send({ action: "ops", doc: name, ops }));
        docs.set(name, doc);
        send({ action: "open", doc: name }); // no-op if not connected yet
      } else if (doc.v === 0) {
        // Asked again before any snapshot landed — the first open may have
        // been refused (e.g. pre-auth on a requireAuth host). Ask again.
        doc.reopen();
        send({ action: "open", doc: name });
      }
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
