-- 002 — schema-native users. The auth CONTRACT lives here, in stored
-- functions (delta's shape): composable from SQL, overridable by later
-- migrations, hashing where the data lives (pgcrypto bcrypt, cost 12).
--
-- Two doors, one identity: a password (register's anchor, and the CLI's
-- door) and PASSKEYS (WebAuthn) — credentials live beside users and
-- sessions, counter policy in credential_use. The ceremony itself is
-- epsilon/passkey.ts: pgcrypto has no ECDSA, so TS owns the crypto the
-- way it owns transport; SQL owns identity and state.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id text PRIMARY KEY,                 -- base64url credential id, minted by the authenticator
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key jsonb NOT NULL,           -- JWK (ES256 or RS256), WebCrypto-ready
  sign_count bigint NOT NULL DEFAULT 0,
  transports jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

-- Returns the public user row. Unique-violation bubbles to the caller.
CREATE OR REPLACE FUNCTION register(p_name text, p_email text, p_password text)
RETURNS jsonb AS $$
DECLARE u users;
BEGIN
  INSERT INTO users (email, name, password_hash)
  VALUES (p_email, p_name, crypt(p_password, gen_salt('bf', 12)))
  RETURNING * INTO u;
  RETURN jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email);
END;
$$ LANGUAGE plpgsql;

-- NULL on unknown email OR wrong password — indistinguishable to the caller,
-- and the dummy crypt keeps timing uniform when the email doesn't exist.
CREATE OR REPLACE FUNCTION login(p_email text, p_password text)
RETURNS jsonb AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE email = p_email;
  IF NOT FOUND THEN
    PERFORM crypt(p_password, gen_salt('bf', 12));
    RETURN NULL;
  END IF;
  IF u.password_hash <> crypt(p_password, u.password_hash) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION session_start(p_user bigint)
RETURNS text AS $$
  INSERT INTO sessions (token, user_id, expires_at)
  VALUES (gen_random_uuid()::text, p_user, now() + interval '7 days')
  RETURNING token;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION session_get(p_token text)
RETURNS jsonb AS $$
  SELECT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > now();
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION session_end(p_token text)
RETURNS void AS $$
  DELETE FROM sessions WHERE token = p_token;
$$ LANGUAGE sql;

-- Passkeys. Challenges are per-socket and ephemeral (they die with the
-- connection) — no table for them.

-- Store a verified credential. Duplicate ids bubble as unique violations.
CREATE OR REPLACE FUNCTION credential_register(p_user bigint, p_id text, p_key jsonb, p_transports jsonb DEFAULT NULL)
RETURNS void AS $$
  INSERT INTO credentials (id, user_id, public_key, transports)
  VALUES (p_id, p_user, p_key, p_transports);
$$ LANGUAGE sql;

-- The key and counter the ceremony needs; NULL for unknown ids.
CREATE OR REPLACE FUNCTION credential_get(p_id text)
RETURNS jsonb AS $$
  SELECT jsonb_build_object('user_id', user_id, 'public_key', public_key, 'sign_count', sign_count)
  FROM credentials WHERE id = p_id;
$$ LANGUAGE sql STABLE;

-- A VERIFIED assertion spends the credential: advance the counter and
-- return the public user row. NULL = counter regression (a cloned
-- authenticator replaying old state) — refuse. Counters stuck at zero are
-- normal (synced platform passkeys don't count).
CREATE OR REPLACE FUNCTION credential_use(p_id text, p_count bigint)
RETURNS jsonb AS $$
  WITH spent AS (
    UPDATE credentials SET sign_count = p_count
    WHERE id = p_id AND (p_count > sign_count OR (p_count = 0 AND sign_count = 0))
    RETURNING user_id
  )
  SELECT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)
  FROM spent s JOIN users u ON u.id = s.user_id;
$$ LANGUAGE sql;

-- A user's credential ids — login_begin's allowCredentials when an email
-- is offered (the non-discoverable path).
CREATE OR REPLACE FUNCTION credential_list(p_email text)
RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'transports', c.transports)), '[]'::jsonb)
  FROM credentials c JOIN users u ON u.id = c.user_id
  WHERE u.email = p_email;
$$ LANGUAGE sql STABLE;
