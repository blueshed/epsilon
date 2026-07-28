/**
 * UI — ops to pixels. Two primitives, no diffing.
 *
 *   text(sig)          — a Text node an effect keeps current (state channel:
 *                        always correct, the fallback).
 *   list(sig, render)  — a keyed region that routes MEMBERSHIP ops only:
 *                        add → create row, remove → drop row, root → reconcile
 *                        key sets. Field and row-content ops never touch
 *                        list() at all — each row is rendered from its own
 *                        at() lens, so content updates flow through the lens
 *                        to whatever bindings the row made. list() is ~a
 *                        routing table; the lens is the update path.
 *
 * Identity: rows are keyed by the collection's own ids (Record<string, T>) —
 * minted by the store, carried through the ops, never guessed. Order is
 * arrival order; position is model data (see DESIGN.md non-goals).
 */

import {
  effect, trackDispose, pushDisposeScope, popDisposeScope, hasActiveDisposeScope,
  type OpSignal, type ReadonlySignal, type Dispose,
} from "./signal";
import { splitPath, escapeToken } from "./op";

/** A Text node kept current by an effect. */
export function text(sig: ReadonlySignal<unknown>): Text {
  const node = document.createTextNode("");
  effect(() => { node.textContent = String(sig.get() ?? ""); });
  return node;
}

export function list<T>(
  sig: OpSignal<Record<string, T> | null | undefined>,
  render: (row: OpSignal<T>, id: string) => Node,
): Node {
  if (!hasActiveDisposeScope()) {
    console.warn(
      "[epsilon/ui] list() created outside a dispose scope — its effects can never be torn down.",
    );
  }
  const anchor = document.createComment("list");
  const rows = new Map<string, { nodes: Node[]; dispose: Dispose }>();
  let disposed = false;

  function addRow(id: string): void {
    if (rows.has(id)) return;
    const lens = sig.at<T>(`/${escapeToken(id)}`);
    pushDisposeScope();
    let rendered: Node;
    let dispose: Dispose;
    try {
      rendered = render(lens, id);
    } finally {
      dispose = popDisposeScope(); // balanced even when render throws
    }
    const nodes = rendered instanceof DocumentFragment ? [...rendered.childNodes] : [rendered];
    anchor.parentNode?.insertBefore(rendered, anchor);
    rows.set(id, { nodes, dispose });
  }

  function removeRow(id: string): void {
    const row = rows.get(id);
    if (!row) return;
    row.dispose();
    for (const n of row.nodes) n.parentNode?.removeChild(n);
    rows.delete(id);
  }

  /** Root change (snapshot, reconnect, undefined ops): diff KEY SETS only.
   *  Surviving rows update themselves through their lenses — no rebuild. */
  function reconcile(): void {
    const value = sig.peek() ?? {};
    for (const id of [...rows.keys()]) {
      if (!(id in value)) removeRow(id);
    }
    for (const id of Object.keys(value)) addRow(id);
  }

  const unsub = sig.onOps((ops) => {
    if (disposed) return;
    if (ops === undefined) return reconcile();
    for (const op of ops) {
      const segs = splitPath(op.path);
      if (segs.length === 0) reconcile();                      // root replace/remove
      else if (segs.length === 1) {
        const id = segs[0]!;
        if (op.op === "remove") removeRow(id);
        else addRow(id);   // add — or a replace for a row we've never seen
      }
      // deeper paths: the row's lens delivers them; nothing for list() to do
    }
  });

  trackDispose(() => {
    disposed = true;
    unsub();
    for (const id of [...rows.keys()]) removeRow(id);
  });

  // First paint synchronously if data is already present; a doc that opens
  // later paints via its snapshot op (reconcile above). Rows created before
  // the fragment is appended land after the anchor is in the document — so
  // defer creation until the value exists AND the anchor has a parent.
  const frag = document.createDocumentFragment();
  frag.appendChild(anchor);
  queueMicrotask(() => { if (!disposed && sig.peek() != null) reconcile(); });
  return frag;
}
