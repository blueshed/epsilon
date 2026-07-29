// The wire's contract: one vocabulary, one write path, echo renders the write.
// Real Bun.serve, real WebSockets, same TypeScript on both sides.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHost, connect, type Remote } from "./doc";
import type { Signal } from "./signal";
import type { Op } from "./op";

interface Card { id: number; title: string; done: boolean }
interface Board { cards: Record<string, Card> }

const empty: Board = { cards: { "1": { id: 1, title: "one", done: false } } };

let host: ReturnType<typeof createHost>;
let server: ReturnType<typeof Bun.serve>;
let hosted: Signal<Board>;
let url: string;
const remotes: Remote[] = [];

function client(onError?: (doc: string, error: string) => void): Remote {
  const r = connect(url, { onError });
  remotes.push(r);
  return r;
}

const until = async (cond: () => boolean, ms = 1000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

beforeAll(() => {
  host = createHost();
  hosted = host.doc<Board>("board", structuredClone(empty));
  server = Bun.serve({
    port: 0,
    fetch: host.fetch,
    websocket: host.websocket,
  });
  host.setServer(server);
  url = `ws://localhost:${server.port}${host.path}`;
});

afterAll(() => {
  for (const r of remotes) r.close();
  server.stop(true);
});

describe("the wire", () => {
  test("open: the snapshot arrives as a root-replace op and ready resolves", async () => {
    const board = client().doc<Board>("board");
    expect(board.peek()).toBeNull();
    await board.ready;
    expect(board.peek()!.cards["1"]!.title).toBe("one");
  });

  test("location transparency: a lens write goes wire → authority → echo", async () => {
    const board = client().doc<Board>("board");
    await board.ready;
    const localRef = board.peek();

    board.at("/cards/1/done").set(true);              // client writes via lens
    await until(() => hosted.peek().cards["1"]!.done === true);   // server applied
    await until(() => board.peek()!.cards["1"]!.done === true);   // echo applied

    expect(board.peek()).toBe(localRef);              // in place — ref stable
  });

  test("fan-out: another client receives the EXACT op, not a recompute", async () => {
    const a = client().doc<Board>("board");
    const b = client().doc<Board>("board");
    await Promise.all([a.ready, b.ready]);

    const seen: Op[] = [];
    b.onOps((ops) => { ops?.forEach((o) => seen.push(o)); });

    a.apply([{ op: "add", path: "/cards/2", value: { id: 2, title: "two", done: false } }]);
    await until(() => b.peek()!.cards["2"] !== undefined);

    const op = seen.find((o) => o.path === "/cards/2");
    expect(op?.op).toBe("add");
  });

  test("server-side writes broadcast the same way — one write path", async () => {
    const board = client().doc<Board>("board");
    await board.ready;
    hosted.at("/cards/1/title").set("from-server");
    await until(() => board.peek()!.cards["1"]!.title === "from-server");
  });

  test("unknown doc reports through onError", async () => {
    const errors: string[] = [];
    const nope = client((_doc, err) => errors.push(err)).doc("nope");
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("unknown doc");
    expect(nope.peek()).toBeNull();
  });

  test("a refused open REJECTS ready; a later successful open re-arms it", async () => {
    const r = client();
    const late = r.doc<Board>("late");
    let err: Error | undefined;
    try { await late.ready; } catch (e) { err = e as Error; }
    expect(err?.message).toContain("unknown doc");

    host.doc("late", { cards: {} } satisfies Board);   // now it exists
    const again = r.doc<Board>("late");                // same handle, re-asks
    expect(again).toBe(late);
    await again.ready;                                 // fresh promise — resolves
    expect(again.peek()).toEqual({ cards: {} });
  });

  test("a bad op is rejected by the authority and pollutes nothing", async () => {
    const errors: string[] = [];
    const board = client((_doc, err) => errors.push(err)).doc<Board>("board");
    await board.ready;
    board.apply([{ op: "add", path: "/__proto__/hacked", value: true }]);
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("forbidden");
    expect(({} as any).hacked).toBeUndefined();
  });
});

describe("decision 1: the server mints ids", () => {
  test("add to /cards/- echoes a server uuid; both clients converge on it", async () => {
    const a = client().doc<Board>("board");
    const b = client().doc<Board>("board");
    await Promise.all([a.ready, b.ready]);

    a.apply([{ op: "add", path: "/cards/-", value: { title: "minted", done: false } } as any]);
    await until(() => Object.keys(b.peek()!.cards).some((k) => b.peek()!.cards[k]!.title === "minted"));

    const id = Object.keys(a.peek()!.cards).find((k) => a.peek()!.cards[k]!.title === "minted")!;
    expect(id).not.toBe("-");
    expect(id.length).toBe(36);                          // uuid — not client-invented
    expect(b.peek()!.cards[id]!.title).toBe("minted");   // same id everywhere
  });
});

describe("reconnect — onConnect re-authenticates before docs re-open", () => {
  test("a dropped socket recovers its auth and its docs on its own", async () => {
    const h = createHost({ requireAuth: true });
    h.doc<Board>("secret", structuredClone(empty));
    let becomes = 0;
    h.method("become", (_p, ws) => { ws.data ??= {}; ws.data.user = { id: 7 }; becomes++; return { id: 7 }; });
    h.method("kick", (_p, ws) => { ws.close(); });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    const r = connect(`ws://localhost:${srv.port}${h.path}`, {
      onConnect: async (remote) => { await remote.call("become"); },
    });
    remotes.push(r);

    const doc = r.doc<Board>("secret");
    await doc.ready;                          // the hook authed the first connect
    expect(doc.peek()!.cards["1"]!.title).toBe("one");

    r.call("kick").catch(() => {});           // server drops the socket
    await until(() => becomes >= 2, 3000);    // hook ran again on the NEW socket
    doc.at("/cards/1/done").set(true);        // write through the new socket
    await until(() => doc.peek()!.cards["1"]!.done === true, 3000);
    srv.stop(true);
  });

  test("writes made while the socket is DOWN queue and flush, not drop", async () => {
    const h = createHost({ requireAuth: true });
    const authority = h.doc<Board>("secret", structuredClone(empty));
    h.method("become", (_p, ws) => { ws.data ??= {}; ws.data.user = { id: 7 }; return { id: 7 }; });
    h.method("hang", () => new Promise(() => {}));   // pending until the drop
    h.method("kick", (_p, ws) => { ws.close(); });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    const r = connect(`ws://localhost:${srv.port}${h.path}`, {
      onConnect: async (remote) => { await remote.call("become"); },
    });
    remotes.push(r);
    const doc = r.doc<Board>("secret");
    await doc.ready;

    const dropped = r.call("hang").catch(() => {});  // rejects when onclose fires
    r.call("kick").catch(() => {});
    await dropped;                                   // socket is definitely down
    doc.at("/cards/1/title").set("offline write");   // queued, not lost
    await until(() => doc.peek()!.cards["1"]!.title === "offline write", 3000);
    expect(authority.peek().cards["1"]!.title).toBe("offline write");
    srv.stop(true);
  });
});

describe("dynamic docs — the factory sees the asking identity", () => {
  test("a probe is refused BEFORE anything is hosted; the owner still opens", async () => {
    const h = createHost({ requireAuth: true });
    h.method("become", (p: { id: number }, ws) => { ws.data ??= {}; ws.data.user = { id: p.id }; return ws.data.user; });
    let built = 0;
    h.docs("mine:", (name, userId) => {
      if (name !== `mine:${userId}`) throw new Error(`unknown doc: ${name}`);
      built++;
      h.doc(name, { cards: {} } satisfies Board);
    });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);
    const wsUrl = `ws://localhost:${srv.port}${h.path}`;

    const errors: string[] = [];
    const stranger = connect(wsUrl, {
      onConnect: async (remote) => { await remote.call("become", { id: 9 }); },
      onError: (_d, e) => errors.push(e),
    });
    remotes.push(stranger);
    stranger.doc("mine:7");
    await until(() => errors.length > 0, 3000);
    expect(errors[0]).toContain("unknown doc");
    expect(built).toBe(0);                    // the probe hosted NOTHING

    const owner = connect(wsUrl, {
      onConnect: async (remote) => { await remote.call("become", { id: 7 }); },
    });
    remotes.push(owner);
    const mine = owner.doc<Board>("mine:7");
    await mine.ready;
    expect(built).toBe(1);
    srv.stop(true);
  });
});

describe("persistence muting is per-doc", () => {
  test("a cascade writing doc B during doc A's receive still persists B", () => {
    const h = createHost();
    const persisted: string[] = [];
    const a = h.doc<{ n: number }>("a", { n: 0 }, { persist: () => { persisted.push("a"); } });
    h.doc<{ n: number }>("b", { n: 0 }, { persist: () => { persisted.push("b"); } });
    const b = h.doc<{ n: number }>("b", { n: 0 });   // same entry back
    // A server-side cascade: whenever A changes, derive into B.
    a.onOps((ops) => { if (ops) b.apply([{ op: "replace", path: "/n", value: 1 }]); });

    // A's ops came FROM storage — A must not re-persist; B's write is new.
    expect(h.receive("a", 1, [{ op: "replace", path: "/n", value: 1 }])).toBe("ok");
    expect(persisted).toEqual(["b"]);
  });
});

describe("dynamic docs — names are data, hosted on first open", () => {
  test("a prefix factory hosts room:<x> on demand; unknown prefixes still 404", async () => {
    let built = 0;
    host.docs("room:", (name) => {
      built++;
      host.doc(name, { cards: {} } satisfies Board);
    });

    const a = client().doc<Board>("room:alpha");
    const b = client().doc<Board>("room:alpha");
    await Promise.all([a.ready, b.ready]);
    expect(built).toBe(1);                       // concurrent opens coalesce

    a.apply([{ op: "add", path: "/cards/-", value: { title: "in a room", done: false } } as any]);
    await until(() => Object.values(b.peek()!.cards).some((c: any) => c.title === "in a room"));

    const errors: string[] = [];
    const r = client((_d, e) => errors.push(e));
    r.doc("nowhere:1");
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("unknown doc");
  });
});
