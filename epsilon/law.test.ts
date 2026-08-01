// The law harness's pure half: equality, divergence walking, and the
// diagnosis — the failure text is the harness's interface, so its shapes
// are pinned here without a database. The wire-driving half (proveLaw) is
// exercised for real in rel.test.ts, on the board and todo types.
import { describe, test, expect } from "bun:test";
import { deepEquals, diff, classify, proveLaw } from "./law";
import type { Op } from "./op";

describe("deepEquals — structural, JSON semantics", () => {
  test("primitives, nesting, arrays", () => {
    expect(deepEquals(1, 1)).toBe(true);
    expect(deepEquals("a", "b")).toBe(false);
    expect(deepEquals({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(deepEquals({ a: { b: [1, 2] } }, { a: { b: [2, 1] } })).toBe(false);
    expect(deepEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEquals({}, [])).toBe(false);
    expect(deepEquals(null, {})).toBe(false);
  });

  test("a key holding undefined equals a missing key — JSON has no undefined", () => {
    expect(deepEquals({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEquals({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEquals({ a: undefined }, { a: null })).toBe(false);
  });

  test("key order never matters", () => {
    expect(deepEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
});

describe("diff — every divergence, as JSON Pointers", () => {
  test("equal values diff to nothing", () => {
    expect(diff({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
  });

  test("a changed scalar names its exact path", () => {
    expect(diff({ cards: { "5": { done: false } } }, { cards: { "5": { done: true } } }))
      .toEqual([{ path: "/cards/5/done", client: false, recompute: true }]);
  });

  test("one-sided paths carry undefined on the absent side", () => {
    const d = diff({ cards: { "5": { id: 5 } } }, { cards: {} });
    expect(d).toEqual([{ path: "/cards/5", client: { id: 5 }, recompute: undefined }]);
    const e = diff({ cards: {} }, { cards: { "5": { id: 5 } } });
    expect(e[0]!.client).toBeUndefined();
  });

  test("pointer tokens escape ~ and /", () => {
    const d = diff({ "a/b": 1 }, { "a/b": 2 });
    expect(d[0]!.path).toBe("/a~1b");
  });

  test("a type mismatch reports at the container, not inside it", () => {
    expect(diff({ a: [1] }, { a: { "0": 1 } })).toEqual([
      { path: "/a", client: [1], recompute: { "0": 1 } },
    ]);
  });
});

describe("classify — the defect class, named", () => {
  test("client-extra state after a remove reads as an unexpressed cascade", () => {
    const diffs = diff(
      { stops: { "1": { id: 1 }, "2": { id: 2 } }, legs: {} },
      { stops: {}, legs: {} },
    );
    const echo: Op[] = [{ op: "remove", path: "/legs/7" }];
    expect(classify(diffs, echo).join(" ")).toContain("doc_cascade_remove");
  });

  test("a sibling column disagreeing beside the echoed path reads as an unwidened echo", () => {
    const diffs = diff(
      { cards: { "5": { done: true, updated_by: 3 } } },
      { cards: { "5": { done: true, updated_by: 4 } } },
    );
    const echo: Op[] = [{ op: "replace", path: "/cards/5/done", value: true }];
    expect(classify(diffs, echo).join(" ")).toContain("widen to the whole row");
  });

  test("recompute-extra state reads as an unechoed column", () => {
    const diffs = diff(
      { cards: { "5": { id: 5 } } },
      { cards: { "5": { id: 5, updated_at: "now" } } },
    );
    expect(classify(diffs, [] as Op[]).join(" ")).toContain("never delivered");
  });
});

describe("proveLaw — the failure is the interface", () => {
  test("a lying copy fails with paths, echo, and the law, in words", async () => {
    // A fake handle over a fake sql: the client copy disagrees with the
    // "recompute" — proveLaw must throw the full diagnosis without a wire.
    const handle = {
      ready: Promise.resolve(),
      v: 1,
      peek: () => ({ cards: { "5": { done: true, updated_by: 3 } } }),
      onOps: () => () => {},
    } as any;
    const sql = ((strings: TemplateStringsArray) => {
      void strings;
      return Promise.resolve([{ d: { cards: { "5": { done: true, updated_by: 4 } } } }]);
    }) as any;
    sql.unsafe = () => Promise.resolve([]);

    let err = "";
    try {
      await proveLaw({ handle, name: "board:9", sql, batches: [] });
    } catch (e) {
      err = String(e);
    }
    expect(err).toContain("board:9 violates the law before any batch");
    expect(err).toContain("/cards/5/updated_by");
    expect(err).toContain("client 3 ≠ recompute 4");
    expect(err).toContain("recompute-from-state must always be correct");
  });
});
