// The vocabulary's contract. Three verbs, JSON-Pointer paths, and the
// prototype guard delta had to retrofit — pinned here because every other
// suite builds on op.ts and none of them tests it directly.
import { describe, test, expect } from "bun:test";
import { splitPath, escapeToken, valueAt, applyOp, type Op } from "./op";

describe("splitPath", () => {
  test("the whole document is no tokens", () => {
    expect(splitPath("")).toEqual([]);
    expect(splitPath("/")).toEqual([]);
  });

  test("unescapes ~1 to / and ~0 to ~", () => {
    expect(splitPath("/a~1b")).toEqual(["a/b"]);
    expect(splitPath("/a~0b")).toEqual(["a~b"]);
  });

  // RFC 6901's order matters: ~01 means the literal "~1", so ~1 must be
  // replaced BEFORE ~0. Reverse the two and this round-trip returns "/".
  test("~1 before ~0 — the order that makes ~01 literal", () => {
    expect(splitPath("/~01")).toEqual(["~1"]);
    expect(splitPath("/~00")).toEqual(["~0"]);
  });

  test("round-trips any token through escapeToken", () => {
    for (const token of ["a/b", "a~b", "~1", "~0", "~01", "/", "~", "plain"]) {
      expect(splitPath("/" + escapeToken(token))).toEqual([token]);
    }
  });

  // RFC 6901 reads "/" as a pointer to the empty-string KEY. Epsilon reads it
  // as the root, because "" and "/" both have to mean "the whole document"
  // for root ops to work. The cost is that an empty-string key is
  // unaddressable — the one token escapeToken cannot round-trip.
  test("\"/\" is the root here, not an empty-string key", () => {
    expect(splitPath("/" + escapeToken(""))).toEqual([]);
  });

  test("refuses the three tokens that reach the prototype chain", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      expect(() => splitPath(`/${bad}`)).toThrow(/forbidden path segment/);
      expect(() => splitPath(`/safe/${bad}/deeper`)).toThrow(/forbidden path segment/);
    }
  });

  // Whole-token match only — the guard must not swallow honest field names.
  test("allows names that merely contain a forbidden word", () => {
    expect(splitPath("/constructorName")).toEqual(["constructorName"]);
    expect(splitPath("/my__proto__field")).toEqual(["my__proto__field"]);
  });
});

describe("applyOp", () => {
  test("root ops belong to Signal.apply, not here", () => {
    expect(() => applyOp({}, { op: "replace", path: "", value: 1 })).toThrow(/root ops/);
  });

  test("add SETS, and only /- appends — this is not RFC 6902", () => {
    const doc = { xs: [1, 2, 3] };
    applyOp(doc, { op: "add", path: "/xs/1", value: 9 });
    expect(doc.xs).toEqual([1, 9, 3]);        // overwritten, never shifted
    applyOp(doc, { op: "add", path: "/xs/-", value: 4 });
    expect(doc.xs).toEqual([1, 9, 3, 4]);
  });

  test("replace creates a missing record key", () => {
    const doc: Record<string, unknown> = {};
    applyOp(doc, { op: "replace", path: "/fresh", value: 1 });
    expect(doc.fresh).toBe(1);
  });

  test("the returned undo restores exactly what changed", () => {
    const cases: [unknown, Op][] = [
      [{ a: 1 }, { op: "replace", path: "/a", value: 2 }],   // existing key
      [{ a: 1 }, { op: "add", path: "/b", value: 2 }],       // new key
      [{ xs: [1, 2, 3] }, { op: "remove", path: "/xs/1" }],  // array splice
      [{ xs: [1, 2] }, { op: "add", path: "/xs/-", value: 3 }],
      [{ a: 1 }, { op: "remove", path: "/a" }],
      [{ a: 1 }, { op: "remove", path: "/missing" }],        // no-op undo
    ];
    for (const [doc, op] of cases) {
      const before = structuredClone(doc);
      const undo = applyOp(doc, op);
      undo();
      expect(doc).toEqual(before);
    }
  });

  test("a missing intermediate segment throws rather than building one", () => {
    expect(() => applyOp({}, { op: "replace", path: "/a/b", value: 1 }))
      .toThrow(/path not found/);
  });
});

describe("valueAt", () => {
  test("reads through the same escaping", () => {
    expect(valueAt({ "a/b": 1 }, "/a~1b")).toBe(1);
    expect(valueAt({ xs: [{ t: "x" }] }, "/xs/0/t")).toBe("x");
  });

  test("undefined for any missing segment, never a throw", () => {
    expect(valueAt({}, "/nope")).toBeUndefined();
    expect(valueAt({}, "/deeply/missing/path")).toBeUndefined();
    expect(valueAt(null, "/a")).toBeUndefined();
  });

  test("the empty pointer is the whole document", () => {
    const doc = { a: 1 };
    expect(valueAt(doc, "")).toBe(doc);
  });

  // The guard is in splitPath, so reads are covered by it too.
  test("still refuses a prototype-chain read", () => {
    expect(() => valueAt({}, "/__proto__")).toThrow(/forbidden path segment/);
  });
});
