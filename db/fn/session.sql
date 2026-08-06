-- Sessions — the token contract. Replaces the definitions 002 shipped.
--
-- The stored value is a SHA-256 digest; the raw token exists only in the
-- reply to session_start and in the client that holds it. See 006 for why,
-- and for the one-time rehash that carried existing sessions across.
--
-- pgAuth is only the wire adapter over these four — override them here and
-- the runtime does not change.

-- Mint a session: 256 bits of randomness, returned ONCE, stored hashed.
-- (gen_random_uuid gave 122 bits and went into the table verbatim.)
CREATE OR REPLACE FUNCTION session_start(p_user bigint)
RETURNS text AS $$
DECLARE v_token text;
BEGIN
  v_token := encode(gen_random_bytes(32), 'hex');
  INSERT INTO sessions (token, user_id, expires_at)
  VALUES (encode(sha256(v_token::bytea), 'hex'), p_user, now() + interval '7 days');
  RETURN v_token;
END;
$$ LANGUAGE plpgsql;

-- Resolve a raw token to its user, or NULL. Expiry is checked here, so a
-- stale row is never a valid session even before epsilon_prune sweeps it.
CREATE OR REPLACE FUNCTION session_get(p_token text)
RETURNS jsonb AS $$
  SELECT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = encode(sha256(p_token::bytea), 'hex')
    AND s.expires_at > now();
$$ LANGUAGE sql STABLE;

-- Sign out THIS session.
CREATE OR REPLACE FUNCTION session_end(p_token text)
RETURNS void AS $$
  DELETE FROM sessions WHERE token = encode(sha256(p_token::bytea), 'hex');
$$ LANGUAGE sql;

-- Sign out EVERYWHERE — the answer to "my laptop was stolen". Ending one
-- token cannot help when you don't know how many are out there, and a
-- 7-day expiry is a long time to wait.
CREATE OR REPLACE FUNCTION session_end_all(p_user bigint)
RETURNS bigint AS $$
  WITH gone AS (DELETE FROM sessions WHERE user_id = p_user RETURNING 1)
  SELECT count(*) FROM gone;
$$ LANGUAGE sql;
