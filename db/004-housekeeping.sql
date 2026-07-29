-- 006 — housekeeping: bounded tables. doc_ops is catch-up AND audit, but
-- catch-up only ever needs ops newer than a live process's version — a
-- process further behind hits a gap and re-hydrates from the snapshot, by
-- design. So pruning old ops loses audit history ONLY. Expired sessions are
-- dead weight. server.ts calls this at boot; cron it in long-lived
-- deployments.

CREATE OR REPLACE FUNCTION epsilon_prune(p_keep interval DEFAULT '30 days')
RETURNS jsonb AS $$
DECLARE v_ops bigint; v_sessions bigint;
BEGIN
  DELETE FROM doc_ops WHERE at < now() - p_keep;
  GET DIAGNOSTICS v_ops = ROW_COUNT;
  DELETE FROM sessions WHERE expires_at < now();
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  RETURN jsonb_build_object('doc_ops', v_ops, 'sessions', v_sessions);
END;
$$ LANGUAGE plpgsql;
