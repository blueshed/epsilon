# db/fn — the vocabulary

Stored functions live here: `db/fn/*.sql`, **unnumbered and not
hash-recorded**. Every file in this folder is replayed on every boot, in one
transaction, after the numbered migrations have run.

That means you **edit these files in place**. `CREATE OR REPLACE FUNCTION`
is idempotent by construction, so hash-locking it would only force a copy of
the whole body per edit — which is how a real app ends up with the same
function defined ten times and the wrong copy winning.

Three rules:

- **No schema DDL.** `CREATE TABLE`, `ALTER`, `CREATE INDEX` and friends are
  refused here — a replayed file cannot contain them and stay idempotent.
  They belong in the next numbered file. `migrate` gates this and names the
  statement it found.
- **A signature change needs a drop first.** Postgres overloads on
  arguments, so changing them creates a *second* function rather than
  replacing the first. Put
  `DROP FUNCTION IF EXISTS my_fn(int);` in the next numbered file, then edit
  the file here.
- **Order carries no meaning.** The set is created together with
  `check_function_bodies` off, so functions may call each other regardless
  of file name.

Numbered migrations (`db/001-…`) are the opposite contract: ordered,
hash-recorded, forward-only, frozen once released. Tables go there;
behaviour goes here.
