BEGIN;

ALTER TABLE outbound_messages ADD COLUMN content_sha256 text;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_hash_required
  CHECK (status IN ('draft','rejected') OR content_sha256 IS NOT NULL);

-- Content is frozen once submitted; the hash (incl. recipient) is computed by the database.
CREATE FUNCTION guard_outbound_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_email text;
BEGIN
  IF OLD.status <> 'draft'
     AND (NEW.lead_id, NEW.contact_id, NEW.kind, NEW.sequence_step, NEW.subject, NEW.body)
         IS DISTINCT FROM
         (OLD.lead_id, OLD.contact_id, OLD.kind, OLD.sequence_step, OLD.subject, OLD.body) THEN
    RAISE EXCEPTION 'message content is frozen once submitted for approval'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'pending_approval' THEN
    SELECT email INTO v_email FROM contacts WHERE id = NEW.contact_id;
    NEW.content_sha256 := encode(
      sha256(convert_to(NEW.subject || E'\n' || NEW.body || E'\n' || v_email, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_content_freeze BEFORE UPDATE ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION guard_outbound_content();

-- Operator role: the human approval path. Never handed to the model-facing MCP server.
CREATE ROLE sales_operator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE sales TO sales_operator;
GRANT USAGE ON SCHEMA public TO sales_operator;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sales_operator;
GRANT UPDATE (status, approved_at) ON outbound_messages TO sales_operator;
GRANT INSERT ON audit_log, suppressions TO sales_operator;
GRANT USAGE ON SEQUENCE audit_log_id_seq, suppressions_id_seq TO sales_operator;

CREATE FUNCTION guard_operator_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'sales_operator' AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'operator role may only approve or reject'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_operator_guard BEFORE UPDATE OF status ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION guard_operator_status();

-- Narrow the agent: column-level rights only.
REVOKE INSERT, UPDATE ON outbound_messages FROM sales_agent;
GRANT INSERT (lead_id, contact_id, kind, sequence_step, subject, body, idempotency_key)
  ON outbound_messages TO sales_agent;
GRANT UPDATE (subject, body, status) ON outbound_messages TO sales_agent;
REVOKE UPDATE ON contacts FROM sales_agent;
GRANT UPDATE (full_name, role_title, entity_type) ON contacts TO sales_agent;

INSERT INTO schema_migrations(version) VALUES ('003_operator_and_freeze');
COMMIT;