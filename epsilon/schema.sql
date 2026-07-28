-- epsilon core schema — the DOC-NATIVE tier (docs as JSONB blobs).
-- Plain DDL only: at this tier the doc is the stored value, so ops apply in
-- TypeScript (the same op.ts the browser runs) and Postgres provides
-- durability + fan-out. The relational tier (docs as lenses over tables)
-- adds stored functions for composition and multi-table writes — see
-- DESIGN.md "Storage tiers".

CREATE TABLE IF NOT EXISTS docs (
  name text PRIMARY KEY,
  v bigint NOT NULL DEFAULT 0,
  data jsonb NOT NULL
);

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
