/**
 * Routes — the hash router, ported from railroad (0.11.0) whole.
 *
 * This file pays the MEDIUM tax: the browser's history is a platform fact and
 * something has to shim it. Nothing here knows about ops, docs or Postgres —
 * it is signals over `location.hash`, and that is the entire dependency.
 *
 * Why hash and not the History API: epsilon serves its own HTML from
 * `Bun.serve`, so a History-mode router would need a catch-all route on every
 * deployment and a rewrite rule on every static host that fronts one. Hash
 * costs neither and works the day you scaffold. A shared link is still a real
 * URL — `https://app/#/trip/5` — and still resolves cold.
 *
 *   routes(target, table)       — declarative router, swaps target's content
 *   route<T>(pattern)           — reactive route: Signal<T | null>, null unmatched
 *   navigate(path)              — set location.hash programmatically
 *   matchRoute(pattern, path)   — the pure matcher; params or null
 *
 * Patterns:
 *   "/users/:id"     — named params, exact segment match
 *   "/sites/*"       — wildcard, matches /sites and /sites/any/depth
 *   "/sites/:id/*"   — params + wildcard, rest captured as params["*"]
 *
 * Patterns are tested in declaration order; first match wins. Declare specific
 * routes before parameterised ones (`/users/new` before `/users/:id`).
 *
 * Matching is purely segment-based — there is no query-string handling. A hash
 * of "#/users/42?tab=1" matches "/users/:id" with id === "42?tab=1" (split on
 * "?" yourself if you need it), and a trailing slash is a real empty segment:
 * "/users/42/" does NOT match "/users/:id".
 *
 * Handlers receive (params, params$) and return a Node, or a Promise of a Node
 * or of a THUNK (() => Node). Async handlers should resolve to the thunk form:
 * the router runs the thunk under a scope it owns, so reactive bindings built
 * after the first await are disposed on navigation. A bare Promise<Node> still
 * renders, but its post-await bindings have no owner scope (browser JS has no
 * AsyncContext) and outlive the route — the LIFETIME tax, unpaid.
 *   params  — plain object for destructuring: ({ id }) => ...
 *   params$ — Signal that updates when params change within the same pattern
 *
 * Cleanup is the router's job. When params change within the same pattern
 * (/users/1 → /users/2), params$ updates — no teardown, no re-render. That
 * matters here more than it did in railroad: a route that opens a doc should
 * open it ONCE and let the lens follow params$, not close and re-open the
 * socket's subscription on every id change.
 *
 * Nested routes — use a wildcard to keep a layout mounted:
 *   routes(app, {
 *     "/":        () => Home(),
 *     "/trips/*": () => TripsLayout(),
 *   });
 *   // Inside TripsLayout, use route() for sub-navigation:
 *   const detail = route("/trips/:id");
 *
 * Both routes() and route() auto-track in the parent dispose scope, so nested
 * routing cleans up when the parent tears down.
 *
 * route() at module level (outside any dispose scope) is SUPPORTED: the signal
 * and its share of the hashchange listener live for the app's lifetime, which
 * is what module scope means. That is why route() doesn't warn when scopeless
 * the way a DOM-producing helper would — for those, scopeless is almost always
 * a leak; for route() it is a legitimate app-lifetime binding.
 */

import {
  Signal, signal, computed, effect,
  pushDisposeScope, popDisposeScope, trackDispose,
} from "./signal";
import type { Dispose, ReadonlySignal } from "./signal";

let hashSignal: Signal<string> | null = null;
let hashListenerCount = 0;
let hashListener: (() => void) | null = null;

function getHash(): Signal<string> {
  if (!hashSignal) {
    hashSignal = new Signal(location.hash.slice(1) || "/");
    hashListener = () => {
      hashSignal!.set(location.hash.slice(1) || "/");
    };
    window.addEventListener("hashchange", hashListener);
  }
  hashListenerCount++;
  return hashSignal;
}

function releaseHash(): void {
  hashListenerCount--;
  if (hashListenerCount === 0 && hashListener) {
    window.removeEventListener("hashchange", hashListener);
    hashListener = null;
    hashSignal = null;
  }
}

export function matchRoute(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const pp = pattern.split("/");
  const hp = path.split("/");
  const isWild = pp.length > 0 && pp[pp.length - 1] === "*";

  if (isWild) {
    if (hp.length < pp.length - 1) return null;
  } else {
    if (pp.length !== hp.length) return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i] === "*") {
      params["*"] = hp.slice(i).map((s) => {
        try { return decodeURIComponent(s); } catch { return s; }
      }).join("/");
      return params;
    } else if (pp[i]!.startsWith(":")) {
      // A malformed percent-escape must not silently un-match the route.
      // Fall back to the raw segment, consistent with the wildcard branch.
      try {
        params[pp[i]!.slice(1)] = decodeURIComponent(hp[i]!);
      } catch {
        params[pp[i]!.slice(1)] = hp[i]!;
      }
    } else if (pp[i] !== hp[i]) return null;
  }
  return params;
}

export function route<
  T extends Record<string, string> = Record<string, string>,
>(pattern: string): ReadonlySignal<T | null> {
  const hash = getHash();
  // Idempotent release — disposing the scope more than once must not drive the
  // shared hashListenerCount negative and tear the listener out from under
  // other live routers.
  let released = false;
  trackDispose(() => {
    if (released) return;
    released = true;
    releaseHash();
  });
  return computed(() => matchRoute(pattern, hash.get()) as T | null);
}

export function navigate(path: string): void {
  location.hash = path;
}

type RouteHandler = (
  params: Record<string, string>,
  params$: Signal<Record<string, string>>,
) => Node | Promise<Node | (() => Node)>;

export interface RouterOptions {
  onError?: (err: unknown) => Node | void;
}

export function routes(
  target: HTMLElement,
  table: Record<string, RouteHandler>,
  options?: RouterOptions,
): Dispose {
  const hash = getHash();
  let activePattern: string | null = null;
  let activeParams: Signal<Record<string, string>> | null = null;
  let activeDispose: Dispose | null = null;
  let runId = 0;
  let asyncPending = false;

  function teardown() {
    // Bumping runId invalidates any in-flight async render: when its promise
    // settles, the myRunId !== runId guard disposes that render's own scope.
    runId++;
    asyncPending = false;
    if (activeDispose) activeDispose();
    activeDispose = null;
    activePattern = null;
    activeParams = null;
    target.replaceChildren();
  }

  // Route the error through onError (if present) or console.error. Used by both
  // the sync-throw and async-reject paths so they behave identically — and so a
  // throwing onError can never escape as an unhandled rejection.
  function handleError(err: unknown): boolean {
    if (options?.onError) {
      try {
        const fallback = options.onError(err);
        if (fallback instanceof Node) {
          target.appendChild(fallback);
          return true;
        }
      } catch (boundaryErr) {
        console.error("[epsilon/route] onError boundary threw:", boundaryErr);
        return true;
      }
    }
    return false;
  }

  function run(handler: RouteHandler, params: Record<string, string>) {
    const myRunId = ++runId;
    activeParams = signal(params);

    // Always pop the scope synchronously before run() returns — never leave it
    // pushed across an await. Otherwise an async first render returns with the
    // global dispose stack imbalanced, so a parent scope pops the wrong scope
    // (leaking its own disposers) and the resolving .then() captures the parent
    // scope into activeDispose, recursing into a stack overflow on teardown.
    pushDisposeScope();
    let result: Node | Promise<Node | (() => Node)>;
    try {
      result = handler(params, activeParams);
    } catch (err) {
      // Synchronous throw — pop+dispose the children created so far so the
      // stack stays balanced, then route through the error boundary.
      popDisposeScope()();
      activePattern = null;
      activeParams = null;
      if (handleError(err)) return;
      throw err;
    }
    // No synchronous throw: pop now (balanced) and capture the disposer.
    const scopeDispose = popDisposeScope();

    if (result instanceof Promise) {
      asyncPending = true;
      result.then(
        (resolved) => {
          if (myRunId !== runId) {
            scopeDispose(); // navigated away during await — drop orphaned children
            return;
          }
          asyncPending = false;
          if (typeof resolved === "function") {
            // Thunk resolution — the owner scope for post-await bindings. A
            // bare Node resolution stays supported, but anything reactive it
            // created after the first await is ownerless (browser JS has no
            // AsyncContext to carry the scope across an await); resolve to a
            // thunk so the router can bracket its construction.
            pushDisposeScope();
            let built: unknown;
            let thrown: unknown;
            let didThrow = false;
            try {
              built = resolved();
            } catch (err) {
              didThrow = true;
              thrown = err;
            }
            const thunkDispose = popDisposeScope();
            if (didThrow || !(built instanceof Node)) {
              thunkDispose();
              scopeDispose();
              activePattern = null;
              activeParams = null;
              const err = didThrow
                ? thrown
                : new Error("[epsilon/route] async handler thunk returned a non-Node");
              if (handleError(err)) return;
              console.error("[epsilon/route] async handler thunk failed:", err);
              return;
            }
            const preAwaitDispose = scopeDispose;
            activeDispose = () => {
              thunkDispose();
              preAwaitDispose();
            };
            target.appendChild(built);
            return;
          }
          activeDispose = scopeDispose;
          target.appendChild(resolved);
        },
        (err) => {
          if (myRunId !== runId) {
            scopeDispose();
            return;
          }
          asyncPending = false;
          scopeDispose();
          activePattern = null;
          activeParams = null;
          if (handleError(err)) return;
          console.error("[epsilon/route] async handler rejected:", err);
        },
      );
    } else {
      activeDispose = scopeDispose;
      target.appendChild(result);
    }
  }

  // Register the outer dispose into the caller's scope BEFORE creating the
  // effect, so dispose lands in the caller's scope (not the router's own
  // internal one). run() keeps the dispose stack balanced across async first
  // renders, so this is now purely about attributing dispose to the right scope.
  let disposeEffect: Dispose | null = null;
  let disposed = false;
  const dispose = () => {
    // Idempotent — calling dispose() more than once (or via both the returned
    // handle and a parent scope) must release the shared hash refcount exactly
    // once, or it goes negative and detaches the listener from other routers.
    if (disposed) return;
    disposed = true;
    if (disposeEffect) disposeEffect();
    teardown();
    releaseHash();
  };
  trackDispose(dispose);

  disposeEffect = effect(() => {
    const path = hash.get();
    for (const [pattern, handler] of Object.entries(table)) {
      const params = matchRoute(pattern, path);
      if (params) {
        if (pattern === activePattern) {
          // Same pattern, different params. If a render for the OLD params is
          // still in flight, updating the signal alone would let the stale
          // resolution paint outdated content (and a handler that captured the
          // initial `params` arg would never refresh) — so invalidate it with a
          // full teardown + re-run. Otherwise just push the new params.
          if (asyncPending) {
            teardown();
            activePattern = pattern;
            try {
              run(handler, params);
            } catch (err) {
              console.error("[epsilon/route] handler threw:", err);
            }
            return;
          }
          activeParams!.set(params);
          return;
        }
        teardown();
        activePattern = pattern;
        try {
          run(handler, params);
        } catch (err) {
          // Handler errors must not kill the router or leak the dep set on
          // the hash signal. run()'s try/catch already balanced the dispose
          // stack and reset state — surface the error so it's visible.
          console.error("[epsilon/route] handler threw:", err);
        }
        return;
      }
    }
    teardown();
  });

  return dispose;
}
