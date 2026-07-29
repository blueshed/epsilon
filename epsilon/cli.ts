#!/usr/bin/env bun
/**
 * CLI — the wire, from a terminal. The SAME client the browser runs
 * (connect() from ./doc), so auth, queueing, versions, and echoes all
 * behave exactly like the app: one-shot commands, JSON out — a human, a
 * script, or an AI can work the live app while `bun dev` runs.
 *
 *   bun epsilon/cli.ts register <name> <email> <password>
 *   bun epsilon/cli.ts login <email> <password>
 *   bun epsilon/cli.ts whoami | logout
 *   bun epsilon/cli.ts open <doc> [pointer]         # snapshot (or a slice)
 *   bun epsilon/cli.ts add <doc> <path> <value>     # the three verbs;
 *   bun epsilon/cli.ts set <doc> <path> <value>     # value/params parse as
 *   bun epsilon/cli.ts rm <doc> <path>              # JSON, bare words pass
 *   bun epsilon/cli.ts apply <doc> <ops-json>       # as strings
 *   bun epsilon/cli.ts watch <doc> [--for <ms>]     # NDJSON op stream
 *   bun epsilon/cli.ts call <method> [params-json]
 *
 * Every mutation prints the RESOLVED echo the server broadcast — minted
 * ids included. The truth you see is the truth every client saw.
 *
 * Connection: --url or EPSILON_URL (default ws://localhost:3000/ws).
 * Session: EPSILON_TOKEN, else .epsilon-token in the cwd — written by
 * login/register, cleared by logout; the connect hook re-authenticates
 * with it, so every command runs as you. --timeout <ms> (default 5000)
 * bounds every command except a bare watch.
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { connect } from "./doc";
import { valueAt, type Op } from "./op";

const TOKEN_FILE = ".epsilon-token";

const flags = new Map<string, string>();
const args: string[] = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags.set(a.slice(2), argv[++i] ?? "");
    else args.push(a);
  }
}
const [cmd, ...rest] = args;
const url = flags.get("url") ?? process.env.EPSILON_URL ?? "ws://localhost:3000/ws";
const timeoutMs = Number(flags.get("timeout") ?? 5000);

const USAGE = `usage: cli <command> [--url ws://...] [--timeout ms]
  register <name> <email> <password>   start a session (token → ${TOKEN_FILE})
  login <email> <password>             start a session (token → ${TOKEN_FILE})
  whoami | logout
  open <doc> [pointer]                 print {doc, v, data}
  add <doc> <path> <value>             one verb, echo printed
  set <doc> <path> <value>
  rm <doc> <path>
  apply <doc> <ops-json>               raw batch, echo printed
  watch <doc> [--for ms]               snapshot + ops as NDJSON
  call <method> [params-json]`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** JSON if it parses, the raw string otherwise — `set board:1 /name Plan`. */
function loose(s: string | undefined): unknown {
  if (s === undefined) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}

function token(): string | null {
  if (process.env.EPSILON_TOKEN) return process.env.EPSILON_TOKEN;
  try { return readFileSync(TOKEN_FILE, "utf8").trim() || null; } catch { return null; }
}

function failDoc(e: unknown): never {
  const m = e instanceof Error ? e.message : String(e);
  fail(m.includes("unauthenticated")
    ? `${m} — log in first: cli login <email> <password>`
    : m);
}

const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setTimeout(r, 10));
};

if (!cmd) fail(USAGE);

// A bare watch runs until Ctrl-C; everything else is bounded.
if (cmd !== "watch" || flags.has("for")) {
  const t = setTimeout(
    () => fail(`timeout after ${timeoutMs}ms — is the app running at ${url}?`),
    cmd === "watch" ? Number(flags.get("for")) + timeoutMs : timeoutMs,
  );
  (t as { unref?: () => void }).unref?.();
}

const docErrors: string[] = [];
const remote = connect(url, {
  // Re-auth on every (re)connect — the CLI is just another client.
  onConnect: async (r) => {
    const tk = token();
    if (!tk || cmd === "login" || cmd === "register") return;
    try { await r.call("authenticate", { token: tk }); }
    catch { /* stale token — open commands surface "unauthenticated" */ }
  },
  onError: (_doc, error) => { docErrors.push(error); },
});

try {
  switch (cmd) {
    case "register":
    case "login": {
      const params = cmd === "register"
        ? { name: rest[0], email: rest[1], password: rest[2] }
        : { email: rest[0], password: rest[1] };
      const res = await remote.call<{ token: string; user: unknown }>(cmd, params);
      writeFileSync(TOKEN_FILE, res.token + "\n");
      out(res.user);
      break;
    }

    case "whoami": {
      const tk = token();
      if (!tk) fail(`no session — cli login <email> <password>`);
      out(await remote.call("authenticate", { token: tk }));
      break;
    }

    case "logout": {
      const tk = token();
      if (tk) await remote.call("logout", { token: tk }).catch(() => {});
      try { unlinkSync(TOKEN_FILE); } catch { /* no file — already out */ }
      out({ ok: true });
      break;
    }

    case "open": {
      const [name, pointer] = rest;
      if (!name) fail("usage: open <doc> [pointer]");
      const doc = remote.doc(name);
      await doc.ready.catch(failDoc);
      out({ doc: name, v: doc.v, data: pointer ? valueAt(doc.peek(), pointer) : doc.peek() });
      break;
    }

    case "add":
    case "set":
    case "rm":
    case "apply": {
      const [name, a, b] = rest;
      if (!name || !a) fail(`usage: ${cmd} <doc> ${cmd === "apply" ? "<ops-json>" : "<path>" + (cmd === "rm" ? "" : " <value>")}`);
      const ops: Op[] =
        cmd === "apply" ? (loose(a) as Op[]) :
        cmd === "add" ? [{ op: "add", path: a, value: loose(b) }] :
        cmd === "set" ? [{ op: "replace", path: a, value: loose(b) }] :
        [{ op: "remove", path: a }];
      const doc = remote.doc(name);
      await doc.ready.catch(failDoc);
      // The echo is the result — the resolved ops every subscriber saw.
      let echo: { v: number; ops: Op[] } | null = null;
      doc.onOps((o) => { if (o && !echo) echo = { v: doc.v, ops: o }; });
      doc.apply(ops);
      await until(() => echo !== null || docErrors.length > 0);
      if (!echo) fail(docErrors[0]!);
      out(echo);
      break;
    }

    case "watch": {
      const [name] = rest;
      if (!name) fail("usage: watch <doc> [--for ms]");
      const doc = remote.doc(name);
      await doc.ready.catch(failDoc);
      console.log(JSON.stringify({ doc: name, v: doc.v, snapshot: doc.peek() }));
      doc.onOps((o) => { if (o) console.log(JSON.stringify({ v: doc.v, ops: o })); });
      const forMs = flags.get("for");
      if (forMs) await new Promise((r) => setTimeout(r, Number(forMs)));
      else await new Promise(() => {});   // until Ctrl-C
      break;
    }

    case "call": {
      const [method, params] = rest;
      if (!method) fail("usage: call <method> [params-json]");
      out(await remote.call(method, loose(params)));
      break;
    }

    default:
      fail(USAGE);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

remote.close();
process.exit(0);
