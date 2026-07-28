-- 002 — schema-native users. The auth CONTRACT lives here, in stored
-- functions (delta's shape): composable from SQL, overridable by later
-- migrations, hashing where the data lives (pgcrypto bcrypt, cost 12).

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
