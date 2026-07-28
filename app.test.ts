// The app itself, in a real browser (Bun.WebView — bun-route convention).
// This is the test the op stream exists for: keyboard → form → wire →
// authority (tables) → echo → pixels, plus the auth gate and audit trail.
import { describe, test, expect } from "bun:test";
import { SQL } from "bun";
import { startServer } from "./server";
import { ensureSchema, applySql } from "./epsilon/pg";

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
    await view.click("#input");
    await view.type("hello from a real browser");
    await view.press("Enter");
    const log = await waitFor(
      () => view.evaluate<string>("document.querySelector('#log').textContent"),
      (t) => t.includes("hello from a real browser"),
    );
    expect(log).toContain("hello from a real browser");
    server.stop(true);
  });

  test("postgres: auth gate → register → card in the TABLE, write in the audit log", async () => {
    const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
    const PG_URL = process.env.EPSILON_TEST_PG_URL ?? "postgres://epsilon:epsilon@localhost:5599/epsilon_test";
    if (!process.env.EPSILON_TEST_PG_URL) {
      const admin = new SQL(ADMIN_URL);
      const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = 'epsilon_test'`;
      if (!exists) await admin.unsafe("CREATE DATABASE epsilon_test");
      await admin.end();
    }
    const db = new SQL(PG_URL);
    await ensureSchema(db);
    await applySql(db, new URL("./board.sql", import.meta.url));
    await db.unsafe("TRUNCATE docs, doc_ops, sessions, boards, cards RESTART IDENTITY CASCADE");
    await db.unsafe("TRUNCATE users RESTART IDENTITY CASCADE");
    await applySql(db, new URL("./board.sql", import.meta.url));   // re-seed board:1

    const { server, sql } = await startServer({ port: 0, pgUrl: PG_URL });
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

    const [row] = await db`SELECT id, text FROM cards WHERE text = ${"audited card"}`;
    expect(row).toBeDefined();                                    // the table is the truth
    const [audit] = await db`SELECT by_user, ops FROM doc_ops WHERE name = ${"board:1"} ORDER BY v DESC LIMIT 1`;
    const [user] = await db`SELECT id FROM users WHERE email = ${"pete@app.test"}`;
    expect(Number(audit.by_user)).toBe(Number(user.id));          // the log is the audit
    expect(audit.ops[0].path).toBe(`/cards/${row.id}`);           // sequence id, resolved

    server.stop(true);
    await sql?.end?.();
    await db.end();
  });
});
