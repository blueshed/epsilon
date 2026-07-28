-- 004 — per-user docs: mine:<uid> lists YOUR boards; creating a board is an
-- OP on that doc (creating a doc is itself an op). Also replaces
-- board_apply (forward-only: 003 stays untouched) so a board rename mirrors
-- into the owner's mine doc — one transaction, two docs, both notified.

CREATE OR REPLACE FUNCTION mine_uid(p_doc text) RETURNS bigint AS $$
  SELECT split_part(p_doc, ':', 2)::bigint;
$$ LANGUAGE sql IMMUTABLE;

-- Yours alone: anyone else composing this doc gets NULL.
CREATE OR REPLACE FUNCTION mine_open(p_doc text, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE v_uid bigint := mine_uid(p_doc);
BEGIN
  IF p_user IS NULL OR p_user <> v_uid THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'boards', COALESCE(
      (SELECT jsonb_object_agg(b.id::text, jsonb_build_object('id', b.id, 'name', b.name))
         FROM boards b WHERE b.owner_id = v_uid),
      '{}'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION mine_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_uid bigint := mine_uid(p_doc);
  v_op jsonb; v_parts text[]; v_id bigint; v_name text;
  v_out jsonb := '[]'::jsonb; v_v bigint;
BEGIN
  PERFORM 1 FROM docs WHERE name = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown doc: %', p_doc; END IF;
  IF p_user IS NULL OR p_user <> v_uid THEN
    RAISE EXCEPTION 'not found: %', p_doc;
  END IF;

  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_parts := regexp_split_to_array(ltrim(v_op->>'path', '/'), '/');

    -- add /boards/- : create an OWNED board AND its doc row. The echo carries
    -- the sequence id; the client then opens board:<id>.
    IF v_parts[1] = 'boards' AND v_parts[2] = '-' AND v_op->>'op' = 'add' THEN
      v_name := COALESCE(v_op->'value'->>'name', 'untitled');
      INSERT INTO boards (name, owner_id) VALUES (v_name, v_uid) RETURNING id INTO v_id;
      INSERT INTO docs (name, v, data, open_fn) VALUES ('board:' || v_id, 0, NULL, 'board_open');
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'op', 'add', 'path', '/boards/' || v_id,
        'value', jsonb_build_object('id', v_id, 'name', v_name)));

    -- remove /boards/<id> : cards cascade via FK; the board's doc row and
    -- log go too. (The hosted signal for a deleted doc lingers until process
    -- restart — doc GC is listed future work.)
    ELSIF v_parts[1] = 'boards' AND array_length(v_parts, 1) = 2 AND v_op->>'op' = 'remove' THEN
      DELETE FROM boards WHERE id = v_parts[2]::bigint AND owner_id = v_uid;
      IF FOUND THEN
        DELETE FROM docs WHERE name = 'board:' || v_parts[2];
        DELETE FROM doc_ops WHERE name = 'board:' || v_parts[2];
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'op', 'remove', 'path', '/boards/' || v_parts[2]));
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;

  UPDATE docs SET v = v + 1 WHERE name = p_doc RETURNING v INTO v_v;
  INSERT INTO doc_ops (name, v, ops, by_user) VALUES (p_doc, v_v, v_out, p_user);
  PERFORM pg_notify('epsilon_ops', jsonb_build_object('name', p_doc, 'v', v_v)::text);
  RETURN jsonb_build_object('v', v_v, 'ops', v_out);
END;
$$ LANGUAGE plpgsql;

-- board_apply v2 — identical to 003's except the name-replace branch now
-- MIRRORS into the owner's mine:<uid> doc: two docs, one transaction, both
-- versioned, both logged, both notified. This is the multi-doc write stored
-- functions exist for.
CREATE OR REPLACE FUNCTION board_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_bid bigint := split_part(p_doc, ':', 2)::bigint;
  v_owner bigint;
  v_op jsonb; v_parts text[]; v_id bigint; v_row jsonb;
  v_out jsonb := '[]'::jsonb; v_v bigint; v_mv bigint; v_mdoc text;
BEGIN
  PERFORM 1 FROM docs WHERE name = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown doc: %', p_doc; END IF;

  SELECT owner_id INTO v_owner FROM boards WHERE id = v_bid;
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
      -- Mirror into the owner's board list — same transaction.
      IF v_owner IS NOT NULL THEN
        v_mdoc := 'mine:' || v_owner;
        UPDATE docs SET v = v + 1 WHERE name = v_mdoc RETURNING v INTO v_mv;
        IF v_mv IS NOT NULL THEN
          INSERT INTO doc_ops (name, v, ops, by_user) VALUES (v_mdoc, v_mv, jsonb_build_array(
            jsonb_build_object('op', 'replace', 'path', '/boards/' || v_bid,
              'value', jsonb_build_object('id', v_bid, 'name', v_op->>'value'))), p_user);
          PERFORM pg_notify('epsilon_ops', jsonb_build_object('name', v_mdoc, 'v', v_mv)::text);
        END IF;
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;

  UPDATE docs SET v = v + 1 WHERE name = p_doc RETURNING v INTO v_v;
  INSERT INTO doc_ops (name, v, ops, by_user) VALUES (p_doc, v_v, v_out, p_user);
  PERFORM pg_notify('epsilon_ops', jsonb_build_object('name', p_doc, 'v', v_v)::text);
  RETURN jsonb_build_object('v', v_v, 'ops', v_out);
END;
$$ LANGUAGE plpgsql;
