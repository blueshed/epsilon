// Ops to pixels. The last test is the whole thesis: a real server, a real
// WebSocket, a real DOM — one op stream end to end, no diffing anywhere.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Conditional: `bun test` loads every file into one process and route.test.ts
// registers too — whichever module body runs second would throw on a repeat
// registration, and load order is not the order in the test script.
if (typeof globalThis.document === "undefined") {
  const NativeWebSocket = globalThis.WebSocket;
  GlobalRegistrator.register();
  // happy-dom's WebSocket can't reach a real Bun.serve — keep the native one.
  globalThis.WebSocket = NativeWebSocket;
}

import { describe, test, expect } from "bun:test";
import { signal, effect, pushDisposeScope, popDisposeScope, type OpSignal } from "./signal";
import { createHost, connect } from "./doc";
import { list, text, bind, when, mount } from "./ui";

interface Card { id: number; title: string; done: boolean }
type Cards = Record<string, Card>;

const two = (): Cards => ({
  "1": { id: 1, title: "one", done: false },
  "2": { id: 2, title: "two", done: false },
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const until = async (cond: () => boolean, ms = 1000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await tick();
  }
};

/** Mount a list of <li>{title}</li> rows inside a scope; return the pieces. */
function mountCards(sig: OpSignal<Cards | null>) {
  const root = document.createElement("ul");
  pushDisposeScope();
  root.appendChild(
    list(sig, (row) => {
      const li = document.createElement("li");
      li.appendChild(text(row.map((c) => c?.title)));
      return li;
    }),
  );
  const dispose = popDisposeScope();
  document.body.appendChild(root);
  return { root, dispose };
}

describe("list() — membership router", () => {
  test("paints from existing data; add/remove route without touching other rows", async () => {
    const sig = signal<Cards | null>(two());
    const { root, dispose } = mountCards(sig);
    await tick(); // deferred first paint
    expect(root.querySelectorAll("li").length).toBe(2);
    const [first] = root.querySelectorAll("li");

    sig.apply([{ op: "add", path: "/3", value: { id: 3, title: "three", done: false } }]);
    expect(root.querySelectorAll("li").length).toBe(3);
    expect(root.querySelectorAll("li")[0]).toBe(first!);   // untouched — same node

    sig.apply([{ op: "remove", path: "/2" }]);
    expect(root.querySelectorAll("li").length).toBe(2);
    expect(root.textContent).toBe("onethree");
    dispose();
  });

  test("a field op updates row text through the lens — the node survives", async () => {
    const sig = signal<Cards | null>(two());
    const { root, dispose } = mountCards(sig);
    await tick();
    const node = root.querySelectorAll("li")[0]!;
    sig.apply([{ op: "replace", path: "/1/title", value: "renamed" }]);
    expect(root.querySelectorAll("li")[0]).toBe(node);     // not recreated
    expect(node.textContent).toBe("renamed");
    dispose();
  });

  test("root replace reconciles key sets; surviving rows keep their nodes", async () => {
    const sig = signal<Cards | null>(two());
    const { root, dispose } = mountCards(sig);
    await tick();
    const keeper = root.querySelectorAll("li")[0]!;
    sig.set({ "1": { id: 1, title: "kept", done: true }, "9": { id: 9, title: "nine", done: false } });
    expect(root.querySelectorAll("li").length).toBe(2);
    expect(root.querySelectorAll("li")[0]).toBe(keeper);   // survived the snapshot
    expect(root.textContent).toBe("keptnine");
    dispose();
  });

  test("scope dispose tears the region down and stops updates", async () => {
    const sig = signal<Cards | null>(two());
    const { root, dispose } = mountCards(sig);
    await tick();
    dispose();
    expect(root.querySelectorAll("li").length).toBe(0);
    sig.apply([{ op: "add", path: "/4", value: { id: 4, title: "late", done: false } }]);
    expect(root.querySelectorAll("li").length).toBe(0);
  });
});

describe("bind() — the precise scalar path", () => {
  test("sibling ops never fire it; its own path, ancestors, and snapshots do", () => {
    const sig = signal<{ cards: Cards }>({ cards: two() });
    const calls: string[] = [];
    pushDisposeScope();
    bind(sig.at<string>("/cards/1/title"), (v) => calls.push(String(v)));
    const dispose = popDisposeScope();
    expect(calls).toEqual(["one"]);                                   // initial paint

    sig.apply([{ op: "replace", path: "/cards/2/title", value: "sibling" }]);
    expect(calls).toEqual(["one"]);                                   // the §4 fix: not re-run

    sig.apply([{ op: "replace", path: "/cards/1/title", value: "mine" }]);
    expect(calls).toEqual(["one", "mine"]);

    sig.apply([{ op: "replace", path: "/cards/1", value: { id: 1, title: "row", done: true } }]);
    expect(calls).toEqual(["one", "mine", "row"]);                    // ancestor replace

    sig.set({ cards: { "1": { id: 1, title: "snap", done: false } } });
    expect(calls).toEqual(["one", "mine", "row", "snap"]);            // root snapshot

    dispose();
    sig.apply([{ op: "replace", path: "/cards/1/title", value: "late" }]);
    expect(calls.length).toBe(4);                                     // torn down
  });

  test("a bound DOM prop rides the ops channel end to end", async () => {
    const sig = signal<Cards | null>(two());
    const root = document.createElement("ul");
    let runs = 0;
    pushDisposeScope();
    root.appendChild(
      list(sig, (row) => {
        const li = document.createElement("li");
        bind(row.at<string>("/title"), (t) => { runs++; li.textContent = t ?? ""; });
        return li;
      }),
    );
    const dispose = popDisposeScope();
    document.body.appendChild(root);
    await tick();
    expect(runs).toBe(2);                                             // one initial set per row

    sig.apply([{ op: "replace", path: "/1/title", value: "edited" }]);
    expect(runs).toBe(3);                                             // ONLY row 1 re-ran
    expect(root.textContent).toBe("editedtwo");
    dispose();
  });
});

describe("postgres to pixel (minus postgres)", () => {
  test("server op → wire → lens → DOM, no diffing anywhere", async () => {
    const host = createHost();
    const hosted = host.doc<{ cards: Cards }>("board", { cards: two() });
    const server = Bun.serve({
      port: 0,
      fetch: host.fetch,
      websocket: host.websocket,
    });
    host.setServer(server);
    const remote = connect(`ws://localhost:${server.port}${host.path}`);
    const board = remote.doc<{ cards: Cards }>("board");
    await board.ready;

    const { root, dispose } = mountCards(board.at<Cards>("/cards") as OpSignal<Cards | null>);
    await tick();
    expect(root.querySelectorAll("li").length).toBe(2);
    const node = root.querySelectorAll("li")[0]!;

    // The authority writes; the pixel updates. Same vocabulary the whole way.
    hosted.at("/cards/1/title").set("from-the-server");
    await until(() => node.textContent === "from-the-server");
    expect(root.querySelectorAll("li")[0]).toBe(node);     // identity carried, never guessed

    // And the client edits the same pixel path back through the wire.
    board.at("/cards/2/title").set("from-the-client");
    await until(() => hosted.peek().cards["2"]!.title === "from-the-client");

    dispose();
    remote.close();
    server.stop(true);
  });
});

// === when(), mount(), and the SVG guard ===

describe("when()", () => {
  test("swaps on the truthiness transition only — a truthy branch is never rebuilt", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const cond = signal<string>("");
    let builds = 0;

    const dispose = mount(root, () =>
      when(cond, () => {
        builds++;
        const el = document.createElement("p");
        effect(() => { el.textContent = cond.get(); });
        return el;
      }, () => document.createElement("hr")),
    );
    await tick();
    expect(root.querySelector("hr")).not.toBeNull();
    expect(builds).toBe(0);

    cond.set("a");
    await tick();
    expect(root.querySelector("p")?.textContent).toBe("a");
    expect(builds).toBe(1);

    // Still truthy — the branch keeps its node AND its effect.
    const node = root.querySelector("p")!;
    cond.set("b");
    await tick();
    expect(builds).toBe(1);
    expect(root.querySelector("p")).toBe(node);
    expect(node.textContent).toBe("b");

    cond.set("");
    await tick();
    expect(root.querySelector("p")).toBeNull();
    expect(root.querySelector("hr")).not.toBeNull();
    dispose();
  });

  test("a branch's effects are disposed when the parent scope tears down", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const cond = signal(true);
    let cleanups = 0;

    const dispose = mount(root, () =>
      when(cond, () => {
        const el = document.createElement("p");
        effect(() => () => { cleanups++; });
        return el;
      }),
    );
    await tick();
    expect(cleanups).toBe(0);

    dispose();
    expect(cleanups).toBe(1);
    expect(root.children.length).toBe(0);
  });

  test("accepts a plain function as the condition", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const n = signal(0);
    const dispose = mount(root, () =>
      when(() => n.get() > 2, () => document.createElement("b")),
    );
    await tick();
    expect(root.querySelector("b")).toBeNull();
    n.set(5);
    await tick();
    expect(root.querySelector("b")).not.toBeNull();
    dispose();
  });
});

describe("mount()", () => {
  test("disposes everything it bracketed, and removes its nodes", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let cleanups = 0;
    const dispose = mount(root, () => {
      const el = document.createElement("section");
      effect(() => () => { cleanups++; });
      return el;
    });
    expect(root.querySelector("section")).not.toBeNull();

    dispose();
    dispose(); // idempotent
    expect(cleanups).toBe(1);
    expect(root.children.length).toBe(0);
  });

  test("a throwing render leaves the dispose stack balanced", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    expect(() => mount(root, () => { throw new Error("boom"); })).toThrow("boom");
    // If the stack had leaked, this mount would pop the wrong scope.
    const dispose = mount(root, () => document.createElement("i"));
    expect(root.querySelector("i")).not.toBeNull();
    dispose();
  });

  test("silences the scopeless warning that a bare list() prints", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a); };

    const cards = signal<Cards | null>(two()) as OpSignal<Cards | null>;
    const dispose = mount(root, () => list(cards, () => document.createElement("li")));
    await tick();
    console.warn = orig;

    expect(warns.length).toBe(0);
    expect(root.querySelectorAll("li").length).toBe(2);
    dispose();
  });
});

describe("SVG", () => {
  const SVG_NS = "http://www.w3.org/2000/svg";

  test("createElementNS rows render into <svg> in the right namespace", async () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    document.body.appendChild(svg);
    const cards = signal<Cards | null>(two()) as OpSignal<Cards | null>;

    const dispose = mount(svg, () =>
      list(cards, (row) => {
        const c = document.createElementNS(SVG_NS, "circle");
        bind(row.at<string>("/title"), (t) => c.setAttribute("aria-label", t));
        return c;
      }),
    );
    await tick();
    const circles = [...svg.querySelectorAll("circle")];
    expect(circles.length).toBe(2);
    expect(circles.every((c) => c.namespaceURI === SVG_NS)).toBe(true);
    expect(circles[0]!.getAttribute("aria-label")).toBe("one");
    dispose();
  });

  test("an HTML element in an SVG parent is reported, not silently rewritten", async () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    document.body.appendChild(svg);
    const cards = signal<Cards | null>({ "1": { id: 1, title: "one", done: false } }) as OpSignal<Cards | null>;

    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a); };

    const clicks: number[] = [];
    const dispose = mount(svg, () =>
      list(cards, () => {
        const wrong = document.createElement("circle"); // the footgun
        wrong.addEventListener("click", () => clicks.push(1));
        return wrong;
      }),
    );
    await tick();
    console.warn = orig;

    expect(warns.length).toBe(1);
    expect(String(warns[0]?.[0])).toContain("createElementNS");
    // Reported, and left alone — the node the caller built is the node in the
    // tree, listener intact. A rewrite would have dropped this.
    const el = svg.firstElementChild!;
    expect(el.namespaceURI).not.toBe(SVG_NS);
    el.dispatchEvent(new Event("click"));
    expect(clicks.length).toBe(1);
    dispose();
  });

  test("children of <foreignObject> are HTML, and pass without a word", async () => {
    const svg = document.createElementNS(SVG_NS, "svg");
    const fo = document.createElementNS(SVG_NS, "foreignObject");
    svg.appendChild(fo);
    document.body.appendChild(svg);

    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a); };
    const dispose = mount(fo, () => document.createElement("div"));
    console.warn = orig;

    expect(warns.length).toBe(0);
    dispose();
  });
});
