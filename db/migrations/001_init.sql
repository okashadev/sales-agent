BEGIN;

CREATE TABLE schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Lead lifecycle -----------------------------------------------------------
CREATE TABLE lead_statuses (status text PRIMARY KEY);
INSERT INTO lead_statuses(status) VALUES
  ('discovered'),('researching'),('qualified'),('outreach_pending'),('contacted'),
  ('follow_up_due'),('replied'),('interested'),('meeting_scheduled'),('proposal_sent'),
  ('negotiation'),('won'),('lost'),('unsubscribed');

CREATE TABLE lead_status_transitions (
  from_status text NOT NULL REFERENCES lead_statuses(status),
  to_status   text NOT NULL REFERENCES lead_statuses(status),
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO lead_status_transitions(from_status, to_status) VALUES
  ('discovered','researching'),('discovered','lost'),
  ('researching','qualified'),('researching','lost'),
  ('qualified','outreach_pending'),('qualified','lost'),
  ('outreach_pending','contacted'),('outreach_pending','lost'),
  ('contacted','follow_up_due'),('contacted','replied'),('contacted','lost'),
  ('follow_up_due','contacted'),('follow_up_due','replied'),('follow_up_due','lost'),
  ('replied','interested'),('replied','lost'),
  ('interested','meeting_scheduled'),('interested','proposal_sent'),('interested','lost'),
  ('meeting_scheduled','proposal_sent'),('meeting_scheduled','lost'),
  ('proposal_sent','negotiation'),('proposal_sent','won'),('proposal_sent','lost'),
  ('negotiation','won'),('negotiation','lost');
-- Unsubscribe is always possible, from any state.
INSERT INTO lead_status_transitions(from_status, to_status)
  SELECT status, 'unsubscribed' FROM lead_statuses WHERE status <> 'unsubscribed';

-- Core entities -------------------------------------------------------------
CREATE TABLE leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name       text NOT NULL,
  website_url         text,
  domain              text NOT NULL
                        CHECK (domain = lower(domain) AND domain !~ '^(https?://|www\.)'),
  country             text,
  industry            text,
  status              text NOT NULL DEFAULT 'discovered' REFERENCES lead_statuses(status),
  score               smallint CHECK (score BETWEEN 0 AND 100),
  tech_stack          text,
  site_issues         text,
  opportunity         text,
  recommended_service text,
  source_url          text NOT NULL,
  discovered_at       timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX leads_domain_uq ON leads(domain);
CREATE INDEX leads_status_idx ON leads(status);

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email       text NOT NULL
                CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name   text,
  role_title  text,
  entity_type text NOT NULL DEFAULT 'unknown'
                CHECK (entity_type IN ('company','sole_trader','unknown')),
  source_url  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_email_uq ON contacts(email);
CREATE INDEX contacts_lead_idx ON contacts(lead_id);

CREATE TABLE suppressions (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('email','domain')),
  value      text NOT NULL CHECK (value = lower(value)),
  reason     text NOT NULL CHECK (reason IN ('unsubscribe','bounce','declined','manual','complaint')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

-- Outbound messages (approval-gated) ----------------------------------------
CREATE TABLE outbound_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads(id),
  contact_id          uuid NOT NULL REFERENCES contacts(id),
  kind                text NOT NULL CHECK (kind IN ('initial','follow_up','reply','demo_intro')),
  sequence_step       smallint NOT NULL DEFAULT 0,
  subject             text NOT NULL,
  body                text NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','pending_approval','approved','sent','rejected','failed')),
  approval_code_hash  text,
  approved_at         timestamptz,
  sent_at             timestamptz,
  provider_message_id text,
  idempotency_key     text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('approved','sent') OR approved_at IS NOT NULL)
);
-- One live message per contact per step: prevents duplicate emails.
CREATE UNIQUE INDEX outbound_one_step_uq
  ON outbound_messages(contact_id, kind, sequence_step)
  WHERE status NOT IN ('rejected','failed');
CREATE INDEX outbound_status_idx ON outbound_messages(status);

CREATE TABLE interactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  contact_id     uuid REFERENCES contacts(id),
  direction      text NOT NULL CHECK (direction IN ('outbound','inbound','internal')),
  channel        text NOT NULL CHECK (channel IN ('email','whatsapp','meeting','note')),
  classification text CHECK (classification IN
                   ('positive','negative','neutral','out_of_office','unsubscribe','bounce')),
  summary        text NOT NULL,
  external_id    text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
-- Idempotency: the same inbound email/webhook can only be recorded once.
CREATE UNIQUE INDEX interactions_external_uq
  ON interactions(channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX interactions_lead_idx ON interactions(lead_id, occurred_at);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL CHECK (actor IN ('agent','operator','system')),
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  detail    jsonb NOT NULL DEFAULT '{}'
);

-- Guards (the database is the last line of defence) -------------------------
CREATE FUNCTION guard_lead_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT EXISTS (
       SELECT 1 FROM lead_status_transitions
       WHERE from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION 'illegal lead transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER leads_transition_guard BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION guard_lead_transition();

CREATE FUNCTION guard_outbound_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'messages must be created as draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) NOT IN (
       ('draft','pending_approval'), ('draft','rejected'),
       ('pending_approval','approved'), ('pending_approval','rejected'),
       ('approved','sent'), ('approved','failed')) THEN
    RAISE EXCEPTION 'illegal message transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_transition_guard BEFORE INSERT OR UPDATE OF status ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION guard_outbound_transition();

CREATE FUNCTION guard_outbound_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_email text;
BEGIN
  IF NEW.status IN ('approved','sent') THEN
    SELECT email INTO v_email FROM contacts WHERE id = NEW.contact_id;
    IF EXISTS (SELECT 1 FROM suppressions
               WHERE (kind = 'email'  AND value = v_email)
                  OR (kind = 'domain' AND value = split_part(v_email, '@', 2))) THEN
      RAISE EXCEPTION 'contact % is suppressed; cannot move message to %', v_email, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbound_suppression_guard BEFORE INSERT OR UPDATE OF status ON outbound_messages
  FOR EACH ROW EXECUTE FUNCTION guard_outbound_suppression();

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

INSERT INTO schema_migrations(version) VALUES ('001_init');
COMMIT;