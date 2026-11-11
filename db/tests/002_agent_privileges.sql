BEGIN;
SET LOCAL ROLE sales_agent;
DO $$
DECLARE l uuid; c uuid; m uuid;
BEGIN
  INSERT INTO leads(business_name, domain, source_url)
    VALUES ('Agent Test','agenttest.example','https://s.example') RETURNING id INTO l;
  INSERT INTO contacts(lead_id, email, source_url)
    VALUES (l,'a@agenttest.example','https://s.example/c') RETURNING id INTO c;
  INSERT INTO outbound_messages(lead_id, contact_id, kind, subject, body, idempotency_key)
    VALUES (l, c, 'initial', 's', 'b', 'agent-k1') RETURNING id INTO m;
  UPDATE outbound_messages SET status = 'pending_approval' WHERE id = m;
  INSERT INTO audit_log(actor, action, entity) VALUES ('agent','test','x');
  RAISE NOTICE 'A1 agent drafts + queues + audits : PASS (allowed)';

  BEGIN
    UPDATE outbound_messages SET status = 'approved', approved_at = now() WHERE id = m;
    RAISE NOTICE 'A2 agent approves message        : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'A2 agent approves message        : PASS (blocked)';
  END;

  BEGIN
    DELETE FROM leads WHERE id = l;
    RAISE NOTICE 'A3 agent deletes lead            : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'A3 agent deletes lead            : PASS (blocked)';
  END;

  BEGIN
    DELETE FROM suppressions;
    RAISE NOTICE 'A4 agent edits suppression list  : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'A4 agent edits suppression list  : PASS (blocked)';
  END;

  BEGIN
    UPDATE audit_log SET action = 'tampered';
    RAISE NOTICE 'A5 agent edits audit log         : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'A5 agent edits audit log         : PASS (blocked)';
  END;
END $$;
ROLLBACK;