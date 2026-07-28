-- 001 — epsilon core: the doc registry, the event log, the one read path.
-- Applied by migrate() in order, recorded by name + hash, forward-only:
-- NEVER edit an applied file — write the next number.

-- data: the doc itself (doc-native tier) — NULL for relational docs, whose
-- state lives in tables and composes at open. Writes NEVER recompose; they
-- express the change (doc_ops) and bump v.
CREATE TABLE IF NOT EXISTS docs (
  name text PRIMARY KEY,
  v bigint NOT NULL DEFAULT 0,
  data jsonb,
  open_fn text
);

-- The event log AND the audit trail (who, what, when). Also why NOTIFY never
-- busts the 8k limit: the payload is a doorbell {name, v}; listeners fetch
-- the ops from here.
CREATE TABLE IF NOT EXISTS doc_ops (
  name text NOT NULL,
  v bigint NOT NULL,
  ops jsonb NOT NULL,
  by_user bigint,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, v)
);

-- The ONE read path for both tiers: stored data, or composed on demand.
-- Composition functions take (doc, user) and return NULL when the user may
-- not see the doc — scoping lives with the data, not in the runtime.
CREATE OR REPLACE FUNCTION doc_open(p_doc text, p_user bigint DEFAULT NULL)
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
