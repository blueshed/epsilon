// The app itself, in a real browser (Bun.WebView — bun-route convention).
// This is the test the op stream exists for: keyboard → form → wire →
// authority (tables) → echo → pixels, plus the auth gate and audit trail.
import { describe, test, expect } from "bun:test";
import { SQL } from "bun";
import { startServer } from "./server";

const DB_DIR = new URL("./db", import.meta.url).pathname;

// Test db namespaced by app (package.json name) — see epsilon/pg.test.ts.
const APP = ((await Bun.file(new URL("./package.json", import.meta.url)).json()).name as string)
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^(?![a-z_])/, "app_");
const TEST_DB = `${APP}_test_app`;

const waitFor = async <T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 4000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("the app, end to end", () => {
  test("in-memory: type + REAL Enter → the echo renders the row", async () => {
    const { server } = await startServer({ port: 0 });
    await using view = new Bun.WebView({ width: 800, height: 600 });
    await view.navigate(server.url.href);
    // The snapshot rendering is the app's "ready": typing before the module
    // has wired onsubmit would native-submit the form and navigate away.
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#board-name').textContent"),
      (t) => t === "main",
    );
    await view.click("#input");
    await view.type("hello from a real browser");
    await view.press("Enter");
    const log = await waitFor(
      () => view.evaluate<string>("document.querySelector('#log').textContent"),
      (t) => t.includes("hello from a real browser"),
    );
    expect(log).toContain("hello from a real browser");
    // Presence: no auth, so the watcher shows as a guest.
    const who = await waitFor(
      () => view.evaluate<string>("document.querySelector('#who').textContent"),
      (t) => t.includes("guest"),
    );
    expect(who).toContain("here:");

    // In-memory is a shape PREVIEW: server.ts wires pgUndo/pgHistory only
    // behind an engine, so the doc-kit controls stay hidden rather than
    // offering a button that can only answer "unknown method". The probe has
    // had its round trip by now — the card above needed one. (The postgres
    // test asserts the other side: there, #undo IS revealed.)
    expect(await view.evaluate<boolean>("document.querySelector('#undo').hidden")).toBe(true);
    expect(await view.evaluate<boolean>("document.querySelector('#history-toggle').hidden")).toBe(true);

    // The router, in a real browser. A cold load resolves to the shared
    // board before first paint — no placeholder flash, because the hash is
    // set before routes() reads it.
    expect(await view.evaluate<string>("location.hash")).toBe("#/board/1");

    // Leaving the pattern tears the board down; re-entering rebuilds it.
    // #board-name existing or not IS the view swap.
    await view.evaluate("location.hash = '#/'");
    await waitFor(
      () => view.evaluate<boolean>("!!document.querySelector('#pick')"),
      (v) => v,
    );
    expect(await view.evaluate<boolean>("!!document.querySelector('#board-name')")).toBe(false);

    await view.evaluate("location.hash = '#/board/1'");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#board-name')?.textContent ?? ''"),
      (t) => t === "main",
    );
    // The board came back live, not as a corpse: its list() re-rendered the
    // card written before the round trip.
    expect(await view.evaluate<string>("document.querySelector('#log').textContent"))
      .toContain("hello from a real browser");

    server.stop(true);
  });

  test("postgres: auth gate → register → card in the TABLE, write in the audit log", async () => {
    const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
    const PG_URL = process.env.EPSILON_TEST_PG_URL ?? `postgres://epsilon:epsilon@localhost:5599/${TEST_DB}`;
    if (!process.env.EPSILON_TEST_PG_URL) {
      const admin = new SQL(ADMIN_URL);
      const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEST_DB}`;
      if (!exists) await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
      await admin.end();
    }
    const db = new SQL(PG_URL, { max: 3 });
    // Fresh schema, fresh ledger — frozen files only re-apply from nothing
    // (see pg.test.ts).
    await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");

    // startServer runs the migrations itself — that IS the boot path.
    const { server, sql } = await startServer({ port: 0, pgUrl: PG_URL, dbDir: DB_DIR });
    await using view = new Bun.WebView({ width: 800, height: 600 });
    await view.navigate(server.url.href);

    // requireAuth: the dialog opens on its own when the doc 401s.
    await waitFor(() => view.evaluate<boolean>("document.querySelector('#auth').open"), (o) => o);
    await view.click("#auth-name"); await view.type("Pete");
    await view.click("#auth-email"); await view.type("pete@app.test");
    await view.click("#auth-password"); await view.type("pw");
    await view.click("#auth-register");
    await waitFor(() => view.evaluate<boolean>("document.querySelector('#auth').open"), (o) => !o);

    await view.click("#input");
    await view.type("audited card");
    await view.press("Enter");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#log').textContent"),
      (t) => t.includes("audited card"),
    );

    // Presence knows who we are once authenticated.
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#who').textContent"),
      (t) => t.includes("Pete"),
    );

    // THE VISION, through the UI: create a board (an op on mine:<uid>),
    // switch to it, write a card into it.
    await view.click("#new-board");
    await view.type("my project");
    await view.press("Enter");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#boards').textContent"),
      (t) => t.includes("my project"),
    );
    // tally:<uid> — a view, not a doc anyone wrote to: mine_apply minting
    // the board is enough to move it. board:1's card (added above) is
    // owned by nobody, so it never counted.
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#tally').textContent"),
      (t) => t.includes("1 boards") && t.includes("0 cards"),
    );
    await view.click("#boards li span");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#board-name').textContent"),
      (t) => t === "my project",
    );
    await view.click("#input");
    await view.type("first step");
    await view.press("Enter");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#log').textContent"),
      (t) => t.includes("first step"),
    );
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#tally').textContent"),
      (t) => t.includes("1 cards"),
    );

    // The hash is navigation truth: back returns to the shared board,
    // forward to mine — real history, no reload.
    await view.evaluate("history.back()");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#board-name').textContent"),
      (t) => t === "main",
    );
    await view.evaluate("history.forward()");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#board-name').textContent"),
      (t) => t === "my project",
    );

    // The ← button: visible away from main, deterministic unlike
    // history.back() (a reload or a bookmarked link has no history to use).
    expect(await view.evaluate<boolean>("document.querySelector('#board-back').hidden")).toBe(false);
    await view.click("#board-back");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#board-name').textContent"),
      (t) => t === "main",
    );
    expect(await view.evaluate<boolean>("document.querySelector('#board-back').hidden")).toBe(true);
    await view.click("#boards li span");   // back onto "my project" for what follows
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#board-name').textContent"),
      (t) => t === "my project",
    );

    const [myBoard] = await db`SELECT b.id, b.owner_id FROM boards b JOIN users u ON u.id = b.owner_id WHERE b.name = ${"my project"}`;
    expect(myBoard).toBeDefined();                                 // owned, in the tables
    const [myCard] = await db`SELECT text FROM cards WHERE board_id = ${myBoard.id}`;
    expect(myCard.text).toBe("first step");

    const [row] = await db`SELECT id, text FROM cards WHERE text = ${"audited card"}`;
    expect(row).toBeDefined();                                    // the table is the truth
    const [audit] = await db`SELECT by_user, ops FROM doc_ops WHERE name = ${"board:1"} ORDER BY v DESC LIMIT 1`;
    const [user] = await db`SELECT id FROM users WHERE email = ${"pete@app.test"}`;
    expect(Number(audit.by_user)).toBe(Number(user.id));          // the log is the audit
    expect(audit.ops[0].path).toBe(`/cards/${row.id}`);           // sequence id, resolved

    // The OTHER two verbs, through the UI. Checkbox → replace /done:
    await view.click("#log li input");
    await waitFor(
      async () => (await db`SELECT done FROM cards WHERE board_id = ${myBoard.id}`)[0]?.done as boolean,
      (d) => d === true,
    );
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#tally').textContent"),
      (t) => t.includes("1 done"),
    );

    // --- the doc kit, on screen (003) --------------------------------------
    // The stamps: card_json puts created_by/updated_by/updated_at on every
    // echo, and the byline is the only thing that reads them. The checkbox
    // above was an edit by us, so it resolves to "you" through the members
    // map — no lookup, no fetch.
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#log li .byline').textContent"),
      (t) => t.startsWith("you, "),
    );

    // Undo: doc_ops holds each write's inverse, so the /done edit reverts
    // through board_apply itself — there is no client-side stack to drift.
    expect(await view.evaluate<boolean>("document.querySelector('#undo').hidden")).toBe(false);
    await view.click("#undo");
    await waitFor(
      async () => (await db`SELECT done FROM cards WHERE board_id = ${myBoard.id}`)[0]?.done as boolean,
      (d) => d === false,
    );
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#tally').textContent"),
      (t) => t.includes("0 done"),
    );

    // History: the SAME table, read back through the doc's own permit —
    // newest first, the writer named at read time, paths resolved.
    await view.click("#history-toggle");
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#history').textContent"),
      (t) => t.includes("Pete") && t.includes("/cards/"),
    );
    await view.click("#history-toggle");
    expect(await view.evaluate<boolean>("document.querySelector('#history').hidden")).toBe(true);

    // ✕ → a confirm dialog (not window.confirm() — Bun's WebView can't
    // drive a browser-chrome dialog, only a DOM one). Cancel changes nothing.
    await view.click("#log li button");
    await waitFor(() => view.evaluate<boolean>("document.querySelector('#confirm').open"), (o) => o);
    await view.click("#confirm-cancel");
    await waitFor(() => view.evaluate<boolean>("document.querySelector('#confirm').open"), (o) => !o);
    expect(Number((await db`SELECT count(*) AS n FROM cards WHERE board_id = ${myBoard.id}`)[0]!.n)).toBe(1);

    // Confirmed: the row leaves the table AND the pixels.
    await view.click("#log li button");
    await waitFor(() => view.evaluate<boolean>("document.querySelector('#confirm').open"), (o) => o);
    await view.click("#confirm-ok");
    await waitFor(
      async () => Number((await db`SELECT count(*) AS n FROM cards WHERE board_id = ${myBoard.id}`)[0]!.n),
      (n) => n === 0,
    );
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#tally').textContent"),
      (t) => t.includes("0 cards") && t.includes("0 done"),
    );
    // Rename in place → replace /name; the mirror renames it in the mine
    // list too — two docs, one transaction, both on screen.
    await view.evaluate(
      "(() => { const h = document.querySelector('#board-name'); h.textContent = 'renamed plan'; h.dispatchEvent(new Event('blur')); return 1; })()",
    );
    await waitFor(
      () => view.evaluate<string>("document.querySelector('#boards').textContent"),
      (t) => t.includes("renamed plan"),
    );

    server.stop(true);
    await sql?.end?.();
    await db.end();
  });
});
