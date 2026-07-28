// The authority. In-memory out of the box; set EPSILON_PG_URL for durable
// Postgres (schema applies itself). Same doc, same client, either way.
import index from "./index.html";
import { createHost } from "./epsilon";
import type { Board } from "./src/types";

const host = createHost();
const empty: Board = { cards: {} };

if (process.env.EPSILON_PG_URL) {
  const { SQL } = await import("bun");
  const { ensureSchema, pgDoc, pgSync } = await import("./epsilon/pg");
  const sql = new SQL(process.env.EPSILON_PG_URL);
  await ensureSchema(sql);
  await pgDoc<Board>(host, sql, "board", empty);
  // Push fan-out when `pg` is installed (bun add pg); polling otherwise.
  await pgSync(host, sql, { url: process.env.EPSILON_PG_URL });
} else {
  host.doc<Board>("board", empty);
}

const server = Bun.serve({
  port: 3000,
  routes: { "/": index },
  fetch: (req, srv) => host.fetch(req, srv) ?? new Response("not found", { status: 404 }),
  websocket: host.websocket,
  development: { hmr: true, console: true },
});
host.setServer(server);
console.log(`epsilon-app → http://localhost:${server.port}`);
