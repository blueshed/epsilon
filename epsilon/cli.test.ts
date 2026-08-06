// The CLI is the wire from a terminal: real subprocess, real WebSocket,
// JSON out. What an AI (or a script) sees is what every client saw — the
// resolved echo, minted ids included.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, connect, type Remote } from "./doc";

const CLI = new URL("./cli.ts", import.meta.url).pathname;

interface Card { id?: string; text: string }
interface Board { name: string; cards: Record<string, Card> }

let openServer: ReturnType<typeof Bun.serve>;
let authServer: ReturnType<typeof Bun.serve>;
let openUrl: string;
let authUrl: string;
let openHost: ReturnType<typeof createHost>;
let cwd: string;                 // the CLI's token file lives per-cwd
const remotes: Remote[] = [];

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "epsilon-cli-"));

  openHost = createHost();
  openHost.doc<Board>("board", { name: "main", cards: {} });
  openHost.method("ping", (params) => ({ pong: params ?? true }));
  openServer = Bun.serve({ port: 0, fetch: openHost.fetch, websocket: openHost.websocket });
  openHost.setServer(openServer);
  openUrl = `ws://localhost:${openServer.port}${openHost.path}`;

  // Auth host with a fake SQL-contract: enough to prove the CLI's session
  // handling without a database.
  const h = createHost({ requireAuth: true });
  h.doc<Board>("secret", { name: "hush", cards: {} });
  h.method("login", (p: { email?: string; password?: string }, ws) => {
    if (p?.email !== "pete@cli.test" || p?.password !== "pw") throw new Error("invalid credentials");
    ws.data ??= {};
    ws.data.user = { id: 7, name: "Pete" };
    return { token: "tok-7", user: ws.data.user };
  }, { open: true });
  h.method("authenticate", (p: { token?: string }, ws) => {
    if (p?.token !== "tok-7") throw new Error("invalid or expired session");
    ws.data ??= {};
    ws.data.user = { id: 7, name: "Pete" };
    return ws.data.user;
  }, { open: true });
  h.method("logout", (_p, ws) => { if (ws.data) delete ws.data.user; return { ok: true }; }, { open: true });
  authServer = Bun.serve({ port: 0, fetch: h.fetch, websocket: h.websocket });
  h.setServer(authServer);
  authUrl = `ws://localhost:${authServer.port}${h.path}`;
});

afterAll(() => {
  for (const r of remotes) r.close();
  openServer.stop(true);
  authServer.stop(true);
  rmSync(cwd, { recursive: true, force: true });
});

describe("the CLI — one-shot, JSON out", () => {
  test("open prints {doc, v, data}; a pointer slices it", async () => {
    const r = await run(["open", "board", "--url", openUrl]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout);
    expect(res.doc).toBe("board");
    expect(res.data.name).toBe("main");

    const slice = await run(["open", "board", "/name", "--url", openUrl]);
    expect(JSON.parse(slice.stdout).data).toBe("main");
  });

  test("add prints the RESOLVED echo — the minted id, not the dash", async () => {
    const r = await run(["add", "board", "/cards/-", `{"text":"from the cli"}`, "--url", openUrl]);
    expect(r.code).toBe(0);
    const echo = JSON.parse(r.stdout);
    expect(echo.ops[0].op).toBe("add");
    expect(echo.ops[0].path.endsWith("/-")).toBe(false);                      // resolved
    expect(echo.ops[0].path.length).toBeGreaterThan("/cards/".length + 30);   // uuid
    expect(echo.ops[0].value.text).toBe("from the cli");
  });

  test("set with a bare word passes as a string; rm removes", async () => {
    const r = await run(["set", "board", "/name", "renamed", "--url", openUrl]);
    expect(JSON.parse(r.stdout).ops[0].value).toBe("renamed");

    const id = Object.keys(openHost.doc<Board>("board", { name: "", cards: {} }).peek().cards)[0]!;
    const rm = await run(["rm", "board", `/cards/${id}`, "--url", openUrl]);
    expect(JSON.parse(rm.stdout).ops[0].op).toBe("remove");
  });

  test("call round-trips params", async () => {
    const r = await run(["call", "ping", `{"n":1}`, "--url", openUrl]);
    expect(JSON.parse(r.stdout).pong.n).toBe(1);
  });

  test("watch --for streams the snapshot then ops as NDJSON", async () => {
    const watching = run(["watch", "board", "--for", "600", "--url", openUrl]);
    await new Promise((r) => setTimeout(r, 250));            // watcher is up
    const other = connect(openUrl);
    remotes.push(other);
    const doc = other.doc<Board>("board");
    await doc.ready;
    doc.at<string>("/name").set("seen by the watcher");

    const r = await watching;
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].snapshot).toBeDefined();                 // first line: baseline
    expect(lines.some((l) => l.ops?.some((o: { value?: unknown }) => o.value === "seen by the watcher"))).toBe(true);
  });

  test("a dead server fails fast with a pointer to the url", async () => {
    const r = await run(["open", "board", "--url", "ws://localhost:9", "--timeout", "700"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ws://localhost:9");
  });
});

describe("the CLI — auth-aware", () => {
  test("a guarded doc refuses with a hint; login stores the token; then it opens", async () => {
    const before = await run(["open", "secret", "--url", authUrl]);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain("unauthenticated");
    expect(before.stderr).toContain("login");

    const login = await run(["login", "pete@cli.test", "pw", "--url", authUrl]);
    expect(login.code).toBe(0);
    expect(JSON.parse(login.stdout).name).toBe("Pete");
    expect(existsSync(join(cwd, ".epsilon-token"))).toBe(true);

    // The stored session rides every later command via the connect hook.
    const after = await run(["open", "secret", "--url", authUrl]);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout).data.name).toBe("hush");

    const who = await run(["whoami", "--url", authUrl]);
    expect(JSON.parse(who.stdout).id).toBe(7);

    // EPSILON_TOKEN overrides the file — a bad one is refused cleanly.
    const bad = await run(["whoami", "--url", authUrl], { EPSILON_TOKEN: "nope" });
    expect(bad.code).toBe(1);

    const out = await run(["logout", "--url", authUrl]);
    expect(out.code).toBe(0);
    expect(existsSync(join(cwd, ".epsilon-token"))).toBe(false);
  });
});
