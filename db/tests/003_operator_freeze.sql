BEGIN;
DO $$
DECLARE l uuid; c uuid; m uuid; h text;
BEGIN
  INSERT INTO leads(business_name, domain, source_url)
    VALUES ('Op Test','optest.example','https://s.example') RETURNING id INTO l;
  INSERT INTO contacts(lead_id, email, source_url)
    VALUES (l,'hi@optest.example','https://s.example/c') RETURNING id INTO c;

  SET LOCAL ROLE sales_agent;
  INSERT INTO outbound_messages(lead_id, contact_id, kind, subject, body, idempotency_key)
    VALUES (l, c, 'initial', 'Subject', 'Original body', 'op-k1') RETURNING id INTO m;
  UPDATE outbound_messages SET status = 'pending_approval' WHERE id = m;
  SELECT content_sha256 INTO h FROM outbound_messages WHERE id = m;
  RESET ROLE;
  IF h ~ '^[0-9a-f]{64}$' THEN RAISE NOTICE 'T1 DB computes hash on submit      : PASS';
  ELSE RAISE NOTICE 'T1 DB computes hash on submit      : FAIL'; END IF;

  SET LOCAL ROLE sales_agent;
  BEGIN
    UPDATE outbound_messages SET body = 'Changed after submit' WHERE id = m;
    RAISE NOTICE 'T2 agent edits body after submit  : FAIL (was allowed)';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'T2 agent edits body after submit  : PASS (blocked)';
  END;
  BEGIN
    UPDATE contacts SET email = 'evil@evil.example' WHERE id = c;
    RAISE NOTICE 'T3 agent changes contact email    : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T3 agent changes contact email    : PASS (blocked)';
  END;
  BEGIN
    UPDATE outbound_messages SET approved_at = now() WHERE id = m;
    RAISE NOTICE 'T4 agent sets approved_at         : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T4 agent sets approved_at         : PASS (blocked)';
  END;
  BEGIN
    INSERT INTO outbound_messages(lead_id, contact_id, kind, sequence_step, subject, body, idempotency_key, sent_at)
      VALUES (l, c, 'follow_up', 1, 's', 'b', 'op-k2', now());
    RAISE NOTICE 'T5 agent inserts with sent_at     : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T5 agent inserts with sent_at     : PASS (blocked)';
  END;
  RESET ROLE;

  SET LOCAL ROLE sales_operator;
  UPDATE outbound_messages SET status = 'approved', approved_at = now() WHERE id = m;
  RAISE NOTICE 'T6 operator approves pending msg  : PASS (allowed)';
  BEGIN
    UPDATE outbound_messages SET body = 'operator edit' WHERE id = m;
    RAISE NOTICE 'T7 operator edits body            : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T7 operator edits body            : PASS (blocked)';
  END;
  BEGIN
    DELETE FROM outbound_messages WHERE id = m;
    RAISE NOTICE 'T8 operator deletes message       : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T8 operator deletes message       : PASS (blocked)';
  END;
  BEGIN
    UPDATE outbound_messages SET status = 'sent' WHERE id = m;
    RAISE NOTICE 'T9 operator marks sent            : FAIL (was allowed)';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T9 operator marks sent            : PASS (blocked)';
  END;
  RESET ROLE;
END $$;
ROLLBACK;