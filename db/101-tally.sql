-- 101 — tally:<uid>: a declared read-only view (pgView, 0.7.0) wired into
-- the app for real. No table: it composes from boards/cards, which
-- 100-board.sql already owns, so there is nothing here to migrate later
-- — only the next number if the composition itself ever changes.
-- tally_open is composition AND permit, 001's rule verbatim: NULL user
-- composes the host's own copy; NULL result refuses.

CREATE OR REPLACE FUNCTION tally_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
  SELECT CASE WHEN p_user IS NOT NULL AND p_user <> doc_id(p_doc) THEN NULL ELSE
    jsonb_build_object(
      'boards', (SELECT COUNT(*) FROM boards b WHERE b.owner_id = doc_id(p_doc)),
      'cards',  (SELECT COUNT(*) FROM cards c JOIN boards b ON b.id = c.board_id
                  WHERE b.owner_id = doc_id(p_doc)),
      'done',   (SELECT COUNT(*) FROM cards c JOIN boards b ON b.id = c.board_id
                  WHERE b.owner_id = doc_id(p_doc) AND c.done))
  END;
$$ LANGUAGE sql STABLE;
