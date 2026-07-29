-- 009 — sharing: a board is owner-or-public no more — MEMBERS. One new
-- table, board_may grown to include it, and the doc functions rebuilt on
-- the kit so membership flows everywhere it must:
--
--   board_open   composes /members {uid: {id, name, email}}
--   mine_open    lists boards you own AND boards shared with you
--   board_apply  add /members/- {email} (owner only, minted by email),
--                remove /members/<uid> (owner, or yourself — leaving),
--                each mirrored into that member's mine doc
--   mine_apply   remove /boards/<id> now means DELETE when you own it
--                (mirrored out of every member's mine) and LEAVE when you
--                don't (mirrored into the board's /members)
--
-- Cards also grow `done` (the third verb-shape in the demo): a boolean the
-- UI toggles with one replace op.
--
-- CANONICAL LOCK ORDER, generalized from 005: every transaction locks ALL
-- the mine docs it will touch in ASCENDING uid order, THEN board docs in
-- ascending id order. Both functions pre-scan the batch and take the locks
-- up front; dispatch then only commits into docs already locked. Mirror
-- targets are re-read under the board lock and INTERSECTED with the
-- pre-locked set, so a membership change that races the pre-scan can only
-- SKIP a mirror, never lock out of order. A skipped mirror leaves a stale
-- name (or a ghost entry) in one mine list until that doc re-opens —
-- recompute-from-state heals it; the tables are always right.

CREATE TABLE IF NOT EXISTS board_members (
  board_id bigint NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS done boolean NOT NULL DEFAULT false;

-- One rule, both directions, now three doors: public, owner, member.
CREATE OR REPLACE FUNCTION board_may(p_bid bigint, p_user bigint) RETURNS boolean AS $$
  SELECT b.owner_id IS NULL OR b.owner_id = p_user
      OR EXISTS (SELECT 1 FROM board_members m
                 WHERE m.board_id = b.id AND m.user_id = p_user)
  FROM boards b WHERE b.id = p_bid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION board_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
DECLARE v_bid bigint := doc_id(p_doc);
BEGIN
  IF NOT COALESCE(board_may(v_bid, p_user), false) THEN RETURN NULL; END IF;
  RETURN (
    SELECT jsonb_build_object(
      'name', b.name,
      'owner_id', b.owner_id,
      'cards', COALESCE(
        (SELECT jsonb_object_agg(c.id::text,
           jsonb_build_object('id', c.id, 'text', c.text, 'done', c.done, 'created_by', c.created_by))
           FROM cards c WHERE c.board_id = b.id),
        '{}'::jsonb),
      'members', COALESCE(
        (SELECT jsonb_object_agg(u.id::text,
           jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email))
           FROM board_members m JOIN users u ON u.id = m.user_id
           WHERE m.board_id = b.id),
        '{}'::jsonb)
    )
    FROM boards b WHERE b.id = v_bid
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Owned and shared-with-you, one list; `shared` marks the ones you can
-- leave but not delete.
CREATE OR REPLACE FUNCTION mine_open(p_doc text, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE v_uid bigint := mine_uid(p_doc);
BEGIN
  IF p_user IS NULL OR p_user <> v_uid THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'boards', COALESCE(
      (SELECT jsonb_object_agg(x.id::text, x.ref) FROM (
         SELECT b.id, jsonb_build_object('id', b.id, 'name', b.name) AS ref
           FROM boards b WHERE b.owner_id = v_uid
         UNION ALL
         SELECT b.id, jsonb_build_object('id', b.id, 'name', b.name, 'shared', true) AS ref
           FROM boards b JOIN board_members m ON m.board_id = b.id
           WHERE m.user_id = v_uid
       ) x),
      '{}'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION board_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  v_bid bigint := doc_id(p_doc);
  v_owner bigint; v_bname text;
  v_op jsonb; v_p text[]; v_id bigint; v_row jsonb;
  v_mid bigint; v_mrow record;
  v_mines bigint[] := '{}';
  v_out jsonb := '[]'::jsonb;
BEGIN
  -- Unlocked reads, both stable: owner_id is immutable; name is only used
  -- for mirrors and re-set by any rename in this very batch.
  SELECT owner_id, name INTO v_owner, v_bname FROM boards WHERE id = v_bid;

  -- Pre-scan: every mine doc this batch could mirror into. Renames touch
  -- the owner's and every member's; member ops touch that member's.
  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);
    IF v_p = ARRAY['name'] AND v_op->>'op' = 'replace' THEN
      v_mines := v_mines
        || COALESCE((SELECT array_agg(user_id) FROM board_members WHERE board_id = v_bid), '{}');
      IF v_owner IS NOT NULL THEN v_mines := v_mines || v_owner; END IF;
    ELSIF v_p = ARRAY['members', '-'] AND v_op->>'op' = 'add' THEN
      SELECT id INTO v_mid FROM users WHERE email = v_op->'value'->>'email';
      IF v_mid IS NOT NULL THEN v_mines := v_mines || v_mid; END IF;
    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'members' AND v_op->>'op' = 'remove' THEN
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
      INSERT INTO cards (board_id, text, created_by)
        VALUES (v_bid, v_op->'value'->>'text', p_user)
        RETURNING id INTO v_id;
      v_out := v_out || op_add('/cards/' || v_id,
        jsonb_build_object('id', v_id, 'text', v_op->'value'->>'text', 'done', false, 'created_by', p_user));

    ELSIF array_length(v_p, 1) = 3 AND v_p[1] = 'cards' AND v_p[3] = 'text'
          AND v_op->>'op' = 'replace' THEN
      UPDATE cards SET text = v_op->>'value'
        WHERE id = v_p[2]::bigint AND board_id = v_bid
        RETURNING jsonb_build_object('id', id, 'text', text, 'done', done, 'created_by', created_by) INTO v_row;
      IF v_row IS NULL THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      v_out := v_out || op_replace('/cards/' || v_p[2], v_row);

    ELSIF array_length(v_p, 1) = 3 AND v_p[1] = 'cards' AND v_p[3] = 'done'
          AND v_op->>'op' = 'replace' THEN
      UPDATE cards SET done = (v_op->>'value')::boolean
        WHERE id = v_p[2]::bigint AND board_id = v_bid;
      IF NOT FOUND THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      v_out := v_out || op_replace(v_op->>'path', v_op->'value');

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'cards' AND v_op->>'op' = 'remove' THEN
      DELETE FROM cards WHERE id = v_p[2]::bigint AND board_id = v_bid;
      IF FOUND THEN v_out := v_out || op_remove('/cards/' || v_p[2]); END IF;

    ELSIF v_p = ARRAY['name'] AND v_op->>'op' = 'replace' THEN
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
      SELECT id, name, email INTO v_mrow FROM users WHERE email = v_op->'value'->>'email';
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
      PERFORM doc_commit('mine:' || v_mrow.id,
        op_add('/boards/' || v_bid,
          jsonb_build_object('id', v_bid, 'name', v_bname, 'shared', true)),
        p_user);

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'members' AND v_op->>'op' = 'remove' THEN
      -- The owner removes anyone; a member removes themselves (leaving).
      v_mid := v_p[2]::bigint;
      IF p_user IS DISTINCT FROM v_owner AND p_user IS DISTINCT FROM v_mid THEN
        RAISE EXCEPTION 'owner only: %', v_op->>'path';
      END IF;
      DELETE FROM board_members WHERE board_id = v_bid AND user_id = v_mid;
      IF FOUND THEN
        v_out := v_out || op_remove('/members/' || v_mid);
        PERFORM doc_commit('mine:' || v_mid, op_remove('/boards/' || v_bid), p_user);
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
  v_uid bigint := mine_uid(p_doc);
  v_op jsonb; v_p text[]; v_id bigint; v_bid bigint; v_name text;
  v_mid bigint;
  v_mines bigint[] := ARRAY[v_uid];
  v_boards bigint[] := '{}';
  v_members bigint[];
  v_out jsonb := '[]'::jsonb;
BEGIN
  -- Pre-scan: a board removal touches that board's doc and — when we own
  -- it — every member's mine doc.
  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);
    IF array_length(v_p, 1) = 2 AND v_p[1] = 'boards' AND v_op->>'op' = 'remove' THEN
      v_bid := v_p[2]::bigint;
      v_boards := v_boards || v_bid;
      v_mines := v_mines
        || COALESCE((SELECT array_agg(user_id) FROM board_members WHERE board_id = v_bid), '{}');
    END IF;
  END LOOP;

  -- Canonical order: mine docs ascending (ours re-locked by doc_begin —
  -- harmless), then board docs ascending.
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), '{}') INTO v_mines FROM unnest(v_mines) u;
  FOREACH v_mid IN ARRAY v_mines LOOP
    PERFORM doc_lock('mine:' || v_mid);
  END LOOP;
  SELECT COALESCE(array_agg(DISTINCT b ORDER BY b), '{}') INTO v_boards FROM unnest(v_boards) b;
  FOREACH v_bid IN ARRAY v_boards LOOP
    PERFORM doc_lock('board:' || v_bid);
  END LOOP;
  PERFORM doc_begin(p_doc, p_user = v_uid);

  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);

    IF v_p = ARRAY['boards', '-'] AND v_op->>'op' = 'add' THEN
      v_name := COALESCE(v_op->'value'->>'name', 'untitled');
      INSERT INTO boards (name, owner_id) VALUES (v_name, v_uid) RETURNING id INTO v_id;
      INSERT INTO docs (name, v, data, open_fn) VALUES ('board:' || v_id, 0, NULL, 'board_open');
      v_out := v_out || op_add('/boards/' || v_id, jsonb_build_object('id', v_id, 'name', v_name));

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'boards' AND v_op->>'op' = 'remove' THEN
      v_bid := v_p[2]::bigint;
      -- Members read under the board lock, intersected with the pre-locked
      -- set (see header) — captured BEFORE the FK cascade erases them.
      SELECT COALESCE(array_agg(user_id), '{}') INTO v_members
        FROM board_members WHERE board_id = v_bid AND user_id = ANY(v_mines);
      DELETE FROM boards WHERE id = v_bid AND owner_id = v_uid;
      IF FOUND THEN
        -- Ours: the board dies whole — doc row, log, and every member's
        -- mine entry (cards and memberships cascade via FK).
        PERFORM doc_drop('board:' || v_bid);
        v_out := v_out || op_remove('/boards/' || v_bid);
        FOREACH v_mid IN ARRAY v_members LOOP
          PERFORM doc_commit('mine:' || v_mid, op_remove('/boards/' || v_bid), p_user);
        END LOOP;
      ELSE
        -- Not ours: LEAVING a shared board — the membership row goes, the
        -- board doc hears it, the board itself lives on.
        DELETE FROM board_members WHERE board_id = v_bid AND user_id = v_uid;
        IF FOUND THEN
          v_out := v_out || op_remove('/boards/' || v_bid);
          PERFORM doc_commit('board:' || v_bid, op_remove('/members/' || v_uid), p_user);
        END IF;
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;

  RETURN doc_commit(p_doc, v_out, p_user);
END;
$$ LANGUAGE plpgsql;
