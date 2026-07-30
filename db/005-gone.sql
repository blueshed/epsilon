-- 005 — gone is a snapshot of nothing: a doc that dies SAYS SO. Upgrades
-- 003's doc_drop (frozen forever, like every released core file — new core
-- behavior ships as the next number): the registry row and log still die
-- together, and now the doorbell rings {name, gone} — every process
-- hosting the doc un-hosts it (host.drop) and live watchers receive the
-- snapshot of nothing. Returns the name so a dispatch can collect what it
-- dropped into its result's `gone` array (see 100-board.sql's mine_apply),
-- which covers the WRITING process on engines with no listener (PGlite,
-- poll mode).

DROP FUNCTION IF EXISTS doc_drop(text);

CREATE FUNCTION doc_drop(p_doc text) RETURNS text AS $$
  DELETE FROM docs WHERE name = p_doc;
  DELETE FROM doc_ops WHERE name = p_doc;
  SELECT pg_notify('epsilon_ops', jsonb_build_object('name', p_doc, 'gone', true)::text);
  SELECT p_doc;
$$ LANGUAGE sql;
