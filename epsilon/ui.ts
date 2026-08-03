/**
 * UI — ops to pixels. THREE primitives, no diffing.
 *
 *   text(sig)          — a Text node an effect keeps current.
 *   list(sig, render)  — a keyed region that routes MEMBERSHIP ops only:
 *                        add → create row, remove → drop row, root → reconcile
 *                        key sets. Field and row-content ops never touch
 *                        list() at all — each row renders from its own at()
 *                        lens. list() is ~a routing table; the lens is the
 *                        update path.
 *   mount(target, fn)  — the app root: brackets a dispose scope around fn so
 *                        the scope rules hold all the way down, and returns
 *                        the disposer that unwinds it.
 *
 * There is no bind(). Until 0.9.0 a lens's get() tracked the ROOT, so an
 * effect over a lens re-ran on every unrelated write — correct but never
 * minimal — and bind() existed to buy back the precision the ops channel
 * already had. The only production app answered that with 116 effects and
 * zero binds, because the imprecise path was the cheap one. 0.9.0 narrowed
 * Lens.get() to track its own slice instead, so `effect(() => …lens.get())`
 * IS the precise scalar path, and bind() had nothing left to do.
 *
 * There is no when() either — it shipped in 0.8.0, was never prescribed
 * anywhere, and had no consumer in any app by 0.9.0.
 *
 * Identity: rows are keyed by the collection's own ids (Record<string, T>) —
 * minted by the store, carried through the ops, never guessed. Order is
 * arrival order; position is model data (see DESIGN.md non-goals).
 *
 * mount() is a port from railroad (0.11.0).
 *
 * SVG: every region here works inside <svg> — japan draws seventy stations
 * through list() — because a caller building rows with createElementNS hands
 * us nodes that are already in the right namespace. What epsilon does NOT do
 * is railroad's silent adoption pass. That shim exists for JSX, which emits
 * createElement("circle") and must repair the namespace afterwards; repairing
 * means RECREATING the element, and railroad can only get away with it
 * because its props system re-applies every reactive binding to the new node.
 * Epsilon has no props system: a recreate here would silently drop whatever
 * the caller attached by hand — addEventListener above all. Losing a click
 * handler is a worse failure than the one being fixed, so instead an element
 * that lands in an SVG parent in the wrong namespace is REPORTED, with the
 * fix, the same way a scopeless binding is. See DESIGN.md, the medium tax.
 */

import {
  effect, computed, trackDispose, pushDisposeScope, popDisposeScope, hasActiveDisposeScope,
  type OpSignal, type ReadonlySignal, type Dispose,
} from "./signal";
import { splitPath, escapeToken } from "./op";

/** Shared guardrail: when()/list() return DOM nodes, not disposers, so outside
 *  a dispose scope their effects are unreachable — a guaranteed leak the first
 *  time the UI unmounts. */
function warnScopeless(helper: string): void {
  console.warn(
    `[epsilon/ui] ${helper}() created outside a dispose scope — its effects ` +
      "can never be torn down. Render it inside a list() row, a routes() " +
      "handler, or mount().",
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An HTML-namespaced element inside <svg> renders as nothing — the browser
 *  keeps it in the tree and never paints it, which is why this is worth a word
 *  rather than a silent nothing. Costs one namespaceURI compare on the parent
 *  unless you are actually rendering into SVG. <foreignObject> is the one SVG
 *  element whose children ARE html, so adoption stops there. */
function checkSvgNamespace(helper: string, nodes: Node[], parent: Node | null): void {
  if (
    !(parent instanceof Element) ||
    parent.namespaceURI !== SVG_NS ||
    parent.localName === "foreignObject"
  ) return;
  for (const n of nodes) {
    if (n instanceof Element && n.namespaceURI !== SVG_NS) {
      console.warn(
        `[epsilon/ui] ${helper}() inserted <${n.localName}> into <${parent.localName}>, ` +
          "but it was built with document.createElement, so it is an HTML " +
          "element in an SVG parent and will never paint. Build it with " +
          `document.createElementNS("${SVG_NS}", "${n.localName}"). ` +
          "Nothing is rewritten for you — that would mean recreating the node " +
          "and dropping any listener you attached.",
      );
      return; // one word per region is enough
    }
  }
}

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
  if (!hasActiveDisposeScope()) warnScopeless("list");
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
    checkSvgNamespace("list", nodes, anchor.parentNode);
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

  // The anchor is parented by this fragment from birth, so addRow ALWAYS has
  // a parent to insert into — rows created before the caller appends ride
  // the fragment into the document; nothing can drop. First paint defers a
  // microtask so a synchronous caller has appended by then and initial rows
  // go straight into the live DOM; a doc that opens later paints via its
  // snapshot op (reconcile above).
  const frag = document.createDocumentFragment();
  frag.appendChild(anchor);
  queueMicrotask(() => { if (!disposed && sig.peek() != null) reconcile(); });
  return frag;
}

/**
 * The app root. Brackets a dispose scope around `render` so everything it
 * creates — effects, binds, lists, whens — tears down when the returned
 * disposer runs, which also removes the rendered nodes.
 *
 *   const dispose = mount(document.getElementById("app")!, () => App());
 *
 * Use this (or routes(), which brackets its own per-handler scopes) for an
 * app root. Without one, a top-level bind()/list()/when() has no owner: that
 * is the warning they print, and this is the answer to it. Nested mounts
 * compose — the inner disposer is tracked in the outer scope.
 */
export function mount(target: Element, render: () => Node): Dispose {
  pushDisposeScope();
  let result: Node;
  try {
    result = render();
  } catch (err) {
    popDisposeScope()(); // dispose whatever was created before the throw
    throw err;
  }
  const scopeDispose = popDisposeScope();
  const nodes = result instanceof DocumentFragment ? [...result.childNodes] : [result];
  checkSvgNamespace("mount", nodes, target);
  target.appendChild(result);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    scopeDispose();
    for (const n of nodes) n.parentNode?.removeChild(n);
  };
  trackDispose(dispose); // nested mounts compose with an outer scope
  return dispose;
}
