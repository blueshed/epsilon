-- 003 — board: the RELATIONAL tier, app-owned SQL. Db-first: these tables
-- are the truth; the doc is composed FROM them. Stored functions do what
-- they're optimal at — composition (one round trip, where the data lives),
-- multi-table transactional writes with sequence-minted ids, and OWNERSHIP
-- enforcement at the function boundary.
-- Runtime glue is one line: pgDoc(host, sql, 'board:1', null, { apply: 'board_apply' }).

CREATE TABLE IF NOT EXISTS boards (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  owner_id bigint REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cards (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id bigint NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  text text NOT NULL,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);

-- Ownership: NULL owner = shared board (the seeded demo). Otherwise the
-- owner alone may read or write. One rule, both directions.
CREATE OR REPLACE FUNCTION board_may(p_bid bigint, p_user bigint) RETURNS boolean AS $$
  SELECT owner_id IS NULL OR owner_id = p_user FROM boards WHERE id = p_bid;
$$ LANGUAGE sql STABLE;

-- Composition: the doc, from the tables, in one statement — run at OPEN
-- time only. Writes never call this; they express the change as ops.
CREATE OR REPLACE FUNCTION board_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
DECLARE v_bid bigint := split_part(p_doc, ':', 2)::bigint;
BEGIN
  IF NOT COALESCE(board_may(v_bid, p_user), false) THEN RETURN NULL; END IF;
  RETURN (
    SELECT jsonb_build_object(
      'name', b.name,
      'owner_id', b.owner_id,
      'cards', COALESCE(
        (SELECT jsonb_object_agg(c.id::text,
           jsonb_build_object('id', c.id, 'text', c.text, 'created_by', c.created_by))
           FROM cards c WHERE c.board_id = b.id),
        '{}'::jsonb)
    )
    FROM boards b WHERE b.id = v_bid
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- The write path: ops in, resolved ops out, everything in ONE transaction.
-- FOR UPDATE on the docs row serializes writers per doc — real transactional
-- ordering, not optimistic retries. Ids come from the sequence: the client
-- sends '/cards/-' and learns the id from the echo.
CREATE OR REPLACE FUNCTION board_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_bid bigint := split_part(p_doc, ':', 2)::bigint;
  v_op jsonb; v_parts text[]; v_id bigint; v_row jsonb;
  v_out jsonb := '[]'::jsonb; v_v bigint;
BEGIN
  PERFORM 1 FROM docs WHERE name = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown doc: %', p_doc; END IF;

  -- Ownership is enforced HERE, at the function boundary, with the identity
  -- the socket authenticated. A user without rights gets the same message a
  -- missing board gets — no existence oracle.
  IF NOT COALESCE(board_may(v_bid, p_user), false) THEN
    RAISE EXCEPTION 'not found: %', p_doc;
  END IF;

  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_parts := regexp_split_to_array(ltrim(v_op->>'path', '/'), '/');

    IF v_parts[1] = 'cards' AND v_parts[2] = '-' AND v_op->>'op' = 'add' THEN
      INSERT INTO cards (board_id, text, created_by)
        VALUES (v_bid, v_op->'value'->>'text', p_user)
        RETURNING id INTO v_id;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'op', 'add', 'path', '/cards/' || v_id,
        'value', jsonb_build_object('id', v_id, 'text', v_op->'value'->>'text', 'created_by', p_user)));

    ELSIF v_parts[1] = 'cards' AND v_parts[3] = 'text' AND v_op->>'op' = 'replace' THEN
      UPDATE cards SET text = v_op->>'value'
        WHERE id = v_parts[2]::bigint AND board_id = v_bid
        RETURNING jsonb_build_object('id', id, 'text', text, 'created_by', created_by) INTO v_row;
      IF v_row IS NULL THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'op', 'replace', 'path', '/cards/' || v_parts[2], 'value', v_row));

    ELSIF v_parts[1] = 'cards' AND array_length(v_parts, 1) = 2 AND v_op->>'op' = 'remove' THEN
      DELETE FROM cards WHERE id = v_parts[2]::bigint AND board_id = v_bid;
      IF FOUND THEN
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'op', 'remove', 'path', '/cards/' || v_parts[2]));
      END IF;

    ELSIF v_parts[1] = 'name' AND v_op->>'op' = 'replace' THEN
      UPDATE boards SET name = v_op->>'value' WHERE id = v_bid;
      v_out := v_out || jsonb_build_array(v_op);

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;

  -- Express the change, never recompose: bump v, log the ops, notify.
  -- O(change) per write; composition is board_open's job at open time.
  -- doc_ops is the event log AND the audit trail (who, what, when) — and
  -- it's why NOTIFY never busts the 8k limit: the payload is a doorbell,
  -- listeners fetch the ops from here.
  UPDATE docs SET v = v + 1 WHERE name = p_doc RETURNING v INTO v_v;
  INSERT INTO doc_ops (name, v, ops, by_user) VALUES (p_doc, v_v, v_out, p_user);
  PERFORM pg_notify('epsilon_ops', jsonb_build_object('name', p_doc, 'v', v_v)::text);
  RETURN jsonb_build_object('v', v_v, 'ops', v_out);
END;
$$ LANGUAGE plpgsql;

-- Seed the shared demo board (owner_id NULL) and its doc row. Idempotent —
-- migrations are forward-only, so re-running 003 must be a no-op.
INSERT INTO boards (id, name) OVERRIDING SYSTEM VALUE VALUES (1, 'main')
  ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('boards', 'id'), GREATEST((SELECT max(id) FROM boards), 1));
INSERT INTO docs (name, v, data, open_fn) VALUES ('board:1', 0, NULL, 'board_open')
  ON CONFLICT (name) DO NOTHING;
