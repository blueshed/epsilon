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
 * Apply ops to a container IN PLACE (the ref stays stable — that's the point:
 * no clone per change). Root ops (path "" / "/") are NOT handled here — the
 * signal layer owns root replacement, where reassigning the value is correct.
 */
export function applyOps(doc: any, ops: Op[]): void {
  for (const op of ops) {
    const segments = parsePath(op.path);
    if (segments.length === 0) {
      throw new Error(
        "[epsilon/op] root ops are handled by Signal.apply, not applyOps",
      );
    }
    const { parent, key } = walk(doc, segments);
    switch (op.op) {
      case "replace":
      case "add":
        if (Array.isArray(parent) && key === "-") parent.push(op.value);
        else parent[key] = op.value;
        break;
      case "remove":
        if (Array.isArray(parent) && typeof key === "number")
          parent.splice(key, 1);
        else delete parent[key];
        break;
    }
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
