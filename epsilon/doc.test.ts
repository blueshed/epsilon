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
    fetch: (req, srv) => host.fetch(req, srv) ?? new Response("", { status: 404 }),
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
