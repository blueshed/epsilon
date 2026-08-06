-- The board's vocabulary — supersedes the bodies 100-board.sql shipped
-- (that file predates db/fn/ and its hash is frozen in deployed ledgers;
-- behaviour evolves HERE, edited in place). What changed vs 100: cards
-- carry `pos` (102) — composed by card_json, minted max+1 on insert,
-- restored from the value, moved by a /pos replace branch that stamps and
-- widens like /done. board_open and mine_apply are unchanged and stay in
-- 100 (board_open picks up the new card_json at runtime).

-- ONE definition of a card's wire shape (now including pos).
CREATE OR REPLACE FUNCTION card_json(c cards) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'text', c.text, 'done', c.done, 'pos', c.pos,
    'created_by', c.created_by,
    'updated_by', c.updated_by, 'updated_at', c.updated_at);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION board_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_bid bigint := doc_id(p_doc);
  v_owner bigint; v_bname text;
  v_op jsonb; v_p text[]; v_id bigint; v_row jsonb; v_before jsonb;
  v_mid bigint; v_mrow record;
  v_mines bigint[] := '{}';
  v_out jsonb := '[]'::jsonb;
  v_undo jsonb := '[]'::jsonb;
BEGIN
  -- Unlocked reads, both stable: owner_id is immutable; name is only used
  -- for mirrors and re-set by any rename in this very batch.
  SELECT owner_id, name INTO v_owner, v_bname FROM boards WHERE id = v_bid;

  -- Pre-scan: every mine doc this batch could mirror into. Renames touch
  -- the owner's and every member's; member ops (add by email, restore by
  -- id, remove) touch that member's.
  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);
    IF v_p = ARRAY['name'] AND v_op->>'op' = 'replace' THEN
      v_mines := v_mines
        || COALESCE((SELECT array_agg(user_id) FROM board_members WHERE board_id = v_bid), '{}');
      IF v_owner IS NOT NULL THEN v_mines := v_mines || v_owner; END IF;
    ELSIF v_p = ARRAY['members', '-'] AND v_op->>'op' = 'add' THEN
      SELECT id INTO v_mid FROM users WHERE email = lower(trim(v_op->'value'->>'email'));
      IF v_mid IS NOT NULL THEN v_mines := v_mines || v_mid; END IF;
    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'members' AND v_p[2] ~ '^\d+$' THEN
      v_mines := v_mines || v_p[2]::bigint;
    END IF;
  END LOOP;

  -- Canonical order: mine docs ascending, THEN this board's doc.
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), '{}') INTO v_mines FROM unnest(v_mines) u;
  FOREACH v_mid IN ARRAY v_mines LOOP
    PERFORM doc_lock('mine:' || v_mid);
  END LOOP;
  PERFORM doc_begin(p_doc, board_may(v_bid, p_user));

  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);

    IF v_p = ARRAY['cards', '-'] AND v_op->>'op' = 'add' THEN
      -- New cards land at the end: pos is minted max+1, like the id but
      -- yours to move afterwards (102 — ordering is model data).
      INSERT INTO cards (board_id, text, created_by, updated_by, updated_at, pos)
        VALUES (v_bid, v_op->'value'->>'text', p_user, p_user, now(),
                COALESCE((SELECT max(pos) FROM cards WHERE board_id = v_bid), 0) + 1)
        RETURNING id, card_json(cards) INTO v_id, v_row;
      v_out := v_out || op_add('/cards/' || v_id, v_row);
      v_undo := op_remove('/cards/' || v_id) || v_undo;

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'cards' AND v_op->>'op' = 'add'
          AND v_p[2] ~ '^\d+$' THEN
      -- RESTORE: the echo of an add is an add at the resolved id. The row's
      -- fields (created_by, the stamp, and pos) ride the value, so an undo
      -- brings the row back EXACTLY as it was rather than re-attributing it;
      -- doc_ops.by_user still records who performed the restore. A value with
      -- no stamp (a hand-written add) is stamped by the writer instead.
      INSERT INTO cards (id, board_id, text, done, created_by, updated_by, updated_at, pos)
        OVERRIDING SYSTEM VALUE
        VALUES (v_p[2]::bigint, v_bid, v_op->'value'->>'text',
                COALESCE((v_op->'value'->>'done')::boolean, false),
                (v_op->'value'->>'created_by')::bigint,
                COALESCE((v_op->'value'->>'updated_by')::bigint, p_user),
                COALESCE((v_op->'value'->>'updated_at')::timestamptz, now()),
                COALESCE((v_op->'value'->>'pos')::double precision,
                         (SELECT COALESCE(max(pos), 0) FROM cards WHERE board_id = v_bid) + 1))
        RETURNING card_json(cards) INTO v_row;
      PERFORM doc_restore_id('cards');
      v_out := v_out || op_add('/cards/' || v_p[2], v_row);
      v_undo := op_remove('/cards/' || v_p[2]) || v_undo;

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'cards' AND v_op->>'op' = 'replace' THEN
      -- Whole-row replace — the echo shape; created_by is immutable. Like the
      -- restore above, a value CARRYING a stamp keeps it (that is undo putting
      -- the row back); an ordinary edit carries none and is stamped here. A
      -- value with no pos keeps the row where it is.
      SELECT card_json(c) INTO v_before FROM cards c WHERE c.id = v_p[2]::bigint AND c.board_id = v_bid;
      IF NOT FOUND THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      UPDATE cards SET text = v_op->'value'->>'text',
                       done = COALESCE((v_op->'value'->>'done')::boolean, false),
                       updated_by = COALESCE((v_op->'value'->>'updated_by')::bigint, p_user),
                       updated_at = COALESCE((v_op->'value'->>'updated_at')::timestamptz, now()),
                       pos = COALESCE((v_op->'value'->>'pos')::double precision, pos)
        WHERE id = v_p[2]::bigint AND board_id = v_bid
        RETURNING card_json(cards) INTO v_row;
      v_out := v_out || op_replace('/cards/' || v_p[2], v_row);
      v_undo := op_replace('/cards/' || v_p[2], v_before) || v_undo;

    ELSIF array_length(v_p, 1) = 3 AND v_p[1] = 'cards' AND v_p[3] = 'text'
          AND v_op->>'op' = 'replace' THEN
      SELECT to_jsonb(text) INTO v_before FROM cards WHERE id = v_p[2]::bigint AND board_id = v_bid;
      IF NOT FOUND THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      UPDATE cards SET text = v_op->>'value', updated_by = p_user, updated_at = now()
        WHERE id = v_p[2]::bigint AND board_id = v_bid
        RETURNING card_json(cards) INTO v_row;
      v_out := v_out || op_replace('/cards/' || v_p[2], v_row);
      v_undo := op_replace('/cards/' || v_p[2] || '/text', v_before) || v_undo;

    ELSIF array_length(v_p, 1) = 3 AND v_p[1] = 'cards' AND v_p[3] = 'done'
          AND v_op->>'op' = 'replace' THEN
      SELECT to_jsonb(done) INTO v_before FROM cards WHERE id = v_p[2]::bigint AND board_id = v_bid;
      IF NOT FOUND THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      UPDATE cards SET done = (v_op->>'value')::boolean, updated_by = p_user, updated_at = now()
        WHERE id = v_p[2]::bigint AND board_id = v_bid
        RETURNING card_json(cards) INTO v_row;
      -- The echo widened to the whole row when the stamp arrived: an op that
      -- changes two columns must SAY so, or the client's copy stops matching
      -- a recompute (the law rel.test.ts drives). The undo stays narrow — it
      -- only has to put `done` back, and re-stamps as the undoer on its way.
      v_out := v_out || op_replace('/cards/' || v_p[2], v_row);
      v_undo := op_replace(v_op->>'path', v_before) || v_undo;

    ELSIF array_length(v_p, 1) = 3 AND v_p[1] = 'cards' AND v_p[3] = 'pos'
          AND v_op->>'op' = 'replace' THEN
      -- A MOVE (102). Same discipline as /done: the stamp makes it two
      -- columns, so the echo widens to the row; the undo stays narrow. The
      -- client sends moves as a SWAP — two of these in one batch.
      SELECT to_jsonb(pos) INTO v_before FROM cards WHERE id = v_p[2]::bigint AND board_id = v_bid;
      IF NOT FOUND THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      UPDATE cards SET pos = (v_op->>'value')::double precision, updated_by = p_user, updated_at = now()
        WHERE id = v_p[2]::bigint AND board_id = v_bid
        RETURNING card_json(cards) INTO v_row;
      v_out := v_out || op_replace('/cards/' || v_p[2], v_row);
      v_undo := op_replace(v_op->>'path', v_before) || v_undo;

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'cards' AND v_op->>'op' = 'remove' THEN
      SELECT card_json(c) INTO v_before FROM cards c WHERE c.id = v_p[2]::bigint AND c.board_id = v_bid;
      DELETE FROM cards WHERE id = v_p[2]::bigint AND board_id = v_bid;
      IF FOUND THEN
        v_out := v_out || op_remove('/cards/' || v_p[2]);
        v_undo := op_add('/cards/' || v_p[2], v_before) || v_undo;
      END IF;

    ELSIF v_p = ARRAY['name'] AND v_op->>'op' = 'replace' THEN
      v_undo := op_replace('/name', to_jsonb(v_bname)) || v_undo;
      UPDATE boards SET name = v_op->>'value' WHERE id = v_bid;
      v_bname := v_op->>'value';
      v_out := v_out || jsonb_build_array(v_op);
      -- Mirror the new name into every list that shows it — pre-locked
      -- mines only (see header); doc_commit no-ops on never-seeded docs.
      FOR v_mid IN
        SELECT user_id FROM board_members WHERE board_id = v_bid AND user_id = ANY(v_mines)
        UNION SELECT v_owner WHERE v_owner IS NOT NULL AND v_owner = ANY(v_mines)
      LOOP
        PERFORM doc_commit('mine:' || v_mid,
          op_replace('/boards/' || v_bid || '/name', to_jsonb(v_op->>'value')), p_user);
      END LOOP;

    ELSIF v_p = ARRAY['members', '-'] AND v_op->>'op' = 'add' THEN
      -- Owner only; minted BY EMAIL — the client never learns ids it
      -- couldn't already see.
      IF v_owner IS NULL OR p_user IS DISTINCT FROM v_owner THEN
        RAISE EXCEPTION 'owner only: %', v_op->>'path';
      END IF;
      -- Emails compare NORMALIZED (002's rule) — "  Pete@…  " finds pete@….
      SELECT id, name, email INTO v_mrow FROM users WHERE email = lower(trim(v_op->'value'->>'email'));
      IF v_mrow.id IS NULL THEN
        RAISE EXCEPTION 'unknown user: %', v_op->'value'->>'email';
      END IF;
      IF v_mrow.id = v_owner OR EXISTS (
        SELECT 1 FROM board_members WHERE board_id = v_bid AND user_id = v_mrow.id
      ) THEN
        RAISE EXCEPTION 'already a member: %', v_mrow.email;
      END IF;
      INSERT INTO board_members (board_id, user_id) VALUES (v_bid, v_mrow.id);
      v_out := v_out || op_add('/members/' || v_mrow.id,
        jsonb_build_object('id', v_mrow.id, 'name', v_mrow.name, 'email', v_mrow.email));
      v_undo := op_remove('/members/' || v_mrow.id) || v_undo;
      PERFORM doc_commit('mine:' || v_mrow.id,
        op_add('/boards/' || v_bid,
          jsonb_build_object('id', v_bid, 'name', v_bname, 'shared', true)),
        p_user);

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'members' AND v_op->>'op' = 'add' THEN
      -- RESTORE a member by id (the echo shape; the undo of a remove).
      -- Owner only — someone who LEFT is no longer a member, cannot write
      -- here at all, and rejoins by invitation, not by undo.
      IF v_owner IS NULL OR p_user IS DISTINCT FROM v_owner THEN
        RAISE EXCEPTION 'owner only: %', v_op->>'path';
      END IF;
      v_mid := v_p[2]::bigint;
      SELECT id, name, email INTO v_mrow FROM users WHERE id = v_mid;
      IF v_mrow.id IS NULL THEN RAISE EXCEPTION 'unknown user: %', v_mid; END IF;
      IF v_mid = v_owner OR EXISTS (
        SELECT 1 FROM board_members WHERE board_id = v_bid AND user_id = v_mid
      ) THEN
        RAISE EXCEPTION 'already a member: %', v_mrow.email;
      END IF;
      INSERT INTO board_members (board_id, user_id) VALUES (v_bid, v_mid);
      v_out := v_out || op_add('/members/' || v_mid,
        jsonb_build_object('id', v_mid, 'name', v_mrow.name, 'email', v_mrow.email));
      v_undo := op_remove('/members/' || v_mid) || v_undo;
      PERFORM doc_commit('mine:' || v_mid,
        op_add('/boards/' || v_bid,
          jsonb_build_object('id', v_bid, 'name', v_bname, 'shared', true)),
        p_user);

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'members' AND v_op->>'op' = 'remove' THEN
      -- The owner removes anyone; a member removes themselves (leaving).
      v_mid := v_p[2]::bigint;
      IF p_user IS DISTINCT FROM v_owner AND p_user IS DISTINCT FROM v_mid THEN
        RAISE EXCEPTION 'owner only: %', v_op->>'path';
      END IF;
      SELECT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email) INTO v_before
        FROM board_members m JOIN users u ON u.id = m.user_id
        WHERE m.board_id = v_bid AND m.user_id = v_mid;
      DELETE FROM board_members WHERE board_id = v_bid AND user_id = v_mid;
      IF FOUND THEN
        v_out := v_out || op_remove('/members/' || v_mid);
        v_undo := op_add('/members/' || v_mid, v_before) || v_undo;
        PERFORM doc_commit('mine:' || v_mid, op_remove('/boards/' || v_bid), p_user);
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;

  RETURN doc_commit(p_doc, v_out, p_user, v_undo);
END;
$$ LANGUAGE plpgsql;
