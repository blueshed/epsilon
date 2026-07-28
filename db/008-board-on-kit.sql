-- 008 — board_apply and mine_apply rewritten on the doc kit (007). Behavior
-- is 005's, including the canonical lock order; only the boilerplate moved
-- into the kit. One deliberate tightening: paths match EXACTLY now
-- ('/name/x' is unsupported, it no longer renames). This is the worked
-- example a new doc type copies — dispatch and DML are all that's left.

CREATE OR REPLACE FUNCTION board_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_bid bigint := doc_id(p_doc);
  v_owner bigint;
  v_op jsonb; v_p text[]; v_id bigint; v_row jsonb;
  v_out jsonb := '[]'::jsonb;
BEGIN
  -- Unlocked owner read is stable: owner_id never changes after creation.
  SELECT owner_id INTO v_owner FROM boards WHERE id = v_bid;

  -- Canonical lock order (005): a rename mirrors into the owner's mine doc,
  -- so that lock comes FIRST — and only for renaming batches.
  IF v_owner IS NOT NULL AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_ops) o
    WHERE o->>'op' = 'replace' AND o->>'path' = '/name'
  ) THEN
    PERFORM doc_lock('mine:' || v_owner);
  END IF;

  PERFORM doc_begin(p_doc, board_may(v_bid, p_user));

  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);

    IF v_p = ARRAY['cards', '-'] AND v_op->>'op' = 'add' THEN
      INSERT INTO cards (board_id, text, created_by)
        VALUES (v_bid, v_op->'value'->>'text', p_user)
        RETURNING id INTO v_id;
      v_out := v_out || op_add('/cards/' || v_id,
        jsonb_build_object('id', v_id, 'text', v_op->'value'->>'text', 'created_by', p_user));

    ELSIF array_length(v_p, 1) = 3 AND v_p[1] = 'cards' AND v_p[3] = 'text'
          AND v_op->>'op' = 'replace' THEN
      UPDATE cards SET text = v_op->>'value'
        WHERE id = v_p[2]::bigint AND board_id = v_bid
        RETURNING jsonb_build_object('id', id, 'text', text, 'created_by', created_by) INTO v_row;
      IF v_row IS NULL THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      v_out := v_out || op_replace('/cards/' || v_p[2], v_row);

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'cards' AND v_op->>'op' = 'remove' THEN
      DELETE FROM cards WHERE id = v_p[2]::bigint AND board_id = v_bid;
      IF FOUND THEN v_out := v_out || op_remove('/cards/' || v_p[2]); END IF;

    ELSIF v_p = ARRAY['name'] AND v_op->>'op' = 'replace' THEN
      UPDATE boards SET name = v_op->>'value' WHERE id = v_bid;
      v_out := v_out || jsonb_build_array(v_op);
      IF v_owner IS NOT NULL THEN
        -- Multi-doc write: same transaction, both versioned, both notified.
        -- doc_commit no-ops (NULL) when the mine doc was never seeded.
        PERFORM doc_commit('mine:' || v_owner,
          op_replace('/boards/' || v_bid,
            jsonb_build_object('id', v_bid, 'name', v_op->>'value')),
          p_user);
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;

  RETURN doc_commit(p_doc, v_out, p_user);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mine_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_uid bigint := doc_id(p_doc);
  v_op jsonb; v_p text[]; v_id bigint; v_name text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  -- Canonical order holds: mine IS this doc, locked first; the board doc
  -- rows created or dropped below come after.
  PERFORM doc_begin(p_doc, p_user = v_uid);

  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);

    IF v_p = ARRAY['boards', '-'] AND v_op->>'op' = 'add' THEN
      v_name := COALESCE(v_op->'value'->>'name', 'untitled');
      INSERT INTO boards (name, owner_id) VALUES (v_name, v_uid) RETURNING id INTO v_id;
      INSERT INTO docs (name, v, data, open_fn) VALUES ('board:' || v_id, 0, NULL, 'board_open');
      v_out := v_out || op_add('/boards/' || v_id, jsonb_build_object('id', v_id, 'name', v_name));

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'boards' AND v_op->>'op' = 'remove' THEN
      DELETE FROM boards WHERE id = v_p[2]::bigint AND owner_id = v_uid;
      IF FOUND THEN
        PERFORM doc_drop('board:' || v_p[2]);   -- cards cascade via FK
        v_out := v_out || op_remove('/boards/' || v_p[2]);
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;

  RETURN doc_commit(p_doc, v_out, p_user);
END;
$$ LANGUAGE plpgsql;
