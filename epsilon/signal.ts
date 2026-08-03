/**
 * Signal — the op-carrying signal. The delta IS the signal.
 *
 * Two channels per signal:
 *   state — effects/computeds re-run on change and recompute from value.
 *           ALWAYS correct on its own; ops are never required (the law).
 *   ops   — onOps(handler) receives the exact change as Op[] (or undefined,
 *           meaning "recompute"). Routing consumers (keyed lists, DOM
 *           patchers) use this to skip diffing entirely.
 *
 * Core API:
 *   signal(v, opts?)       — create
 *   s.get / peek / set / update / map
 *   s.apply(ops)           — mutate in place + notify BOTH channels with ops
 *   s.onOps(fn)            — subscribe to the op stream; scope-disposed
 *   s.at(path)             — composing lens: narrowed value + rebased ops
 *   computed / effect — as railroad (state channel only)
 *
 * Ordering: within one apply(), ops handlers run first (routers see the
 * change before state effects recompute), then the state flush. batch()
 * coalesces the state flush; ops delivery stays per-apply (routing needs
 * every step, in order).
 *
 * Flush scheduler, effect, computed, and dispose scopes are
 * adapted from @blueshed/railroad signals.ts (glitch-free topological
 * propagation). applyOps/valueAt from @blueshed/delta core.ts via ./op.
 */

import { applyOp, valueAt, splitPath, type Op } from "./op";

type Listener = (() => void) & { level?: number };
type OpsHandler = (ops: Op[] | undefined) => void;

let currentListener: Listener | null = null;
let currentDeps: Set<Signal<any>> | null = null;
let batchDepth = 0;
const pendingEffects = new Set<Listener>();

// === Flush scheduler (railroad's, verbatim in behavior) ===

const MAX_RUNS_PER_LISTENER = 100;

interface Flush {
  buckets: (Listener[] | undefined)[];
  queued: Set<Listener>;
  runs: Map<Listener, number>;
}

let activeFlush: Flush | null = null;

function enqueue(flush: Flush, listeners: Iterable<Listener>): void {
  for (const l of listeners) {
    if (flush.queued.has(l)) continue;
    flush.queued.add(l);
    const lv = l.level ?? 0;
    (flush.buckets[lv] ??= []).push(l);
  }
}

function drain(flush: Flush): void {
  let firstError: unknown;
  let hasError = false;
  for (;;) {
    let lv = -1;
    for (let i = 0; i < flush.buckets.length; i++) {
      if (flush.buckets[i]?.length) { lv = i; break; }
    }
    if (lv === -1) break;
    const bucket = flush.buckets[lv]!;
    flush.buckets[lv] = undefined;
    for (const l of bucket) {
      flush.queued.delete(l);
      const n = (flush.runs.get(l) ?? 0) + 1;
      if (n > MAX_RUNS_PER_LISTENER) {
        throw new Error("Maximum effect depth exceeded — possible infinite loop");
      }
      flush.runs.set(l, n);
      try {
        l();
      } catch (err) {
        if (!hasError) { hasError = true; firstError = err; }
      }
    }
  }
  if (hasError) throw firstError;
}

function scheduleListeners(listeners: Iterable<Listener>): void {
  if (activeFlush) {
    enqueue(activeFlush, listeners);
    return;
  }
  const flush: Flush = { buckets: [], queued: new Set(), runs: new Map() };
  enqueue(flush, listeners);
  activeFlush = flush;
  try {
    drain(flush);
  } finally {
    activeFlush = null;
  }
}

// === Options ===

export interface SignalOptions<T> {
  equals?: (a: T, b: T) => boolean;
}

// === ReadonlySignal ===

export interface ReadonlySignal<T> {
  get(): T;
  peek(): T;
  map<U>(fn: (value: T) => U, options?: SignalOptions<U>): ReadonlySignal<U>;
}

// === OpSignal — the surface shared by Signal and Lens ===

export interface OpSignal<T> extends ReadonlySignal<T> {
  set(value: T): void;
  update(fn: (current: T) => T): void;
  apply(ops: Op[]): void;
  /** Subscribe to the op stream. undefined = recompute from state. Returns
   *  unsubscribe; auto-disposed when created inside a dispose scope. */
  onOps(handler: OpsHandler): () => void;
  /** Composing lens: at("/a").at("/b") ≡ at("/a/b"). */
  at<U = unknown>(path: string): OpSignal<U>;
}

// === Signal ===

export class Signal<T> implements OpSignal<T> {
  private value: T;
  private listeners = new Set<Listener>();
  private opsHandlers = new Set<OpsHandler>();
  private equalsFn: (a: unknown, b: unknown) => boolean;
  /** Topological depth for the flush scheduler. @internal */
  level = 0;

  constructor(initialValue: T, options?: SignalOptions<T>) {
    this.value = initialValue;
    this.equalsFn = (options?.equals ?? Object.is) as (a: unknown, b: unknown) => boolean;
  }

  get(): T {
    if (currentListener) this.listeners.add(currentListener);
    if (currentDeps) currentDeps.add(this);
    return this.value;
  }

  peek(): T {
    return this.value;
  }

  set(newValue: T): void {
    if (this.equalsFn(this.value, newValue)) return;
    // Route through apply() — the ONE write path. Subclasses that redirect
    // apply() (a remote doc sending ops over the wire) get set() for free.
    this.apply([{ op: "replace", path: "", value: newValue }]);
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this.value));
  }

  /**
   * Apply ops: mutate the value IN PLACE (deep paths; the ref stays stable),
   * or reassign it (root path ""), then notify both channels with the ops.
   * No equality gate — an op is an assertion of change.
   *
   * ATOMIC: a throw mid-batch unwinds the applied prefix and notifies
   * NOTHING — the value never diverges from what subscribers saw. This
   * matches the relational tier, where the stored function's transaction
   * rolls the whole batch back.
   */
  apply(ops: Op[]): void {
    const undos: (() => void)[] = [];
    try {
      for (const op of ops) {
        if (splitPath(op.path).length === 0) {
          // Root op — the signal owns its value, so reassignment is correct
          // here (delta's in-place root semantics existed for shared doc refs).
          const prev = this.value;
          undos.push(() => { this.value = prev; });
          if (op.op === "remove") this.value = undefined as T;
          else this.value = (op as { value: unknown }).value as T;
        } else {
          undos.push(applyOp(this.value, op));
        }
      }
    } catch (err) {
      for (let i = undos.length - 1; i >= 0; i--) undos[i]!();
      throw err;
    }
    this.notify(ops);
  }

  map<U>(fn: (value: T) => U, options?: SignalOptions<U>): ReadonlySignal<U> {
    return computed(() => fn(this.get()), options);
  }

  onOps(handler: OpsHandler): () => void {
    this.opsHandlers.add(handler);
    const unsub = () => { this.opsHandlers.delete(handler); };
    trackDispose(unsub);
    return unsub;
  }

  at<U = unknown>(path: string): OpSignal<U> {
    return new Lens<U>(this as Signal<any>, normalizePrefix(path));
  }

  /** Deliver ops (handlers first, error-isolated), then flush state. @internal */
  private notify(ops: Op[] | undefined): void {
    for (const h of this.opsHandlers) {
      try { h(ops); }
      catch (err) { console.error("[epsilon/signal] onOps handler threw:", err); }
    }
    if (this.listeners.size === 0) return;
    if (batchDepth > 0) {
      for (const l of this.listeners) pendingEffects.add(l);
      return;
    }
    scheduleListeners(this.listeners);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }
}

// === Lens — a narrowed, composing view. Same surface, no stored value. ===

function normalizePrefix(path: string): string {
  if (!path.startsWith("/") || path === "/") {
    throw new Error(`[epsilon/signal] at() takes a non-root pointer starting with "/": got ${JSON.stringify(path)}`);
  }
  return path;
}

class Lens<T> implements OpSignal<T> {
  // Always rooted at a real Signal with a combined prefix, so composition is
  // associative by construction: at("/a").at("/b") stores root + "/a/b".
  constructor(
    private root: Signal<any>,
    private prefix: string,
  ) {}

  /** Bumped only when an op TOUCHES this slice — the same test onOps applies.
   *  Created on first tracked read, so an untracked peek()/set() lens costs
   *  nothing. */
  private tick: Signal<number> | null = null;

  get(): T {
    // Track THIS SLICE, not the root. onOps already knows precisely which ops
    // reach here — it rebases descendants, collapses ancestor writes, and
    // skips siblings — so the ops channel's precision drives the state
    // channel too. Before 0.9.0 this delegated to root.get(), which meant an
    // effect over a lens re-ran on every unrelated write: correct, never
    // minimal, and the reason bind() existed at all.
    if (!this.tick) {
      const t = (this.tick = new Signal(0));
      const unsub = this.onOps(() => t.set(t.peek() + 1));
      if (hasActiveDisposeScope()) trackDispose(unsub);
      else {
        console.warn(
          "[epsilon/signal] a lens was read reactively outside a dispose scope — " +
            "its subscription can never be torn down. Read it inside a list() row, " +
            "a routes() handler, or mount().",
        );
      }
    }
    this.tick.get();                       // the dependency
    return valueAt(this.root.peek(), this.prefix) as T;
  }

  peek(): T {
    return valueAt(this.root.peek(), this.prefix) as T;
  }

  set(value: T): void {
    this.root.apply([{ op: "replace", path: this.prefix, value }]);
  }

  update(fn: (current: T) => T): void {
    this.set(fn(this.peek()));
  }

  apply(ops: Op[]): void {
    this.root.apply(ops.map((op) => ({ ...op, path: this.prefix + op.path })));
  }

  map<U>(fn: (value: T) => U, options?: SignalOptions<U>): ReadonlySignal<U> {
    return computed(() => fn(this.get()), options);
  }

  onOps(handler: OpsHandler): () => void {
    const childPrefix = this.prefix + "/";
    return this.root.onOps((ops) => {
      if (ops === undefined) return handler(undefined);
      const rebased: Op[] = [];
      let ancestorHit = false;
      for (const op of ops) {
        if (op.path === this.prefix) {
          rebased.push({ ...op, path: "" });
        } else if (op.path.startsWith(childPrefix)) {
          rebased.push({ ...op, path: op.path.slice(this.prefix.length) });
        } else if (op.path === "" || this.prefix.startsWith(op.path + "/")) {
          // A write ABOVE this lens may have replaced the whole slice —
          // collapse to one synthetic root-replace of the current value.
          ancestorHit = true;
        }
        // Unrelated sibling paths: skipped — this is the precision that
        // motivates epsilon.
      }
      if (ancestorHit) {
        rebased.push({ op: "replace", path: "", value: this.peek() });
      }
      if (rebased.length) handler(rebased);
    });
  }

  at<U = unknown>(path: string): OpSignal<U> {
    return new Lens<U>(this.root, this.prefix + normalizePrefix(path));
  }
}

// === effect / dispose scopes / computed (railroad's) ===

export type Dispose = () => void;

const disposeStack: Dispose[][] = [];

export function pushDisposeScope(): void {
  disposeStack.push([]);
}

export function popDisposeScope(): Dispose {
  const disposers = disposeStack.pop();
  if (!disposers) {
    throw new Error("popDisposeScope called with no active scope — push/pop imbalance");
  }
  return () => disposers.forEach((d) => d());
}

export function trackDispose(d: Dispose): void {
  const scope = disposeStack[disposeStack.length - 1];
  if (scope) scope.push(d);
}

export function hasActiveDisposeScope(): boolean {
  return disposeStack.length > 0;
}

export function effect(fn: () => void | (() => void)): () => void {
  let cleanup: (() => void) | void;
  let deps = new Set<Signal<any>>();
  let disposed = false;

  const execute: Listener = () => {
    if (disposed) return;
    if (cleanup) cleanup();

    const prevListener = currentListener;
    const prevDeps = currentDeps;
    const nextDeps = new Set<Signal<any>>();
    currentListener = execute;
    currentDeps = nextDeps;

    try {
      cleanup = fn();
    } finally {
      currentListener = prevListener;
      currentDeps = prevDeps;
      for (const dep of deps) {
        if (!nextDeps.has(dep)) dep.unsubscribe(execute);
      }
      deps = nextDeps;
      let lv = 0;
      for (const dep of deps) if (dep.level >= lv) lv = dep.level + 1;
      execute.level = lv;
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (cleanup) cleanup();
    for (const dep of deps) dep.unsubscribe(execute);
    deps.clear();
  };

  trackDispose(dispose);
  execute();

  return dispose;
}

export function computed<T>(
  fn: () => T,
  options?: SignalOptions<T>,
): ReadonlySignal<T> {
  let s!: Signal<T>;
  effect(() => {
    const v = fn();
    let lv = 0;
    for (const dep of currentDeps!) if (dep.level >= lv) lv = dep.level + 1;
    if (s) {
      s.level = lv;
      s.set(v);
    } else {
      s = new Signal<T>(v, options);
      s.level = lv;
    }
  });
  return s;
}


export function signal<T>(initialValue: T, options?: SignalOptions<T>): Signal<T> {
  return new Signal(initialValue, options);
}

/**
 * Coalesce writes across SEVERAL signals so dependent effects run once.
 *
 *   batch(() => { me.set(user); refused.set(""); });
 *
 * Removed in 0.9.0 on the grounds that `apply(ops[])` already batches "the
 * only channel an app writes through" — which was wrong. An app also holds
 * plain local signals, and two `.set()` calls on two DIFFERENT signals are
 * not ops on one doc; nothing else coalesces them. Restored in 0.9.1 when
 * the upgrade broke exactly that call in the field.
 */
export function batch(fn: () => void): void {
  let flushError: unknown;
  let flushThrew = false;
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && pendingEffects.size > 0) {
      const pending = [...pendingEffects];
      pendingEffects.clear();
      if (activeFlush) {
        enqueue(activeFlush, pending);
      } else {
        try {
          scheduleListeners(pending);
        } catch (err) {
          flushThrew = true;
          flushError = err;
        }
      }
    }
  }
  if (flushThrew) throw flushError;
}
