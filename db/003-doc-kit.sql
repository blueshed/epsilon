-- 003 — the doc kit: the reusable skeleton of a relational doc type. A new
-- type writes ONLY its dispatch (the DML per op shape) and its composition;
-- the kit encodes the rules once:
--
--   lock discipline      doc_lock / doc_begin — FOR UPDATE serializes
--                        writers per doc; canonical order (see 005): ALL
--                        mine docs ascending uid, THEN board docs
--                        ascending id, pre-scanned and locked up front.
--   no existence oracle  doc_begin raises 'unknown doc' for absence and
--                        'not found' for refusal — strangers can't tell
--                        which. Pass the permit expression raw; NULL reads
--                        as refused.
--   express the change   doc_commit bumps v, logs doc_ops (the audit:
--                        who/when), rings the ~40-byte doorbell. A write
--                        never recomposes the doc. FK cascades are
--                        INVISIBLE to the op log — expand them with
--                        doc_cascade_remove BEFORE deleting the parent, or
--                        clients render orphans until recompute.
--   record the inverse   the dispatch loop builds the batch's undo as it
--                        goes (one before-read per mutating op, PREPENDED —
--                        a batch undoes back to front) and hands it to
--                        doc_commit:
--                          add /x {v}      ⟵undo⟶  remove /x
--                          replace /x {v}  ⟵undo⟶  replace /x {before}
--                          remove /x       ⟵undo⟶  add /x {before}
--   echoes are input     a type's own RESOLVED echo must be a legal op:
--                        add /coll/<id> {row} restores that exact row
--                        (OVERRIDING SYSTEM VALUE + doc_restore_id),
--                        replace /coll/<id> {row} sets it whole. Undo,
--                        replay, and fork all hang off this one property.
--   one vocabulary       op_add / op_replace / op_remove build the resolved
--                        echo — the wire's three verbs, in SQL. The
--                        inverses are the same three verbs; never invent a
--                        fourth.
--   answer for itself    doc_history reads the log back — newest first,
--                        paged by version, named at read time — behind the
--                        doc's OWN permit (doc_open). Every type gets it
--                        free; the audit was already being written.
--
-- A doc type is then: <t>_open (ONE composition query; NULL user = the
-- host, full view) and <t>_apply = doc_begin → dispatch loop (echo to
-- v_out, inverse prepended to v_undo) → RETURN doc_commit. 005-board.sql
-- is board/mine built on it; rel.test.ts's `todo` type is the minimal
-- worked example.

-- <type>:<id> — the naming convention, in one place.
CREATE OR REPLACE FUNCTION doc_id(p_doc text) RETURNS bigint AS $$
  SELECT split_part(p_doc, ':', 2)::bigint;
$$ LANGUAGE sql IMMUTABLE;

-- JSON Pointer → reference tokens. (Ids in paths are numeric here, so the
-- ~0/~1 escapes never occur in server-minted paths.)
CREATE OR REPLACE FUNCTION doc_path(p_op jsonb) RETURNS text[] AS $$
  SELECT regexp_split_to_array(ltrim(p_op->>'path', '/'), '/');
$$ LANGUAGE sql IMMUTABLE;

-- Resolved-echo builders. Each returns a ONE-op jsonb array so dispatch
-- branches read: v_out := v_out || op_add(...).
CREATE OR REPLACE FUNCTION op_add(p_path text, p_value jsonb) RETURNS jsonb AS $$
  SELECT jsonb_build_array(jsonb_build_object('op', 'add', 'path', p_path, 'value', p_value));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION op_replace(p_path text, p_value jsonb) RETURNS jsonb AS $$
  SELECT jsonb_build_array(jsonb_build_object('op', 'replace', 'path', p_path, 'value', p_value));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION op_remove(p_path text) RETURNS jsonb AS $$
  SELECT jsonb_build_array(jsonb_build_object('op', 'remove', 'path', p_path));
$$ LANGUAGE sql IMMUTABLE;

-- Lock a doc's registry row (FOR UPDATE). TRUE if it exists. Tolerant on
-- purpose — mirrors lock-if-present; doc_begin adds the raise.
CREATE OR REPLACE FUNCTION doc_lock(p_doc text) RETURNS boolean AS $$
BEGIN
  PERFORM 1 FROM docs WHERE name = p_doc FOR UPDATE;
  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- The standard prologue: lock, exist, permit. NOTE: p_allowed is evaluated
-- BEFORE the lock (argument order) — keep the permit expression stable
-- under concurrency (ownership is immutable here); doc_lock re-checks
-- existence either way.
CREATE OR REPLACE FUNCTION doc_begin(p_doc text, p_allowed boolean) RETURNS void AS $$
BEGIN
  IF NOT doc_lock(p_doc) THEN RAISE EXCEPTION 'unknown doc: %', p_doc; END IF;
  IF NOT COALESCE(p_allowed, false) THEN RAISE EXCEPTION 'not found: %', p_doc; END IF;
END;
$$ LANGUAGE plpgsql;

-- Upgrade path for databases that predate 0.3.0 (the parameter grew).
DROP FUNCTION IF EXISTS doc_commit(text, jsonb, bigint);

-- Express the change: bump v, log the resolved ops AND their inverse, ring
-- the doorbell. p_undo NULL = "not undoable" (doc_undo refuses it).
-- Returns {v, ops} — or NULL when the doc row does not exist, so a mirror
-- into a never-seeded doc no-ops safely. Caller holds the row lock
-- (doc_begin for your own doc, doc_lock first for a mirror's).
CREATE OR REPLACE FUNCTION doc_commit(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL, p_undo jsonb DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE v_v bigint;
BEGIN
  UPDATE docs SET v = v + 1 WHERE name = p_doc RETURNING v INTO v_v;
  IF v_v IS NULL THEN RETURN NULL; END IF;
  INSERT INTO doc_ops (name, v, ops, by_user, undo) VALUES (p_doc, v_v, p_ops, p_user, p_undo);
  PERFORM pg_notify('epsilon_ops', jsonb_build_object('name', p_doc, 'v', v_v)::text);
  RETURN jsonb_build_object('v', v_v, 'ops', p_ops);
END;
$$ LANGUAGE plpgsql;

-- TRUE when any op AFTER v touches a path v's ops wrote (same, ancestor, or
-- descendant). The undo conflict test — callers hold the doc lock.
CREATE OR REPLACE FUNCTION doc_touched_since(p_doc text, p_v bigint)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
    FROM doc_ops o
    CROSS JOIN LATERAL jsonb_array_elements(o.ops) AS later(op)
    CROSS JOIN LATERAL (SELECT jsonb_array_elements(ops) AS op
                        FROM doc_ops WHERE name = p_doc AND v = p_v) AS mine
    WHERE o.name = p_doc AND o.v > p_v
      AND (later.op->>'path' = mine.op->>'path'
        OR starts_with(later.op->>'path', (mine.op->>'path') || '/')
        OR starts_with(mine.op->>'path', (later.op->>'path') || '/'))
  );
$$ LANGUAGE sql STABLE;

-- Undo version v of a doc — or, with v NULL, the asking user's LATEST
-- undoable write ("undo" almost always means undo MY last thing). Applies
-- the stored inverse through the type's own apply function: permit
-- re-checked there, ids re-minted there (restores), mirrors re-fired there,
-- and the resulting commit records ITS undo — the redo. Refuses when the
-- version is unknown (or pruned — epsilon_prune bounds undo depth),
-- recorded no undo, or later ops touched the same paths (never clobber a
-- later edit).
CREATE OR REPLACE FUNCTION doc_undo(p_doc text, p_v bigint, p_user bigint, p_apply text)
RETURNS jsonb AS $$
DECLARE v_v bigint := p_v; v_undo jsonb; v_out jsonb;
BEGIN
  IF p_apply !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
    RAISE EXCEPTION 'apply must be a plain function name: %', p_apply;
  END IF;
  -- Serialize against writers BEFORE reading the log; the dispatch re-locks
  -- harmlessly (same transaction).
  IF NOT doc_lock(p_doc) THEN RAISE EXCEPTION 'unknown doc: %', p_doc; END IF;
  IF v_v IS NULL THEN
    SELECT max(v) INTO v_v FROM doc_ops
      WHERE name = p_doc AND by_user IS NOT DISTINCT FROM p_user AND undo IS NOT NULL;
    IF v_v IS NULL THEN RAISE EXCEPTION 'nothing to undo: %', p_doc; END IF;
  END IF;
  SELECT undo INTO v_undo FROM doc_ops WHERE name = p_doc AND v = v_v;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown version: % v%', p_doc, v_v; END IF;
  IF v_undo IS NULL THEN RAISE EXCEPTION 'no undo recorded: % v%', p_doc, v_v; END IF;
  IF doc_touched_since(p_doc, v_v) THEN
    RAISE EXCEPTION 'changed since: % v% — later ops touched these paths; look before you undo', p_doc, v_v;
  END IF;
  EXECUTE format('SELECT %I($1, $2, $3)', p_apply) INTO v_out USING p_doc, v_undo, p_user;
  RETURN v_out;
END;
$$ LANGUAGE plpgsql;

-- The log, read back — "who changed what", which doc_ops has been able to
-- answer since 001 with no way to ask. Two halves, and only this one is the
-- kit's: a row's own updated_by/updated_at (who last touched it, surviving
-- the prune) is APP schema, stamped by the type's dispatch — 100-board.sql's
-- cards are the worked example. This is the HISTORY half.
--
-- The permit is doc_open — the same question the wire's default gate asks at
-- every open — so history can never become a side door into a doc the caller
-- may not read, and no type has to remember to guard it. A NULL user is the
-- host asking as itself (001's rule): the full log. Refusal reads as absence,
-- exactly like doc_begin.
--
-- Names JOIN at read time rather than being stamped into the log: the log
-- keeps ids, so a member who has since left is still named honestly, and a
-- rename is not retconned across the past. p_before pages backwards
-- ("older…"); p_after fetches only what is newer (an open panel topping
-- itself up). Both are VERSION cursors — v is the ordering the doc already
-- owns, so paging cannot drift the way a timestamp can. Depth is whatever
-- epsilon_prune keeps (004).
CREATE OR REPLACE FUNCTION doc_history(
  p_doc    text,
  p_user   bigint DEFAULT NULL,
  p_before bigint DEFAULT NULL,
  p_after  bigint DEFAULT NULL,
  p_limit  int    DEFAULT 100
) RETURNS jsonb AS $$
BEGIN
  IF doc_open(p_doc, p_user) IS NULL THEN
    RAISE EXCEPTION 'not found: %', p_doc;
  END IF;
  -- The inner LIMIT takes the newest window; the outer agg keeps it newest-first.
  RETURN COALESCE((
    SELECT jsonb_agg(x.entry ORDER BY x.v DESC)
      FROM (
        SELECT o.v,
               jsonb_build_object(
                 'v', o.v, 'at', o.at, 'by', o.by_user,
                 'name', u.name, 'ops', o.ops) AS entry
          FROM doc_ops o
          LEFT JOIN users u ON u.id = o.by_user
         WHERE o.name = p_doc
           AND (p_before IS NULL OR o.v < p_before)
           AND (p_after  IS NULL OR o.v > p_after)
         ORDER BY o.v DESC
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
      ) x
  ), '[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE;

-- After INSERT … OVERRIDING SYSTEM VALUE (a restore), realign the identity
-- sequence so the next minted id cannot collide with the restored one.
CREATE OR REPLACE FUNCTION doc_restore_id(p_table text, p_column text DEFAULT 'id')
RETURNS void AS $$
DECLARE v_max bigint;
BEGIN
  EXECUTE format('SELECT COALESCE(max(%I), 0) FROM %I', p_column, p_table) INTO v_max;
  PERFORM setval(pg_get_serial_sequence(p_table, p_column), GREATEST(v_max, 1));
END;
$$ LANGUAGE plpgsql;

-- Turn an FK cascade into ops the log can carry: deletes the children
-- (p_table rows whose p_fk = p_id) and returns their remove ops, keyed by
-- id under p_prefix. Append them to the echo BEFORE the parent's remove,
-- INSTEAD of letting ON DELETE CASCADE fire silently. (A cascade the log
-- never saw is also a cascade undo can never restore.)
CREATE OR REPLACE FUNCTION doc_cascade_remove(p_table text, p_fk text, p_id bigint, p_prefix text)
RETURNS jsonb AS $$
DECLARE v_ops jsonb;
BEGIN
  EXECUTE format(
    'WITH gone AS (DELETE FROM %I WHERE %I = $1 RETURNING id)
     SELECT COALESCE(jsonb_agg(jsonb_build_object(''op'', ''remove'', ''path'', $2 || id) ORDER BY id), ''[]''::jsonb)
     FROM gone', p_table, p_fk)
    INTO v_ops USING p_id, p_prefix;
  RETURN v_ops;
END;
$$ LANGUAGE plpgsql;

-- A doc dies whole: its registry row AND its log.
CREATE OR REPLACE FUNCTION doc_drop(p_doc text) RETURNS void AS $$
  DELETE FROM docs WHERE name = p_doc;
  DELETE FROM doc_ops WHERE name = p_doc;
$$ LANGUAGE sql;
