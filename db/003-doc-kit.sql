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
--                        never recomposes the doc.
--   one vocabulary       op_add / op_replace / op_remove build the resolved
--                        echo — the wire's three verbs, in SQL.
--
-- A doc type is then: <t>_open (ONE composition query) and
-- <t>_apply = doc_begin → dispatch loop → RETURN doc_commit.
-- 005-board.sql is board/mine built on it; rel.test.ts's `todo` type is
-- the minimal worked example.

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

-- Express the change: bump v, log the resolved ops, ring the doorbell.
-- Returns {v, ops} — or NULL when the doc row does not exist, so a mirror
-- into a never-seeded doc no-ops safely. Caller holds the row lock
-- (doc_begin for your own doc, doc_lock first for a mirror's).
CREATE OR REPLACE FUNCTION doc_commit(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE v_v bigint;
BEGIN
  UPDATE docs SET v = v + 1 WHERE name = p_doc RETURNING v INTO v_v;
  IF v_v IS NULL THEN RETURN NULL; END IF;
  INSERT INTO doc_ops (name, v, ops, by_user) VALUES (p_doc, v_v, p_ops, p_user);
  PERFORM pg_notify('epsilon_ops', jsonb_build_object('name', p_doc, 'v', v_v)::text);
  RETURN jsonb_build_object('v', v_v, 'ops', p_ops);
END;
$$ LANGUAGE plpgsql;

-- A doc dies whole: its registry row AND its log.
CREATE OR REPLACE FUNCTION doc_drop(p_doc text) RETURNS void AS $$
  DELETE FROM docs WHERE name = p_doc;
  DELETE FROM doc_ops WHERE name = p_doc;
$$ LANGUAGE sql;
