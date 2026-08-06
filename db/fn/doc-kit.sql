-- Kit overrides — the vocabulary editions of two 001/003 bodies. Numbered
-- files are frozen once released; behaviour evolves HERE, edited in place.
--
-- A NULL user READS as the host and WRITES as nobody. doc_open(doc, NULL)
-- composes the full copy (001's rule), but <t>_may(id, NULL) is false, so
-- calling a dispatch by hand as NULL raises 'not found: <doc>' out of
-- doc_begin — which reads like a missing doc and means a missing permit.
-- Deliberate (nothing writes anonymously); pass a real user id in debug
-- scripts.

-- The ONE read path (supersedes 001's body). NO default on p_user — that is
-- the point (007 dropped the old signature). A NULL user is still the HOST
-- composing its own full copy, but it must be WRITTEN: doc_open(name, NULL).
-- Forgetting the user was previously indistinguishable from being the host,
-- which made every forgetful custom method a permit bypass; now it is an
-- undefined-function error at the call site.
CREATE OR REPLACE FUNCTION doc_open(p_doc text, p_user bigint)
RETURNS jsonb AS $$
DECLARE v_fn text; v_data jsonb; v_out jsonb;
BEGIN
  SELECT open_fn, data INTO v_fn, v_data FROM docs WHERE name = p_doc;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_fn IS NULL THEN RETURN v_data; END IF;
  EXECUTE format('SELECT %I($1, $2)', v_fn) INTO v_out USING p_doc, p_user;
  RETURN v_out;
END;
$$ LANGUAGE plpgsql;

-- Express the change (supersedes 003's body): doc_commit now REFUSES a
-- root-path op. A dispatch that echoes a recomposition ("replace / {doc}")
-- satisfies the law trivially and destroys everything else the log is for:
-- history reads "someone replaced everything", undo conflicts with every
-- later write (a root path touches all paths), and who/what/why dissolve.
-- Nothing legitimate commits at root — snapshots ride hydrate, views never
-- commit, no inverse in 003's table is a root op — so the rule that was
-- prose ("a write never recomposes the doc") is now a shape the kit refuses.
CREATE OR REPLACE FUNCTION doc_commit(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL, p_undo jsonb DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE v_v bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ops) o WHERE o->>'path' IN ('', '/')) THEN
    RAISE EXCEPTION 'root op in doc_commit (%): express the change, never recompose — a root replace erases who/what from the log', p_doc;
  END IF;
  UPDATE docs SET v = v + 1 WHERE name = p_doc RETURNING v INTO v_v;
  IF v_v IS NULL THEN RETURN NULL; END IF;
  INSERT INTO doc_ops (name, v, ops, by_user, undo) VALUES (p_doc, v_v, p_ops, p_user, p_undo);
  PERFORM pg_notify('epsilon_ops', jsonb_build_object('name', p_doc, 'v', v_v)::text);
  RETURN jsonb_build_object('v', v_v, 'ops', p_ops);
END;
$$ LANGUAGE plpgsql;
