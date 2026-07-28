/**
 * Op — the one vocabulary. Three verbs, JSON-Pointer paths.
 *
 * Adapted from @blueshed/delta core.ts, born with the prototype-pollution
 * guard delta had to retrofit. See DESIGN.md — never invent verbs.
 *
 *   { op: "replace", path: "/field",    value: v }   — set at path
 *   { op: "add",     path: "/items/-",  value: v }   — set, or append with /-
 *   { op: "remove",  path: "/items/0" }              — delete by path
 */

export type Op =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

// Reference tokens that would walk or write the prototype chain. Whole-token
// match only — a field named `constructorName` is legal.
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/** Split a JSON Pointer into unescaped reference tokens. Throws on tokens
 *  that would reach the prototype chain. */
export function splitPath(path: string): string[] {
  if (path === "" || path === "/") return [];
  const tokens = path
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const t of tokens) {
    if (FORBIDDEN.has(t)) {
      throw new Error(`[epsilon/op] forbidden path segment: ${t}`);
    }
  }
  return tokens;
}

/** Escape one reference token for embedding in a pointer (~ first, then /). */
export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function parsePath(path: string): (string | number)[] {
  return splitPath(path).map((t) => (/^\d+$/.test(t) ? Number(t) : t));
}

function walk(
  obj: any,
  segments: (string | number)[],
): { parent: any; key: string | number } {
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    current = current[segments[i]!];
    if (current == null)
      throw new Error(`[epsilon/op] path not found at segment ${segments[i]}`);
  }
  return { parent: current, key: segments[segments.length - 1]! };
}

/**
 * Apply ONE non-root op IN PLACE and return an undo that restores exactly
 * what changed — the atomicity primitive: appliers stack undos and unwind
 * on a mid-batch throw. @internal (Signal.apply and applyOps build on it)
 */
export function applyOp(doc: any, op: Op): () => void {
  const segments = parsePath(op.path);
  if (segments.length === 0) {
    throw new Error(
      "[epsilon/op] root ops are handled by Signal.apply, not applyOps",
    );
  }
  const { parent, key } = walk(doc, segments);
  switch (op.op) {
    case "replace":
    case "add": {
      if (Array.isArray(parent) && key === "-") {
        parent.push(op.value);
        return () => { parent.pop(); };
      }
      const had = Object.prototype.hasOwnProperty.call(parent, key);
      const prev = parent[key];
      parent[key] = op.value;
      return had ? () => { parent[key] = prev; } : () => { delete parent[key]; };
    }
    case "remove": {
      if (Array.isArray(parent) && typeof key === "number") {
        const removed = parent.splice(key, 1);
        return () => { parent.splice(key, 0, ...removed); };
      }
      const had = Object.prototype.hasOwnProperty.call(parent, key);
      const prev = parent[key];
      delete parent[key];
      return had ? () => { parent[key] = prev; } : () => {};
    }
  }
}

/**
 * Apply ops to a container IN PLACE (the ref stays stable — that's the point:
 * no clone per change), ATOMICALLY: a throw mid-batch unwinds the applied
 * prefix, so the container never holds a half-applied batch. Root ops
 * (path "" / "/") are NOT handled here — the signal layer owns root
 * replacement, where reassigning the value is correct.
 */
export function applyOps(doc: any, ops: Op[]): void {
  const undos: (() => void)[] = [];
  try {
    for (const op of ops) undos.push(applyOp(doc, op));
  } catch (err) {
    for (let i = undos.length - 1; i >= 0; i--) undos[i]!();
    throw err;
  }
}

/** Read the value at a pointer, or undefined when any segment is missing. */
export function valueAt(doc: any, path: string): unknown {
  let current = doc;
  for (const seg of parsePath(path)) {
    if (current == null) return undefined;
    current = current[seg];
  }
  return current;
}
