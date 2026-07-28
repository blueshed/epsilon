// The primitive's contract, pinned. Each describe maps to a DESIGN.md claim.
import { describe, test, expect } from "bun:test";
import {
  signal, computed, effect, batch,
  pushDisposeScope, popDisposeScope,
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

  test("batch coalesces the state flush; ops stay per-apply in order", () => {
    const s = signal(board());
    let stateRuns = 0;
    const opsSeen: string[] = [];
    const dispose = effect(() => { s.get(); stateRuns++; });
    s.onOps((ops) => ops?.forEach((o) => opsSeen.push(o.path)));
    batch(() => {
      s.apply([{ op: "replace", path: "/name", value: "x" }]);
      s.apply([{ op: "replace", path: "/cards/1/title", value: "y" }]);
    });
    expect(stateRuns).toBe(2);                       // 1 create + 1 coalesced
    expect(opsSeen).toEqual(["/name", "/cards/1/title"]);
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
});
