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

const until = async (cond: () => boolean | Promise<boolean>, ms = 1000) => {
  const start = Date.now();
  while (!(await cond())) {
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

describe("write() — the answered write (0.8.1)", () => {
  test("resolves with the RESOLVED ops, so the minted id comes home", async () => {
    const a = client().doc<Board>("board");
    await a.ready;

    const resolved = await a.write([
      { op: "add", path: "/cards/-", value: { title: "answered", done: false } } as any,
    ]);

    // No guessing, no matching by value: the id is IN the returned path.
    expect(resolved.length).toBe(1);
    const id = resolved[0]!.path.split("/").pop()!;
    expect(id).not.toBe("-");
    expect(id.length).toBe(36);
    await until(() => a.peek()!.cards[id]?.title === "answered");
  });

  test("two writers racing on the same value each get their OWN id", async () => {
    // The exact case value-matching gets wrong: same title, same instant.
    const a = client().doc<Board>("board");
    const b = client().doc<Board>("board");
    await Promise.all([a.ready, b.ready]);

    const [ra, rb] = await Promise.all([
      a.write([{ op: "add", path: "/cards/-", value: { title: "Kyoto", done: false } } as any]),
      b.write([{ op: "add", path: "/cards/-", value: { title: "Kyoto", done: false } } as any]),
    ]);
    const ida = ra[0]!.path.split("/").pop()!;
    const idb = rb[0]!.path.split("/").pop()!;
    expect(ida).not.toBe(idb);
    await until(() => !!a.peek()!.cards[ida] && !!a.peek()!.cards[idb]);
  });

  test("REJECTS when the authority refuses, and tells the writer only", async () => {
    const errors: string[] = [];
    const a = client((_d, e) => errors.push(e)).doc<Board>("board");
    await a.ready;

    let err: Error | undefined;
    try {
      await a.write([{ op: "add", path: "/__proto__/hacked", value: true }]);
    } catch (e) { err = e as Error; }

    expect(err?.message).toContain("forbidden");
    expect(({} as any).hacked).toBeUndefined();
    // The refusal came back on the write's own id — it did NOT also spray
    // the doc-scoped onError channel, which is for opens.
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).toEqual([]);
  });

  test("write() through a closed handle throws, like apply()", async () => {
    const a = client().doc<Board>("board");
    await a.ready;
    a.close();
    expect(() => a.write([{ op: "replace", path: "/cards/1/done", value: true }])).toThrow("closed");
  });
});

describe("a refused WRITE is distinguishable from a refused OPEN (0.8.1)", () => {
  test("the error frame carries write:true; consumers stop regexing prose", async () => {
    const seen: { doc: string; error: string; write?: boolean }[] = [];
    const r = connect(url, {
      onError(doc, error, meta) { seen.push({ doc, error, write: meta?.write }); },
    });
    remotes.push(r);

    // A refused OPEN — no write flag.
    r.doc("does-not-exist");
    await until(() => seen.length > 0);
    expect(seen[0]!.error).toContain("unknown doc");
    expect(seen[0]!.write).toBeUndefined();

    // A refused WRITE through the fire-and-forget path — flagged.
    const board = r.doc<Board>("board");
    await board.ready;
    board.apply([{ op: "add", path: "/__proto__/nope", value: 1 }]);
    await until(() => seen.length > 1);
    expect(seen[1]!.error).toContain("forbidden");
    expect(seen[1]!.write).toBe(true);
  });
});

describe("reconnect — onConnect re-authenticates before docs re-open", () => {
  test("a dropped socket recovers its auth and its docs on its own", async () => {
    const h = createHost({ requireAuth: true });
    h.doc<Board>("secret", structuredClone(empty));
    let becomes = 0;
    h.method("become", (_p, ws) => { ws.data ??= {}; ws.data.user = { id: 7 }; becomes++; return { id: 7 }; }, { open: true });
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
    h.method("become", (_p, ws) => { ws.data ??= {}; ws.data.user = { id: 7 }; return { id: 7 }; }, { open: true });
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

  test("a write REJECTED by the drop does not also execute on reconnect", async () => {
    // The double-execute: onclose rejected every pending promise but left the
    // message in the queue, so a later successful open flushed it and the
    // server ran it — while the caller had been told "disconnected". A caller
    // who then does the documented thing (decide whether to retry) applies it
    // twice. The rejection is a promise; the queue has to agree with it.
    //
    // It needs a FAILED dial after the write is queued, which is why it takes
    // a server that goes away and comes back on the same port.
    const mkHost = () => {
      const h = createHost();
      const sig = h.doc<Board>("twice", structuredClone(empty), {
        write: (ops) => { applied++; sig.apply(ops); return ops; },
      });
      return h;
    };
    let applied = 0;

    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);

    let h = mkHost();
    let srv = Bun.serve({
      port, fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    let drops = 0;
    const r = connect(`ws://localhost:${port}${h.path}`, { onDisconnect: () => { drops++; } });
    remotes.push(r);
    const doc = r.doc<Board>("twice");
    await doc.ready;

    srv.stop(true);                                   // server gone: dials will fail
    await until(() => drops >= 1, 3000);              // the client has SEEN the close,
                                                      // so the next write QUEUES rather
                                                      // than vanishing into a live socket
    let err: Error | undefined;
    const w = doc.write([{ op: "add", path: "/cards/9", value: { id: 9, title: "ghost", done: false } }])
      .catch((e) => { err = e as Error; });
    await until(() => drops >= 2, 5000);              // a failed dial: this is what rejects it
    await w;
    expect(err?.message).toContain("disconnected");

    // Bring the server back and let the client reconnect. The rejected write
    // must NOT be among what flushes.
    h = mkHost();
    srv = Bun.serve({
      port, fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    // A write that SUCCEEDS proves the client really reconnected — otherwise
    // "the ghost never landed" would pass for the wrong reason.
    await until(async () => {
      try { await doc.write([{ op: "replace", path: "/cards/1/title", value: "back" }]); return true; }
      catch { return false; }
    }, 12_000);
    await new Promise((res) => setTimeout(res, 200));   // room for a stray flush

    expect(applied).toBe(1);                            // the live write, and only it
    expect(doc.peek()!.cards["9"]).toBeUndefined();     // the rejected one never ran
    srv.stop(true);
  }, 20_000);

  test("a call queued before the dial lands AFTER the hook, not ahead of it", async () => {
    // The one-shot shape: every call a CLI command makes is issued in the
    // same tick as connect(), while the socket is still dialling. Queued
    // calls used to flush BEFORE the connect hook, so the command ran on a
    // socket that had not authenticated yet — a valid session, refused.
    const h = createHost({ requireAuth: true });
    h.method("become", (_p, ws) => { ws.data ??= {}; ws.data.user = { id: 7 }; return { id: 7 }; }, { open: true });
    h.method("whoami", (_p, ws) => ({ id: ws.data?.user?.id ?? null }));
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

    const who = await r.call<{ id: number | null }>("whoami");
    expect(who.id).toBe(7);
    srv.stop(true);
  });

  test("onDisconnect hears every close — willRetry false only for close()", async () => {
    const h = createHost();
    h.doc<Board>("public", structuredClone(empty));
    h.method("kick", (_p, ws) => { ws.close(); });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    let connects = 0;
    const seen: boolean[] = [];
    const r = connect(`ws://localhost:${srv.port}${h.path}`, {
      onConnect: () => { connects++; },
      onDisconnect: (willRetry) => { seen.push(willRetry); },
    });
    remotes.push(r);
    await r.doc<Board>("public").ready;

    r.call("kick").catch(() => {});                            // the socket dies under us
    await until(() => seen.length >= 1 && connects >= 2, 3000); // dropped, then back
    expect(seen[0]).toBe(true);                                // a retry is coming

    r.close();
    await until(() => seen.length >= 2, 3000);
    expect(seen[1]).toBe(false);                               // deliberate — nothing follows
    srv.stop(true);
  });
});

describe("versions — the time tax: replay ignored, gap resyncs", () => {
  test("host.receive classifies stale, contiguous, and gapped", () => {
    const h = createHost();
    h.doc<Board>("v", structuredClone(empty));
    expect(h.v("v")).toBe(0);

    expect(h.receive("v", 1, [{ op: "add", path: "/cards/2", value: { id: 2, title: "two", done: false } }])).toBe("ok");
    expect(h.v("v")).toBe(1);

    // The same commit arriving twice (two delivery paths, one write) must be
    // a no-op, not a double-apply.
    expect(h.receive("v", 1, [{ op: "remove", path: "/cards/1" }])).toBe("stale");
    expect(h.v("v")).toBe(1);

    // A hole: something was missed, so the ops in hand cannot be trusted to
    // land on the right base. The caller reloads instead of guessing.
    expect(h.receive("v", 3, [{ op: "remove", path: "/cards/1" }])).toBe("gap");
    expect(h.v("v")).toBe(1);                       // unchanged — nothing applied
  });

  test("a client that misses a version RE-OPENS itself and converges", async () => {
    // The client half of the same law, over a real socket: when the server's
    // v jumps, the client must not apply the ops onto a base it doesn't have
    // — it re-opens and takes a fresh snapshot. This is the recovery path
    // every reconnect and every dropped broadcast depends on.
    const h = createHost();
    const authority = h.doc<Board>("gap", structuredClone(empty));
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    const r = connect(`ws://localhost:${srv.port}${h.path}`);
    remotes.push(r);
    const doc = r.doc<Board>("gap");
    await doc.ready;

    // A real dropped frame, not a simulated one: apply to the authority while
    // this socket is NOT subscribed, so the broadcast genuinely passes it by.
    // Then re-subscribe and let the next broadcast arrive out of sequence.
    doc.close();                                       // unsubscribed on the host
    await new Promise((res) => setTimeout(res, 50));
    authority.apply([{ op: "add", path: "/cards/7", value: { id: 7, title: "unheard", done: false } }]);

    const again = r.doc<Board>("gap");                 // re-open: fresh snapshot
    await again.ready;
    expect(again.peek()!.cards["7"]!.title).toBe("unheard");   // caught up by snapshot
    expect(again.v).toBe(h.v("gap"));

    // And live ops resume contiguously from that new baseline.
    authority.apply([{ op: "add", path: "/cards/8", value: { id: 8, title: "heard", done: false } }]);
    await until(() => !!again.peek()!.cards["8"], 3000);
    expect(again.v).toBe(h.v("gap"));
    srv.stop(true);
  });
});

describe("call is gated too — a method is not a side door (0.10.1)", () => {
  // Until 0.10.1 the call branch returned BEFORE the requireAuth check, so
  // every registered method was reachable without a session. On the Postgres
  // tier that made `history` a world-readable dump of any private doc's op
  // log (a NULL user reads as "the host asking as itself" inside the SQL
  // permit) and `undo` an anonymous write. The gate is the same one doc
  // traffic gets; only session-MINTING methods opt out.
  test("an unauthenticated call is refused unless the method is a door", async () => {
    const h = createHost({ requireAuth: true });
    let ran = 0;
    h.method("readSecrets", () => { ran++; return { secret: "leaked" }; });
    h.method("become", (_p, ws) => { ws.data ??= {}; ws.data.user = { id: 7 }; return { id: 7 }; }, { open: true });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    const r = connect(`ws://localhost:${srv.port}${h.path}`);
    remotes.push(r);

    await expect(r.call("readSecrets")).rejects.toThrow("unauthenticated");
    expect(ran).toBe(0);                       // refused BEFORE the body ran

    await r.call("become");                    // the door is reachable from outside
    expect(await r.call<{ secret: string }>("readSecrets")).toEqual({ secret: "leaked" });
    expect(ran).toBe(1);
    srv.stop(true);
  });

  test("an ungated host still calls freely — the gate is requireAuth's", async () => {
    const h = createHost();                    // no requireAuth
    h.method("ping", () => "pong");
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);
    const r = connect(`ws://localhost:${srv.port}${h.path}`);
    remotes.push(r);
    expect(await r.call<string>("ping")).toBe("pong");
    srv.stop(true);
  });
});

describe("dynamic docs — the factory sees the asking identity", () => {
  test("a probe is refused BEFORE anything is hosted; the owner still opens", async () => {
    const h = createHost({ requireAuth: true });
    h.method("become", (p: { id: number }, ws) => { ws.data ??= {}; ws.data.user = { id: p.id }; return ws.data.user; }, { open: true });
    let built = 0;
    h.docs("mine:", (name, userId) => {
      if (name !== `mine:${userId}`) throw new Error(`unknown doc: ${name}`);
      built++;
      // The permit the factory checks is ALSO the open gate — an in-memory
      // doc has no doc_open to default to, and a requireAuth host refuses a
      // gateless dynamic doc outright (the rule, enforced below).
      let sig!: Signal<Board>;
      sig = h.doc(name, { cards: {} } satisfies Board, {
        open: (u) => (name === `mine:${u}` ? sig.peek() : null),
      });
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

  test("a gateless dynamic doc on a requireAuth host is refused AT HOSTING TIME", async () => {
    // The factory's refusal guards only the first open — the doc outlives
    // its opener. Relational docs recover through pgDoc's default gate; an
    // in-memory doc has no default, so before 0.10.2 this shape failed OPEN
    // for as long as anyone watched it. Now it fails loudly, un-hosted.
    const h = createHost({ requireAuth: true });
    h.method("become", (p: { id: number }, ws) => { ws.data ??= {}; ws.data.user = { id: p.id }; return ws.data.user; }, { open: true });
    h.docs("naive:", (name, userId) => {
      if (name !== `naive:${userId}`) throw new Error(`unknown doc: ${name}`);
      h.doc(name, { cards: {} } satisfies Board);   // forgot the gate
    });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);

    const errors: string[] = [];
    const r = connect(`ws://localhost:${srv.port}${h.path}`, {
      onConnect: async (remote) => { await remote.call("become", { id: 7 }); },
      onError: (_d, e) => errors.push(e),
    });
    remotes.push(r);
    r.doc("naive:7");                          // the OWNER — the gate is still required
    await until(() => errors.length > 0, 3000);
    expect(errors[0]).toContain("needs an open gate");
    expect(h.names()).not.toContain("naive:7");   // un-hosted — nothing serving `empty`

    srv.stop(true);
  });
});

describe("presence — subscribe hooks drive an ephemeral doc (server.ts's pattern)", () => {
  test("watchers appear on open, vanish on socket death, and the doc dies with its last watcher", async () => {
    type Here = Record<string, { name: string }>;
    let sid = 0;
    let h!: ReturnType<typeof createHost>;
    const presenceOf = (name: string) =>
      h.names().includes(name) ? h.doc<Here>(name, {}) : null;
    h = createHost({
      onSubscribe(doc, ws) {
        if (!doc.startsWith("presence:")) return;
        ws.data.sid ??= ++sid;
        presenceOf(doc)?.apply([{ op: "add", path: `/${ws.data.sid}`, value: { name: ws.data.user?.name ?? "guest" } }]);
      },
      onUnsubscribe(doc, ws) {
        if (!doc.startsWith("presence:") || !ws.data?.sid) return;
        presenceOf(doc)?.apply([{ op: "remove", path: `/${ws.data.sid}` }]);
      },
    });
    h.docs("presence:", (name) => { h.doc(name, {}); });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);
    const wsUrl = `ws://localhost:${srv.port}${h.path}`;

    const a = connect(wsUrl);
    const b = connect(wsUrl);
    remotes.push(a);
    const pa = a.doc<Here>("presence:room");
    const pb = b.doc<Here>("presence:room");
    await Promise.all([pa.ready, pb.ready]);
    // Both see both — including themselves, added AFTER their snapshot.
    await until(() => Object.keys(pa.peek() ?? {}).length === 2);
    await until(() => Object.keys(pb.peek() ?? {}).length === 2);

    b.close();                     // socket death removes b's entry
    await until(() => Object.keys(pa.peek() ?? {}).length === 1);

    pa.close();                    // last watcher — the doc evicts entirely
    await until(() => !h.names().includes("presence:room"));
    srv.stop(true);
  });
});

// (The "persistence muting is per-doc" case lived here until 0.10.0. It
// tested DocOpts.persist and the host's `muted` flag, which existed only for
// the doc-native JSONB tier — both are gone with it. A cascade that writes a
// different doc during a receive is still exercised for real by the rename
// mirror in rel.test.ts.)

describe("lifetime — close() releases docs; unwatched dynamic docs evict", () => {
  test("refcount: two handles, one socket — only the last close releases", async () => {
    let built = 0;
    host.docs("gc:", (name) => {
      built++;
      host.doc(name, { cards: {} } satisfies Board);
    });

    const r = client();
    const a = r.doc<Board>("gc:1");
    const b = r.doc<Board>("gc:1");
    expect(b).toBe(a);                    // same handle, refcounted
    await a.ready;
    expect(host.names()).toContain("gc:1");

    a.close();                            // one handle still live — doc stays
    b.apply([{ op: "add", path: "/cards/9", value: { id: 9, title: "still here", done: false } }]);
    await until(() => b.peek()!.cards["9"] !== undefined);

    b.close();                            // last handle — server evicts
    await until(() => !host.names().includes("gc:1"));
    expect(built).toBe(1);

    const again = client().doc<Board>("gc:1");
    await again.ready;                    // factory re-hosts on the next open
    expect(built).toBe(2);
  });

  test("a doc stays hosted while ANY socket watches it", async () => {
    const x = client().doc<Board>("gc:2");
    const y = client().doc<Board>("gc:2");
    await Promise.all([x.ready, y.ready]);

    x.close();
    // y still watches — the doc must not evict; give the close a beat to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(host.names()).toContain("gc:2");

    y.close();
    await until(() => !host.names().includes("gc:2"));
  });

  test("a dead socket unsubscribes everything it watched", async () => {
    const r = connect(url);               // closed here, not in afterAll
    const d = r.doc<Board>("gc:3");
    await d.ready;
    expect(host.names()).toContain("gc:3");
    r.close();                            // socket death IS the unsubscribe
    await until(() => !host.names().includes("gc:3"));
  });

  test("static docs survive their last watcher; closed handles refuse writes", async () => {
    const r = client();
    const d = r.doc<Board>("board");
    await d.ready;
    d.close();
    await new Promise((res) => setTimeout(res, 50));
    expect(host.names()).toContain("board");   // registered, not dynamic — lives on

    expect(() => d.apply([{ op: "replace", path: "/cards/1/title", value: "nope" }]))
      .toThrow("closed");
    const fresh = r.doc<Board>("board");
    expect(fresh).not.toBe(d);                 // a later ask starts fresh
    await fresh.ready;
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

describe("drop and expel — a subscription never outlives its permit", () => {
  test("drop: every watcher receives the snapshot of nothing and is unsubscribed", async () => {
    const doomed = host.doc<Board>("doomed", structuredClone(empty));
    const d1 = client().doc<Board>("doomed");
    const d2 = client().doc<Board>("doomed");
    await Promise.all([d1.ready, d2.ready]);
    expect(d1.peek()!.cards["1"]!.title).toBe("one");

    host.drop("doomed");
    await until(() => d1.peek() === null && d2.peek() === null);
    expect(host.names()).not.toContain("doomed");

    // Unsubscribed for real: a server write to a re-registered doc with the
    // same name reaches nobody who was evicted.
    const again = host.doc<Board>("doomed", structuredClone(empty));
    expect(again).not.toBe(doomed);
    again.at("/cards/1/title").set("second life");
    await new Promise((res) => setTimeout(res, 50));
    expect(d1.peek()).toBeNull();

    // A fresh open reads the doc as missing once it's dropped for good.
    host.drop("doomed");
    const errors: string[] = [];
    client((_d, e) => errors.push(e)).doc("doomed");
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("unknown doc");
  });

  test("expel: the gate is re-asked; only the refused user's sockets go", async () => {
    const h = createHost({ requireAuth: true });
    h.method("become", (p: { id: string }, ws) => { ws.data.user = { id: p.id }; return true; }, { open: true });
    const allowed = new Set(["alice", "bob"]);
    let club!: Signal<{ n: number }>;
    club = h.doc<{ n: number }>("club", { n: 1 }, {
      open: (u) => (allowed.has(String(u)) ? club.peek() : null),
    });
    const srv = Bun.serve({
      port: 0,
      fetch: (req, s) => h.fetch(req, s) ?? new Response("", { status: 404 }),
      websocket: h.websocket,
    });
    h.setServer(srv);
    const wsUrl = `ws://localhost:${srv.port}${h.path}`;
    const as = (id: string) => {
      const r = connect(wsUrl, { onConnect: async (remote) => { await remote.call("become", { id }); } });
      remotes.push(r);
      return r;
    };
    const alice = as("alice").doc<{ n: number }>("club");
    const bob = as("bob").doc<{ n: number }>("club");
    await Promise.all([alice.ready, bob.ready]);

    // Still allowed — expel is a question, not a command.
    await h.expel("club", "alice");
    expect(alice.peek()!.n).toBe(1);

    allowed.delete("bob");
    await h.expel("club", "bob");
    await until(() => bob.peek() === null);

    // Alice keeps the live stream; the evicted socket hears nothing more.
    club.at("/n").set(2);
    await until(() => alice.peek()?.n === 2);
    expect(bob.peek()).toBeNull();
    srv.stop(true);
  });
});
