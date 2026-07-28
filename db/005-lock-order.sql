-- 005 — lock order. board_apply (004) locked board → mine on a rename while
-- mine_apply's board delete locks mine → board: an AB-BA deadlock when a
-- rename and a delete of the same board race. Canonical order: the OWNER'S
-- MINE DOC FIRST, then board docs — mine_apply already does; this replaces
-- board_apply to match. Everything after the locks is 004's body unchanged.

CREATE OR REPLACE FUNCTION board_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_bid bigint := split_part(p_doc, ':', 2)::bigint;
  v_owner bigint;
  v_op jsonb; v_parts text[]; v_id bigint; v_row jsonb;
  v_out jsonb := '[]'::jsonb; v_v bigint; v_mv bigint; v_mdoc text;
BEGIN
  -- Unlocked pre-read is stable: owner_id never changes after creation. A
  -- concurrently DELETED board still fails below (board_may → 'not found').
  SELECT owner_id INTO v_owner FROM boards WHERE id = v_bid;

  -- Only a rename of an owned board ever touches the mine doc — lock it
  -- FIRST, and only then; other batches must not serialize through it.
  IF v_owner IS NOT NULL AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_ops) o
    WHERE o->>'op' = 'replace' AND ltrim(o->>'path', '/') = 'name'
  ) THEN
    PERFORM 1 FROM docs WHERE name = 'mine:' || v_owner FOR UPDATE;
  END IF;

  PERFORM 1 FROM docs WHERE name = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown doc: %', p_doc; END IF;

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
      -- Mirror into the owner's board list — same transaction; its docs row
      -- is already locked (above, before ours).
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
