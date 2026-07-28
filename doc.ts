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
import type { Op } from "./op";

type ClientMsg =
  | { action: "open"; doc: string }
  | { action: "ops"; doc: string; ops: Op[] };

type ServerMsg =
  | { doc: string; v: number; ops: Op[] }
  | { doc: string; error: string };

// ---------------------------------------------------------------------------
// Server — createHost()
// ---------------------------------------------------------------------------

export interface Host {
  /** Register (or fetch) a hosted doc. The returned Signal is the authority —
   *  server code applies ops to it directly and they broadcast. */
  doc<T>(name: string, empty: T): Signal<T>;
  fetch(req: Request, server: any): Response | undefined;
  websocket: {
    message(ws: any, raw: string | Buffer): void;
    open(ws: any): void;
    close(ws: any): void;
  };
  setServer(s: any): void;
  path: string;
}

export function createHost(opts?: { path?: string }): Host {
  const path = opts?.path ?? "/ws";
  const docs = new Map<string, { sig: Signal<any>; v: number }>();
  let server: any = null;

  return {
    path,
    setServer(s: any) { server = s; },

    doc<T>(name: string, empty: T): Signal<T> {
      const existing = docs.get(name);
      if (existing) return existing.sig as Signal<T>;
      const sig = signal<T>(empty);
      const entry = { sig, v: 0 };
      docs.set(name, entry);
      // Broadcast is just the doc's own ops channel piped to subscribers —
      // whether the write came from a client or from server code.
      sig.onOps((ops) => {
        if (!ops) return;
        entry.v++;
        server?.publish(name, JSON.stringify({ doc: name, v: entry.v, ops } satisfies ServerMsg));
      });
      return sig;
    },

    fetch(req: Request, srv: any) {
      const url = new URL(req.url);
      if (url.pathname === path && srv.upgrade(req)) return undefined;
      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(_ws: any) {},
      close(_ws: any) {},
      message(ws: any, raw: string | Buffer) {
        let msg: ClientMsg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        const entry = docs.get(msg.doc);
        if (!entry) {
          ws.send(JSON.stringify({ doc: msg.doc, error: `unknown doc: ${msg.doc}` } satisfies ServerMsg));
          return;
        }
        if (msg.action === "open") {
          ws.subscribe(msg.doc);
          // The snapshot IS an op — same vocabulary, same client code path.
          ws.send(JSON.stringify({
            doc: msg.doc, v: entry.v,
            ops: [{ op: "replace", path: "", value: entry.sig.peek() }],
          } satisfies ServerMsg));
        } else if (msg.action === "ops") {
          try {
            entry.sig.apply(msg.ops); // authority applies; onOps above broadcasts
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
  ready: Promise<void>;
  private resolveReady!: () => void;
  /** Last server version applied; 0 = no snapshot yet. */
  v = 0;

  constructor(private send: (ops: Op[]) => void) {
    super(null);
    this.ready = new Promise((r) => { this.resolveReady = r; });
  }

  /** Location transparency: writes go to the authority, never local. */
  override apply(ops: Op[]): void {
    this.send(ops);
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
    this.resolveReady();
    return "ok";
  }
}

export interface Remote {
  doc<T>(name: string): OpSignal<T | null> & { ready: Promise<void> };
  close(): void;
}

export function connect(
  url: string,
  opts?: { onError?: (doc: string, error: string) => void },
): Remote {
  const docs = new Map<string, RemoteDoc<any>>();
  let ws: WebSocket;
  let closed = false;
  let backoff = 100;

  const send = (msg: ClientMsg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  function wire() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 100;
      // (Re)open every doc — the snapshot-as-op resets each baseline.
      for (const name of docs.keys()) send({ action: "open", doc: name });
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      if ("error" in msg) {
        opts?.onError?.(msg.doc, msg.error);
        return;
      }
      const doc = docs.get(msg.doc);
      if (!doc) return;
      if (doc.receive(msg.v, msg.ops) === "gap") send({ action: "open", doc: msg.doc });
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(wire, (backoff = Math.min(backoff * 2, 10_000)));
    };
  }
  wire();

  return {
    doc<T>(name: string) {
      let doc = docs.get(name) as RemoteDoc<T> | undefined;
      if (!doc) {
        doc = new RemoteDoc<T>((ops) => send({ action: "ops", doc: name, ops }));
        docs.set(name, doc);
        send({ action: "open", doc: name }); // no-op if not connected yet
      }
      return doc;
    },
    close() {
      closed = true;
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}
