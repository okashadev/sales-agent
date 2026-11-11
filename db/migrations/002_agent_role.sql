BEGIN;

CREATE ROLE sales_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE sales TO sales_agent;
GRANT USAGE ON SCHEMA public TO sales_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sales_agent;
GRANT INSERT, UPDATE ON leads, contacts, outbound_messages TO sales_agent;
GRANT INSERT ON interactions, suppressions, audit_log TO sales_agent;
GRANT USAGE ON SEQUENCE suppressions_id_seq, audit_log_id_seq TO sales_agent;

-- The model-facing role may draft and queue, never approve or send.
CREATE FUNCTION guard_agent_cannot_approve() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'sales_agent' AND NEW.status IN ('approved','sent') THEN
    RAISE EXCEPTION 'agent role cannot move messages to %', NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_agent_guard BEFORE INSERT OR UPDATE OF status ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION guard_agent_cannot_approve();

INSERT INTO schema_migrations(version) VALUES ('002_agent_role');
COMMIT;