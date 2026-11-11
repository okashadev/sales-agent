BEGIN;
DO $$
DECLARE l uuid; c uuid; m uuid;
BEGIN
  INSERT INTO leads(business_name, website_url, domain, source_url)
    VALUES ('Test Co','https://testco.example','testco.example','https://src.example') RETURNING id INTO l;
  INSERT INTO contacts(lead_id, email, source_url)
    VALUES (l,'hello@testco.example','https://src.example/contact') RETURNING id INTO c;

  BEGIN
    INSERT INTO leads(business_name, domain, source_url) VALUES ('Dup','testco.example','x');
    RAISE NOTICE 'T1 duplicate domain      : FAIL (was allowed)';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'T1 duplicate domain      : PASS (blocked)';
  END;

  BEGIN
    UPDATE leads SET status = 'won' WHERE id = l;
    RAISE NOTICE 'T2 discovered -> won     : FAIL (was allowed)';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'T2 discovered -> won     : PASS (blocked)';
  END;

  UPDATE leads SET status = 'researching' WHERE id = l;
  RAISE NOTICE 'T3 discovered -> research: PASS (allowed)';

  BEGIN
    INSERT INTO outbound_messages(lead_id, contact_id, kind, subject, body, status, idempotency_key)
      VALUES (l, c, 'initial', 's', 'b', 'sent', 'k0');
    RAISE NOTICE 'T4 insert as sent        : FAIL (was allowed)';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'T4 insert as sent        : PASS (blocked)';
  END;

  INSERT INTO outbound_messages(lead_id, contact_id, kind, subject, body, idempotency_key)
    VALUES (l, c, 'initial', 'Hi', 'Body', 'k1') RETURNING id INTO m;

  BEGIN
    INSERT INTO outbound_messages(lead_id, contact_id, kind, subject, body, idempotency_key)
      VALUES (l, c, 'initial', 'Hi again', 'Body', 'k2');
    RAISE NOTICE 'T5 duplicate email step  : FAIL (was allowed)';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'T5 duplicate email step  : PASS (blocked)';
  END;

  BEGIN
    UPDATE outbound_messages SET status = 'sent' WHERE id = m;
    RAISE NOTICE 'T6 draft -> sent         : FAIL (approval skipped)';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'T6 draft -> sent         : PASS (blocked)';
  END;

  UPDATE outbound_messages SET status = 'pending_approval' WHERE id = m;
  INSERT INTO suppressions(kind, value, reason) VALUES ('domain','testco.example','unsubscribe');
  BEGIN
    UPDATE outbound_messages SET status = 'approved', approved_at = now() WHERE id = m;
    RAISE NOTICE 'T7 suppressed approval   : FAIL (was allowed)';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'T7 suppressed approval   : PASS (blocked)';
  END;

  INSERT INTO audit_log(actor, action, entity) VALUES ('system','test','x');
  BEGIN
    UPDATE audit_log SET action = 'tampered';
    RAISE NOTICE 'T8 audit tamper          : FAIL (was allowed)';
  EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'T8 audit tamper          : PASS (blocked)';
  END;
END $$;
ROLLBACK;