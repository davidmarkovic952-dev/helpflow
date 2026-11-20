-- HelpFlow — odbrana u dubini na nivou baze
-- 1) Aplikacija se kači kao uloga bez superuser/BYPASSRLS prava, pa RLS važi i ako aplikacioni kod pogreši.
-- 2) Row Level Security: svaki red je vidljiv samo unutar app.org_id iz transakcije.
-- 3) audit_log je append-only (trigger zabranjuje UPDATE/DELETE/TRUNCATE).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helpflow_app') THEN
    CREATE ROLE helpflow_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO helpflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON orgs, users, invites, recovery_codes, sessions, customers, tickets, messages, kb_articles TO helpflow_app;
GRANT SELECT, INSERT ON audit_log TO helpflow_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO helpflow_app;

CREATE OR REPLACE FUNCTION app_org() RETURNS INTEGER LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::int $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','invites','recovery_codes','sessions','customers','tickets','messages','kb_articles','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;

-- orgs: aplikacija vidi samo svoju organizaciju
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self ON orgs;
CREATE POLICY org_self ON orgs USING (id = app_org()) WITH CHECK (id = app_org());

-- Uski SECURITY DEFINER ulazi za korake pre nego što je organizacija poznata.
-- Vraćaju samo ono što je neophodno; sve ostalo ide kroz RLS.
CREATE OR REPLACE FUNCTION auth_user_by_email(p_email TEXT)
RETURNS TABLE (id INT, org_id INT) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT id, org_id FROM users WHERE lower(email) = lower(p_email) LIMIT 1 $$;

CREATE OR REPLACE FUNCTION auth_session_org(p_token_hash TEXT)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT org_id FROM sessions WHERE token_hash = p_token_hash LIMIT 1 $$;

CREATE OR REPLACE FUNCTION auth_invite_org(p_token_hash TEXT)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT org_id FROM invites WHERE token_hash = p_token_hash LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public_org_by_slug(p_slug TEXT)
RETURNS TABLE (id INT, name TEXT) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT id, name FROM orgs WHERE slug = p_slug LIMIT 1 $$;

CREATE OR REPLACE FUNCTION public_ticket_org(p_token_hash TEXT)
RETURNS INT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT org_id FROM tickets WHERE public_token_hash = p_token_hash LIMIT 1 $$;

REVOKE ALL ON FUNCTION auth_user_by_email, auth_session_org, auth_invite_org, public_org_by_slug, public_ticket_org FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_by_email, auth_session_org, auth_invite_org, public_org_by_slug, public_ticket_org, app_org TO helpflow_app;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
DROP TRIGGER IF EXISTS audit_no_update ON audit_log;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
DROP TRIGGER IF EXISTS audit_no_truncate ON audit_log;
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
