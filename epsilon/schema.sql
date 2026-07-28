-- epsilon core schema — the DOC-NATIVE tier (docs as JSONB blobs).
-- Plain DDL only: at this tier the doc is the stored value, so ops apply in
-- TypeScript (the same op.ts the browser runs) and Postgres provides
-- durability + fan-out. The relational tier (docs as lenses over tables)
-- adds stored functions for composition and multi-table writes — see
-- DESIGN.md "Storage tiers".

-- data: the doc itself (doc-native tier) — NULL for relational docs, whose
-- state lives in tables and composes at open. open_fn: the composition
-- function for relational docs. Writes NEVER recompose; they express the
-- change (doc_ops) and bump v. Composition is an open-time cost only.
CREATE TABLE IF NOT EXISTS docs (
  name text PRIMARY KEY,
  v bigint NOT NULL DEFAULT 0,
  data jsonb,
  open_fn text
);
ALTER TABLE docs ALTER COLUMN data DROP NOT NULL;
ALTER TABLE docs ADD COLUMN IF NOT EXISTS open_fn text;

-- The ONE read path for both tiers: stored data, or composed on demand.
CREATE OR REPLACE FUNCTION doc_open(p_doc text) RETURNS jsonb AS $$
DECLARE v_fn text; v_data jsonb; v_out jsonb;
BEGIN
  SELECT open_fn, data INTO v_fn, v_data FROM docs WHERE name = p_doc;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_fn IS NULL THEN RETURN v_data; END IF;
  EXECUTE format('SELECT %I($1)', v_fn) INTO v_out USING p_doc;
  RETURN v_out;
END;
$$ LANGUAGE plpgsql;

-- Every write, forever: the op log delta's temporal tables approximated.
-- Catch-up (v > last seen) and audit both read from here.
CREATE TABLE IF NOT EXISTS doc_ops (
  name text NOT NULL,
  v bigint NOT NULL,
  ops jsonb NOT NULL,
  by_user bigint,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, v)
);

-- Users are schema-native: present from day one (DESIGN.md decision 3).
CREATE TABLE IF NOT EXISTS users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Server-side sessions: a random token, no JWT, no signing dependency.
CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
