// The router's contract. Ported with the router itself — the async scope
// balance and the stale-resolution guard are cases railroad found the hard
// way, and they are why this file was ported rather than rewritten. The
// refcount it also carried is gone (0.9.0): a page has one hash.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Same guard as ui.test.ts, and for the same reason: happy-dom replaces the
// networking globals, and the suites that follow this one in `bun run test`
// (cli, doc) talk to a real Bun.serve. Keep the native ones.
// Registration is also CONDITIONAL: `bun test` loads every file into one
// process, so ui.test.ts may have registered already and a second call throws.
if (typeof globalThis.document === "undefined") {
  const NativeWebSocket = globalThis.WebSocket;
  const nativeFetch = globalThis.fetch;
  GlobalRegistrator.register();
  globalThis.WebSocket = NativeWebSocket;
  globalThis.fetch = nativeFetch;
}

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { routes, route, navigate, matchRoute } from "./route";
import { effect } from "./signal";

function tick(): Promise<void> {
  // happy-dom dispatches `hashchange` on the next macrotask, not as a
  // microtask — a setTimeout(0) covers both.
  return new Promise((r) => setTimeout(r, 0));
}

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const el = (tag: string, text: string): HTMLElement => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};

beforeEach(() => {
  document.body.innerHTML = "";
  location.hash = "";
});

afterEach(() => {
  location.hash = "";
});

describe("matchRoute()", () => {
  test("exact, params, wildcard, and the non-matches", () => {
    expect(matchRoute("/about", "/about")).toEqual({});
    expect(matchRoute("/users/:id", "/users/42")).toEqual({ id: "42" });
    expect(matchRoute("/sites/*", "/sites")).toEqual({ "*": "" });
    expect(matchRoute("/sites/*", "/sites/a/b")).toEqual({ "*": "a/b" });
    expect(matchRoute("/users/:id", "/users/42/")).toBeNull();
    expect(matchRoute("/users/:id", "/about")).toBeNull();
  });

  test("percent-escapes decode; a malformed one falls back to raw", () => {
    expect(matchRoute("/t/:name", "/t/Kyoto%20Station")).toEqual({ name: "Kyoto Station" });
    expect(matchRoute("/t/:name", "/t/100%")).toEqual({ name: "100%" });
  });
});

describe("routes()", () => {
  test("renders the matching handler synchronously", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/about";
    await tick();

    const dispose = routes(target, {
      "/": () => el("div", "home"),
      "/about": () => el("div", "about"),
    });

    expect(target.textContent).toBe("about");
    dispose();
  });

  test("swaps content on hash change", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/";
    await tick();

    const dispose = routes(target, {
      "/": () => el("span", "home"),
      "/about": () => el("span", "about"),
    });
    expect(target.textContent).toBe("home");

    navigate("/about");
    await tick();
    expect(target.textContent).toBe("about");

    dispose();
  });

  test("clears target when no pattern matches", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/";
    await tick();

    const dispose = routes(target, { "/": () => el("p", "home") });
    expect(target.textContent).toBe("home");

    navigate("/nope");
    await tick();
    expect(target.children.length).toBe(0);

    dispose();
  });

  test("params$ updates within the same pattern without re-render", async () => {
    // The property that matters for a doc app: /trips/1 → /trips/2 must NOT
    // tear the handler down, or every id change re-opens the doc.
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/users/1";
    await tick();

    let renders = 0;
    const dispose = routes(target, {
      "/users/:id": (_p, params$) => {
        renders++;
        const node = document.createElement("span");
        effect(() => { node.textContent = params$.get().id ?? ""; });
        return node;
      },
    });
    expect(renders).toBe(1);
    expect(target.textContent).toBe("1");

    navigate("/users/2");
    await tick();
    expect(renders).toBe(1);
    expect(target.textContent).toBe("2");

    navigate("/users/42");
    await tick();
    expect(renders).toBe(1);
    expect(target.textContent).toBe("42");

    dispose();
  });

  test("changing pattern tears down and re-renders", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/users/1";
    await tick();

    let cleanups = 0;
    const dispose = routes(target, {
      "/users/:id": () => {
        const node = el("span", "user");
        effect(() => () => { cleanups++; });
        return node;
      },
      "/about": () => el("span", "about"),
    });
    expect(target.textContent).toBe("user");

    navigate("/about");
    await tick();
    expect(target.textContent).toBe("about");
    expect(cleanups).toBe(1);

    dispose();
  });

  test("async handler resolves and renders", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/slow";
    await tick();

    const d = defer<() => Node>();
    const dispose = routes(target, { "/slow": () => d.promise });
    expect(target.children.length).toBe(0);

    d.resolve(() => el("span", "loaded"));
    await d.promise;
    await tick();
    expect(target.textContent).toBe("loaded");

    dispose();
  });

  test("an async thunk's post-await bindings are disposed on navigation", async () => {
    // The thunk form exists so bindings built AFTER the await have an owner.
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/slow";
    await tick();

    const d = defer<void>();
    let cleanups = 0;
    const dispose = routes(target, {
      "/slow": async () => {
        await d.promise;
        return () => {
          const node = el("span", "late");
          effect(() => () => { cleanups++; });
          return node;
        };
      },
      "/fast": () => el("span", "fast"),
    });

    d.resolve();
    await tick();
    expect(target.textContent).toBe("late");
    expect(cleanups).toBe(0);

    navigate("/fast");
    await tick();
    expect(target.textContent).toBe("fast");
    expect(cleanups).toBe(1);

    dispose();
  });

  test("async race — navigation during await discards the stale result", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/slow";
    await tick();

    const slow = defer<() => Node>();
    const dispose = routes(target, {
      "/slow": () => slow.promise,
      "/fast": () => el("span", "fast"),
    });

    navigate("/fast");
    await tick();
    expect(target.textContent).toBe("fast");

    slow.resolve(() => el("span", "slow"));
    await slow.promise;
    await tick();
    expect(target.textContent).toBe("fast");

    dispose();
  });

  test("synchronous handler error keeps the router alive and logs", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/boom";
    await tick();

    const origError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => { calls.push(args); };

    const dispose = routes(target, {
      "/boom": () => { throw new Error("kaboom"); },
      "/ok": () => el("span", "ok"),
    });
    expect(target.children.length).toBe(0);
    expect(calls.length).toBe(1);
    expect(String(calls[0]?.[0])).toContain("handler threw");

    navigate("/ok");
    await tick();
    expect(target.textContent).toBe("ok");

    dispose();
    console.error = origError;
  });

  test("onError renders a fallback for a synchronous throw", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/boom";
    await tick();

    const dispose = routes(
      target,
      { "/boom": () => { throw new Error("kaboom"); } },
      { onError: (err) => el("div", `Error: ${(err as Error).message}`) },
    );

    expect(target.textContent).toBe("Error: kaboom");
    dispose();
  });

  test("onError renders a fallback for an async rejection", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/slow-boom";
    await tick();

    const d = defer<() => Node>();
    const dispose = routes(
      target,
      { "/slow-boom": () => d.promise },
      { onError: (err) => el("div", `Error: ${(err as Error).message}`) },
    );

    d.reject(new Error("async kaboom"));
    try { await d.promise; } catch { /* expected */ }
    await tick();

    expect(target.textContent).toBe("Error: async kaboom");
    dispose();
  });

  test("dispose stack stays balanced after a handler throw", async () => {
    // popDisposeScope throws on imbalance, so a leak from the previous test
    // would crash this one's first effect.
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/x";
    await tick();

    const dispose = routes(target, { "/x": () => el("span", "x") });
    expect(target.textContent).toBe("x");
    dispose();
  });

  test("dispose() removes the listener, clears target, and is idempotent", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/";
    await tick();

    const dispose = routes(target, {
      "/": () => el("span", "home"),
      "/about": () => el("span", "about"),
    });
    expect(target.textContent).toBe("home");

    dispose();
    dispose(); // idempotent — a parent scope may call it too
    expect(target.children.length).toBe(0);

    navigate("/about");
    await tick();
    expect(target.children.length).toBe(0);

    // The shared hash signal is still usable by a fresh router.
    const target2 = document.createElement("div");
    document.body.append(target2);
    const dispose2 = routes(target2, { "/about": () => el("span", "again") });
    expect(target2.textContent).toBe("again");
    dispose2();
  });

  test("an async handler resolving to a bare Node is REFUSED", async () => {
    // It used to be accepted, and this file documented it as leaking:
    // bindings made after the first await had no owner scope. Shipping a
    // form we describe as broken is worse than refusing it.
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/bare";
    await tick();

    const d = defer<any>();
    const dispose = routes(
      target,
      { "/bare": () => d.promise },
      { onError: (err) => el("div", String((err as Error).message)) },
    );
    d.resolve(el("span", "not a thunk"));
    await d.promise;
    await tick();
    expect(target.textContent).toContain("must resolve to a THUNK");
    dispose();
  });

  test("nested routes via wildcard — the outer layout stays mounted", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    location.hash = "#/sites/1";
    await tick();

    let outerRenders = 0;
    const dispose = routes(target, {
      "/sites/*": () => {
        outerRenders++;
        const wrapper = document.createElement("div");
        wrapper.setAttribute("data-layout", "sites");
        return wrapper;
      },
    });
    expect(outerRenders).toBe(1);
    expect(target.querySelector("[data-layout=sites]")).not.toBeNull();

    navigate("/sites/2/edit");
    await tick();
    expect(outerRenders).toBe(1);

    dispose();
  });
});

describe("route()", () => {
  test("returns matching params, null when unmatched", async () => {
    location.hash = "#/users/7";
    await tick();
    const r = route<{ id: string }>("/users/:id");
    expect(r.get()).toEqual({ id: "7" });

    navigate("/about");
    await tick();
    expect(r.get()).toBeNull();

    navigate("/users/99");
    await tick();
    expect(r.get()).toEqual({ id: "99" });
  });

  test("multiple route() instances share one hash signal", async () => {
    location.hash = "#/users/1";
    await tick();
    const a = route<{ id: string }>("/users/:id");
    const b = route<{ id: string }>("/users/:id");
    expect(a.get()).toEqual({ id: "1" });
    expect(b.get()).toEqual({ id: "1" });

    navigate("/users/2");
    await tick();
    expect(a.get()).toEqual({ id: "2" });
    expect(b.get()).toEqual({ id: "2" });
  });

  test("an effect over route() re-runs when params change", async () => {
    location.hash = "#/posts/1";
    await tick();
    const r = route<{ id: string }>("/posts/:id");
    const seen: (string | null)[] = [];
    const dispose = effect(() => { seen.push(r.get()?.id ?? null); });
    expect(seen).toEqual(["1"]);

    navigate("/posts/2");
    await tick();
    expect(seen).toEqual(["1", "2"]);

    navigate("/about");
    await tick();
    expect(seen).toEqual(["1", "2", null]);

    dispose();
  });
});

describe("navigate()", () => {
  test("sets location.hash and drives the reactive update", async () => {
    location.hash = "#/";
    await tick();

    const r = route("/about");
    expect(r.get()).toBeNull();

    navigate("/about");
    await tick();
    expect(r.get()).toEqual({});
    expect(location.hash).toBe("#/about");
  });
});
