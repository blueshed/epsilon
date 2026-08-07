// The primitive's contract, pinned. Each describe maps to a DESIGN.md claim.
import { describe, test, expect } from "bun:test";
import {
  signal, computed, effect, batch, pushDisposeScope, popDisposeScope,
} from "./signal";
import type { Op } from "./op";

interface Card { id: number; title: string; done: boolean }
interface Board { cards: Record<string, Card>; name: string }

const board = (): Board => ({
  name: "b1",
  cards: { "1": { id: 1, title: "one", done: false } },
});

describe("state channel (the always-correct fallback)", () => {
  test("set/get/effect work railroad-style", () => {
    const s = signal(0);
    const seen: number[] = [];
    const dispose = effect(() => { seen.push(s.get()); });
    s.set(1);
    s.set(1); // equals-gated
    s.set(2);
    expect(seen).toEqual([0, 1, 2]);
    dispose();
  });

  test("apply() mutates in place — the ref stays stable — and effects re-run", () => {
    const s = signal(board());
    const before = s.peek();
    let runs = 0;
    const dispose = effect(() => { s.get(); runs++; });
    s.apply([{ op: "replace", path: "/cards/1/done", value: true }]);
    expect(s.peek()).toBe(before);          // same ref
    expect(s.peek().cards["1"]!.done).toBe(true);
    expect(runs).toBe(2);
    dispose();
  });

  test("the law: a consumer ignoring ops recomputes correctly", () => {
    const s = signal(board());
    const titles = computed(() => Object.values(s.get().cards).map((c) => c.title).join(","));
    s.apply([{ op: "add", path: "/cards/2", value: { id: 2, title: "two", done: false } }]);
    expect(titles.peek()).toBe("one,two");
  });
});

describe("ops channel", () => {
  test("onOps receives the exact ops; set() delivers a synthetic root-replace", () => {
    const s = signal(board());
    const received: (Op[] | undefined)[] = [];
    s.onOps((ops) => received.push(ops));
    const op: Op = { op: "remove", path: "/cards/1" };
    s.apply([op]);
    s.set(board());
    expect(received[0]).toEqual([op]);
    expect(received[1]![0]!.path).toBe("");
    expect(received[1]![0]!.op).toBe("replace");
  });

  test("ops handlers run BEFORE state effects", () => {
    const s = signal(board());
    const order: string[] = [];
    const dispose = effect(() => { s.get(); order.push("state"); });
    s.onOps(() => order.push("ops"));
    s.apply([{ op: "replace", path: "/name", value: "b2" }]);
    expect(order).toEqual(["state", "ops", "state"]); // first "state" = effect creation
    dispose();
  });


  test("onOps is disposed with its scope", () => {
    const s = signal(board());
    let calls = 0;
    pushDisposeScope();
    s.onOps(() => calls++);
    const dispose = popDisposeScope();
    s.apply([{ op: "replace", path: "/name", value: "x" }]);
    dispose();
    s.apply([{ op: "replace", path: "/name", value: "y" }]);
    expect(calls).toBe(1);
  });
});

describe("at() — the composing lens", () => {
  test("narrows value; writes rebase into the root", () => {
    const s = signal(board());
    const title = s.at<string>("/cards/1/title");
    expect(title.peek()).toBe("one");
    title.set("renamed");
    expect(s.peek().cards["1"]!.title).toBe("renamed");
  });

  test("composes associatively: at('/a').at('/b') ≡ at('/a/b')", () => {
    const s = signal(board());
    const composed = s.at("/cards").at<Card>("/1");
    const direct = s.at<Card>("/cards/1");
    expect(composed.peek()).toEqual(direct.peek());
    composed.apply([{ op: "replace", path: "/done", value: true }]);
    expect(direct.peek()!.done).toBe(true);
    // ops rebase identically through both routes
    const viaComposed: string[] = [];
    const viaDirect: string[] = [];
    composed.onOps((ops) => ops?.forEach((o) => viaComposed.push(o.path)));
    direct.onOps((ops) => ops?.forEach((o) => viaDirect.push(o.path)));
    s.apply([{ op: "replace", path: "/cards/1/title", value: "t" }]);
    expect(viaComposed).toEqual(["/title"]);
    expect(viaDirect).toEqual(["/title"]);
  });

  test("ops narrow: relevant ops rebased, sibling ops skipped entirely", () => {
    const s = signal(board());
    const card = s.at<Card>("/cards/1");
    const seen: (Op[] | undefined)[] = [];
    card.onOps((ops) => seen.push(ops));
    s.apply([{ op: "replace", path: "/name", value: "other" }]);      // sibling
    s.apply([{ op: "replace", path: "/cards/1/done", value: true }]); // relevant
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ op: "replace", path: "/done", value: true }]);
  });

  test("a write ABOVE the lens collapses to one synthetic root-replace", () => {
    const s = signal(board());
    const card = s.at<Card>("/cards/1");
    const seen: Op[][] = [];
    card.onOps((ops) => seen.push(ops!));
    const fresh = { id: 1, title: "replaced", done: true };
    s.apply([{ op: "replace", path: "/cards", value: { "1": fresh } }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([{ op: "replace", path: "", value: fresh }]);
  });

  test("effects through a lens recompute on root change (fallback holds)", () => {
    const s = signal(board());
    const title = s.at<string>("/cards/1/title");
    const seen: (string | undefined)[] = [];
    const dispose = effect(() => { seen.push(title.get()); });
    s.apply([{ op: "replace", path: "/cards/1/title", value: "new" }]);
    expect(seen).toEqual(["one", "new"]);
    dispose();
  });
});

describe("safety", () => {
  test("prototype-pollution paths throw and pollute nothing", () => {
    const s = signal<Record<string, unknown>>({});
    expect(() =>
      s.apply([{ op: "add", path: "/__proto__/isAdmin", value: true }]),
    ).toThrow(/forbidden/);
    expect(({} as any).isAdmin).toBeUndefined();
  });

  test("at() rejects root and malformed pointers", () => {
    const s = signal(board());
    expect(() => s.at("/")).toThrow();
    expect(() => s.at("cards")).toThrow();
  });

  test("apply is ATOMIC — a bad op mid-batch unwinds and notifies nothing", () => {
    const s = signal<any>({ a: { x: 1 }, list: [1, 2] });
    let opsSeen = 0;
    s.onOps(() => opsSeen++);
    let effects = 0;
    const dispose = effect(() => { s.get(); effects++; });   // runs once now

    expect(() =>
      s.apply([
        { op: "replace", path: "/a/x", value: 2 },           // applies…
        { op: "add", path: "/list/-", value: 3 },            // applies…
        { op: "remove", path: "/list/0" },                   // applies…
        { op: "replace", path: "/missing/deep", value: 1 },  // …throws
      ]),
    ).toThrow(/path not found/);

    // The applied prefix rolled back; neither channel heard a thing.
    expect(s.peek()).toEqual({ a: { x: 1 }, list: [1, 2] });
    expect(opsSeen).toBe(0);
    expect(effects).toBe(1);
    dispose();
  });
});

// The grain inversion (0.9.0). Before this, Lens.get() tracked the ROOT, so
// an effect over a lens re-ran on every unrelated write — correct, never
// minimal. That is the whole reason bind() existed, and the reason japan
// wrote 116 effects and zero binds: the cheap path was the imprecise one.
describe("a lens tracks its own slice", () => {
  test("a sibling write does NOT re-run an effect over the lens", () => {
    const doc = signal<{ cards: Record<string, { title: string }> }>({
      cards: { "1": { title: "one" }, "2": { title: "two" } },
    });
    const seen: string[] = [];
    pushDisposeScope();
    const one = doc.at<string>("/cards/1/title");
    effect(() => { seen.push(one.get()); });
    const dispose = popDisposeScope();
    expect(seen).toEqual(["one"]);

    doc.apply([{ op: "replace", path: "/cards/2/title", value: "sibling" }]);
    expect(seen).toEqual(["one"]);                       // untouched

    doc.apply([{ op: "replace", path: "/cards/1/title", value: "mine" }]);
    expect(seen).toEqual(["one", "mine"]);               // its own path

    doc.apply([{ op: "replace", path: "/cards/1", value: { title: "row" } }]);
    expect(seen).toEqual(["one", "mine", "row"]);        // an ancestor replace

    doc.set({ cards: { "1": { title: "snap" } } });
    expect(seen).toEqual(["one", "mine", "row", "snap"]); // a root snapshot

    dispose();
    doc.apply([{ op: "replace", path: "/cards/1/title", value: "late" }]);
    expect(seen.length).toBe(4);                          // torn down
  });

  test("recompute-from-state still holds — the law is not traded away", () => {
    const doc = signal<{ a: { b: number } }>({ a: { b: 1 } });
    pushDisposeScope();
    const b = doc.at<number>("/a/b");
    let last = 0;
    effect(() => { last = b.get(); });
    const dispose = popDisposeScope();

    // An op that never mentions /a/b but replaces its ancestor.
    doc.apply([{ op: "replace", path: "/a", value: { b: 42 } }]);
    expect(last).toBe(42);
    expect(b.get()).toBe(42);        // peek and track agree
    dispose();
  });

  test("composed lenses narrow further, not wider", () => {
    const doc = signal<{ r: Record<string, { n: number }> }>({ r: { x: { n: 1 }, y: { n: 1 } } });
    let runs = 0;
    pushDisposeScope();
    const xn = doc.at("/r").at<number>("/x/n");
    effect(() => { xn.get(); runs++; });
    const dispose = popDisposeScope();
    expect(runs).toBe(1);
    doc.apply([{ op: "replace", path: "/r/y/n", value: 9 }]);
    expect(runs).toBe(1);                                 // sibling, ignored
    doc.apply([{ op: "replace", path: "/r/x/n", value: 9 }]);
    expect(runs).toBe(2);
    dispose();
  });
});

// Restored in 0.9.1. Deleted in 0.9.0 on the reasoning that apply(ops[])
// already batches "the only channel an app writes through" — which missed
// that an app also holds plain local signals, and two sets on two DIFFERENT
// signals are not ops on one doc. japan's line.ts broke on the upgrade.
describe("batch() — coalesce across several signals", () => {
  test("dependents run once, not once per set", () => {
    const me = signal<string | null>(null);
    const refused = signal("nope");
    let runs = 0;
    pushDisposeScope();
    effect(() => { me.get(); refused.get(); runs++; });
    const dispose = popDisposeScope();
    expect(runs).toBe(1);

    me.set("pete");
    refused.set("");
    expect(runs).toBe(3);                       // unbatched: one flush each

    runs = 0;
    batch(() => { me.set("ann"); refused.set("x"); });
    expect(runs).toBe(1);                       // one flush for both
    dispose();
  });

  test("a throw inside still releases the depth and flushes", () => {
    const a = signal(0);
    let runs = 0;
    pushDisposeScope();
    effect(() => { a.get(); runs++; });
    const dispose = popDisposeScope();
    runs = 0;
    expect(() => batch(() => { a.set(1); throw new Error("boom"); })).toThrow("boom");
    expect(runs).toBe(1);                       // not stranded
    a.set(2);
    expect(runs).toBe(2);                       // depth released
    dispose();
  });
});

describe("the flush scheduler's guarantees (pinned here, not just inherited)", () => {
  test("a diamond settles ONCE, with both legs already current", () => {
    // Glitch-freedom is what the topological buckets buy: `sum` depends on
    // two computeds over one source, so a naive scheduler runs it twice —
    // once with a stale leg, which is a value that never legitimately existed.
    const a = signal(1);
    pushDisposeScope();
    const left = computed(() => a.get() * 2);
    const right = computed(() => a.get() * 10);
    const seen: number[] = [];
    effect(() => { seen.push(left.get() + right.get()); });
    const dispose = popDisposeScope();

    expect(seen).toEqual([12]);
    seen.length = 0;
    a.set(2);
    expect(seen).toEqual([24]);        // once — never an intermediate 22 or 14
    dispose();
  });

  test("a self-feeding effect is stopped, not left to spin the process down", () => {
    // The guard is the difference between a bug that names itself and a tab
    // that locks up. It has to THROW, and the message has to say what it is.
    const a = signal(0);
    pushDisposeScope();
    expect(() => {
      effect(() => { a.set(a.get() + 1); });   // writes what it reads
    }).toThrow(/infinite loop/i);
    popDisposeScope()();
  });
});

describe("a lens minted inside an effect is wasteful, never fatal", () => {
  // The field report that produced this suite (a kanban built on 0.10.2):
  // "the second or third echo left the tab completely unresponsive — no
  // error, no warning, no console output: a hang." The demo taught the
  // shape, and the runtime turned it into an unbounded loop.
  const rowEcho = (i: number) =>
    [{ op: "replace" as const, path: "/cards/1", value: { text: `e${i}`, by: 1, at: `t${i}` } }];

  test("one echo re-runs it ONCE — not until the process dies", () => {
    const doc = signal<any>({ cards: { 1: { text: "a", by: 1, at: "t" } } });
    const card = doc.at<any>("/cards/1");
    let runs = 0;
    pushDisposeScope();
    effect(() => {
      // Minted INSIDE, on every run — what the demo's cardDetail did, and
      // what anyone reading three fields off a row writes first.
      if (++runs > 100) throw new Error("runaway: the loop is back");
      card.at<string>("/text").get();
    });
    const dispose = popDisposeScope();
    expect(runs).toBe(1);

    doc.apply(rowEcho(1));
    expect(runs).toBe(2);                       // once, not 2001
    expect((doc as any).opsHandlers.size).toBe(1);

    for (let i = 2; i <= 20; i++) doc.apply(rowEcho(i));
    expect(runs).toBe(21);                      // linear in ops, always
    expect((doc as any).opsHandlers.size).toBe(1);   // ...and in subscriptions
    dispose();
    expect((doc as any).opsHandlers.size).toBe(0);   // released by refcount
  });

  test("minting inside costs exactly what hoisting costs", () => {
    const build = (hoist: boolean) => {
      const doc = signal<any>({ cards: { 1: { text: "a", by: 1, at: "t" } } });
      const card = doc.at<any>("/cards/1");
      const t = card.at<string>("/text"), b = card.at<number>("/by"), a = card.at<string>("/at");
      let runs = 0;
      pushDisposeScope();
      effect(() => {
        runs++;
        if (hoist) { t.get(); b.get(); a.get(); }
        else { card.at<string>("/text").get(); card.at<number>("/by").get(); card.at<string>("/at").get(); }
      });
      const dispose = popDisposeScope();
      for (let i = 1; i <= 12; i++) doc.apply(rowEcho(i));
      const handlers = (doc as any).opsHandlers.size;
      dispose();
      return { runs, handlers, after: (doc as any).opsHandlers.size };
    };
    expect(build(false)).toEqual(build(true));   // identical, which is the fix
    expect(build(false).after).toBe(0);
  });

  test("two scopes share one subscription; disposing one leaves the other live", () => {
    // The reason the tick is refcounted rather than owned by whoever read
    // first: a shared slice must not go deaf when one reader leaves.
    const doc = signal<any>({ cards: { 1: { text: "a" } } });
    const seenA: string[] = [], seenB: string[] = [];
    pushDisposeScope();
    effect(() => { seenA.push(doc.at<any>("/cards/1").at<string>("/text").get()); });
    const disposeA = popDisposeScope();
    pushDisposeScope();
    effect(() => { seenB.push(doc.at<string>("/cards/1/text").get()); });
    const disposeB = popDisposeScope();
    expect((doc as any).opsHandlers.size).toBe(1);   // ONE, for one path

    doc.apply([{ op: "replace", path: "/cards/1/text", value: "b" }]);
    expect(seenA).toEqual(["a", "b"]);
    expect(seenB).toEqual(["a", "b"]);

    disposeA();
    doc.apply([{ op: "replace", path: "/cards/1/text", value: "c" }]);
    expect(seenB).toEqual(["a", "b", "c"]);         // B still hears it
    expect(seenA).toEqual(["a", "b"]);
    disposeB();
    expect((doc as any).opsHandlers.size).toBe(0);
  });

  test("a handler subscribed DURING delivery hears the next op, not this one", () => {
    // The Set-visits-what-you-append hazard, pinned directly: this is what
    // turned one echo into an unbounded pass.
    const doc = signal<any>({ n: 0 });
    let inner = 0;
    pushDisposeScope();
    doc.onOps(() => { doc.onOps(() => { inner++; }); });
    const dispose = popDisposeScope();
    doc.apply([{ op: "replace", path: "/n", value: 1 }]);
    expect(inner).toBe(0);                    // not re-entered in the same pass
    doc.apply([{ op: "replace", path: "/n", value: 2 }]);
    expect(inner).toBeGreaterThan(0);         // heard from the next one
    dispose();
  });
});
