/**
 * Law — the harness that makes the design's one law executable for YOUR doc
 * types: ops are the fast path; recompute-from-state must always be correct
 * on its own.
 *
 * proveLaw() drives batches through an open client doc over the REAL wire
 * and, after every echo, asserts the client's copy deep-equals
 * doc_open(name) composed fresh from the tables. A dispatch whose op stream
 * lies — an FK cascade the log never saw, an echo narrower than what the
 * DML changed, a mirror that skipped — fails HERE, with the defect class
 * named in the error. With `undo` wired it also undoes and redoes every
 * batch, re-checking after each: the recorded inverse is the half of the
 * log a plain drive never exercises.
 *
 *   const doc = remote.doc<Todos>(name);
 *   await proveLaw({
 *     handle: doc, name, sql,
 *     batches: [
 *       () => [{ op: "add", path: "/todos/-", value: { text: "one" } }],
 *       (d) => [{ op: "replace", path: `/todos/${firstId(d)}/done`, value: true }],
 *       (d) => [{ op: "remove", path: `/todos/${firstId(d)}` }],
 *     ],
 *     undo: (v) => remote.call("undo", { doc: name, v }),   // pgUndo wired
 *   });
 *
 * One batch per dispatch branch is the discipline (batch functions may close
 * over test state — a restore batch keeps the row an earlier one removed).
 * The harness THROWS plain Errors, so it runs inside any test() — and its
 * failure text is written for whoever (or whatever) has to fix the dispatch:
 * the differing paths, the last echo, and the likely defect class.
 */

import type { DocHandle } from "./doc";
import type { Op } from "./op";
import { escapeToken } from "./op";
import type { Sql } from "./pg";

export interface LawDrive<T> {
  /** An OPEN client doc over the real wire — remote.doc(name). */
  handle: DocHandle<T>;
  /** Its doc name: the recompute door is doc_open(name), composed as the
   *  host (001's NULL-user rule) — the same full copy the host broadcasts. */
  name: string;
  sql: Sql;
  /** One entry per dispatch branch: the ops to send, or a function of the
   *  current data (later batches usually need ids earlier echoes minted). */
  batches: Array<Op[] | ((data: T) => Op[])>;
  /** Docs this type mirrors into. Their client copies must converge to
   *  their own recompute after every batch — delivery is pgSync's, so the
   *  test must be running it (0.6.0: sync is the delivery path for every
   *  commit made outside a doc's own write hook). */
  mirrors?: Array<{ name: string; handle: DocHandle<any> }>;
  /** Wire undo — (v?) => remote.call("undo", { doc: name, v }) with pgUndo
   *  registered. Each batch is undone, checked, redone, checked. A type
   *  that records no undo (mine_apply-style) skips gracefully on the first
   *  refusal. */
  undo?: (v?: number) => Promise<unknown>;
  /** Per-wait timeout (echo, mirror convergence). Default 2000. */
  timeoutMs?: number;
}

/** One point of divergence between the client copy and the recompute. */
export interface Divergence {
  path: string;
  client: unknown;
  recompute: unknown;
}

/** Structural equality over wire data (JSON shapes). A key holding
 *  undefined equals a missing key — JSON has no undefined. */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEquals((a as any)[k], (b as any)[k])) return false;
  }
  return true;
}

/** Every path where the two copies disagree, as JSON Pointers. `client`
 *  or `recompute` is undefined where one side lacks the path entirely. */
export function diff(client: unknown, recompute: unknown, base = ""): Divergence[] {
  if (deepEquals(client, recompute)) return [];
  const container = (v: unknown) => v !== null && typeof v === "object";
  if (!container(client) || !container(recompute) ||
      Array.isArray(client) !== Array.isArray(recompute)) {
    return [{ path: base, client, recompute }];
  }
  const out: Divergence[] = [];
  const keys = new Set([...Object.keys(client as object), ...Object.keys(recompute as object)]);
  for (const k of keys) {
    const a = (client as any)[k];
    const b = (recompute as any)[k];
    if (a === undefined && b === undefined) continue;
    const p = `${base}/${escapeToken(k)}`;
    if (a === undefined || b === undefined) out.push({ path: p, client: a, recompute: b });
    else out.push(...diff(a, b, p));
  }
  return out;
}

/** Name the likely defect class for each shape of divergence — written for
 *  the reader who has to fix the dispatch, not for a log file. */
export function classify(diffs: Divergence[], echo: Op[]): string[] {
  const hints = new Set<string>();
  for (const d of diffs) {
    if (d.recompute === undefined) {
      // The client holds state the tables no longer have.
      hints.add(echo.some((o) => o.op === "remove")
        ? "the tables lost state no op expressed — an FK cascade is invisible to the op log; " +
          "expand it with doc_cascade_remove BEFORE deleting the parent (kit rule)"
        : "the client holds state a recompute cannot see — did the echo carry a value the DML never wrote?");
    } else if (d.client === undefined) {
      hints.add("the tables hold state the op stream never delivered — a column the DML set " +
        "(a default, a stamp, a mirror) that no echo carried; widen the echo to the whole row");
    } else {
      // Both present, values disagree. If the diff sits BESIDE an echoed
      // path under the same row, the op changed more columns than it said.
      const parent = d.path.slice(0, d.path.lastIndexOf("/"));
      const sibling = parent !== "" &&
        echo.some((o) => o.path !== d.path && o.path.startsWith(parent + "/"));
      hints.add(sibling
        ? "an op changed more columns than its path says (a stamp, a computed field) — " +
          "its echo must widen to the whole row (see 100-board.sql's done branch)"
        : "the echoed value disagrees with the composed one — echo what the DML actually " +
          "wrote (RETURNING the row), not the input");
    }
  }
  return [...hints];
}

const show = (v: unknown) => (v === undefined ? "(absent)" : JSON.stringify(v));

function violation(doc: string, context: string, diffs: Divergence[], echo: Op[]): Error {
  const listed = diffs.slice(0, 6)
    .map((d) => `  ${d.path || "(root)"}: client ${show(d.client)} ≠ recompute ${show(d.recompute)}`);
  if (diffs.length > 6) listed.push(`  … and ${diffs.length - 6} more`);
  return new Error(
    `[epsilon/law] ${doc} violates the law ${context}: the client copy no longer equals ` +
    `doc_open composed from the tables.\n${listed.join("\n")}\n` +
    classify(diffs, echo).map((h) => `hint: ${h}`).join("\n") +
    (echo.length ? `\nlast echo: ${JSON.stringify(echo)}` : "") +
    `\nThe law: ops are the fast path; recompute-from-state must always be correct on its own (DESIGN.md).`,
  );
}

const describeOps = (ops: Op[]) => ops.map((o) => `${o.op} ${o.path}`).join(", ");

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`[epsilon/law] timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function proveLaw<T>(drive: LawDrive<T>): Promise<void> {
  const { handle, name, sql } = drive;
  const timeoutMs = drive.timeoutMs ?? 2000;
  await handle.ready;

  // The resolved echo, captured as it lands — what the diagnosis quotes.
  let echo: Op[] = [];
  const off = handle.onOps((ops) => { echo = ops; });   // always Op[]; see signal.ts

  const recompute = async (doc: string): Promise<unknown> => {
    const [row] = await sql`SELECT doc_open(${doc}) AS d`;
    return row?.d ?? null;
  };

  const check = async (context: string): Promise<void> => {
    const composed = await recompute(name);
    const diffs = diff(handle.peek(), composed);
    if (diffs.length) throw violation(name, context, diffs, echo);
    for (const m of drive.mirrors ?? []) {
      // The mirror committed in the batch's own transaction; only DELIVERY
      // to its hosted signal is async (pgSync). Wait for convergence.
      const target = await recompute(m.name);
      try {
        await until(() => deepEquals(m.handle.peek(), target), timeoutMs, `mirror ${m.name}`);
      } catch {
        throw violation(m.name,
          `${context} — the mirror never converged (mirrors deliver through pgSync; is it running?)`,
          diff(m.handle.peek(), target), echo);
      }
    }
  };

  // Wait for the next commit's echo. A batch that never echoes was refused —
  // write errors surface on connect()'s onError, not on the promise.
  const echoOf = async (after: number, what: string): Promise<void> => {
    await until(() => handle.v > after, timeoutMs,
      `the echo ${what} (never landed — was the write refused? check connect()'s onError)`);
  };

  try {
    await check("before any batch");
    let undo = drive.undo;
    for (let i = 0; i < drive.batches.length; i++) {
      const entry = drive.batches[i]!;
      const ops = typeof entry === "function" ? entry(handle.peek() as T) : entry;
      const label = `batch ${i + 1} (${describeOps(ops)})`;
      const sent = handle.v;
      handle.apply(ops);
      await echoOf(sent, `of ${label}`);
      await check(`after ${label}`);

      if (undo) {
        const v = handle.v;
        try {
          await undo(v);
        } catch (err) {
          // A type that opts out of undo (records NULL) is not a violation.
          if (/no undo recorded|nothing to undo/.test(String(err))) { undo = undefined; continue; }
          throw err;
        }
        await echoOf(v, `of undoing ${label}`);
        await check(`after undoing ${label}`);
        const redoFrom = handle.v;
        await undo();               // my latest undoable = the undo — the redo
        await echoOf(redoFrom, `of redoing ${label}`);
        await check(`after redoing ${label}`);
      }
    }
  } finally {
    off();
  }
}
