-- HelpFlow — osnovna šema
CREATE TABLE IF NOT EXISTS orgs (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  ticket_seq  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  org_id              INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email               TEXT NOT NULL CHECK (length(email) <= 254),
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  role                TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'agent')),
  password_hash       TEXT,
  totp_secret_enc     TEXT,
  totp_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  failed_logins       INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  password_changed_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uniq ON users (lower(email));

CREATE TABLE IF NOT EXISTS invites (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ
);

-- Sesije: čuva se samo SHA-256 heš tokena; sam token postoji samo u kolačiću korisnika.
CREATE TABLE IF NOT EXISTS sessions (
  id            SERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_hash     TEXT NOT NULL,
  mfa_passed    BOOLEAN NOT NULL DEFAULT FALSE,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL CHECK (length(email) <= 254),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_email ON customers (org_id, lower(email));

CREATE TABLE IF NOT EXISTS tickets (
  id                 SERIAL PRIMARY KEY,
  org_id             INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  number             INTEGER NOT NULL,
  public_token_hash  TEXT NOT NULL UNIQUE,
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  subject            TEXT NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'pending', 'resolved', 'closed')),
  priority           TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  category           TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('billing', 'technical', 'account', 'shipping', 'feedback', 'general')),
  sentiment          TEXT CHECK (sentiment IN ('negative', 'neutral', 'positive')),
  assignee_id        INTEGER REFERENCES users(id),
  ai_triage          JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_response_at  TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS tickets_org_status ON tickets (org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id       INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_type     TEXT NOT NULL CHECK (author_type IN ('customer', 'agent', 'system')),
  author_user_id  INTEGER REFERENCES users(id),
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  internal        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT (internal AND author_type = 'customer'))
);
CREATE INDEX IF NOT EXISTS messages_ticket ON messages (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS kb_articles (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  tags        TEXT[] NOT NULL DEFAULT '{}',
  published   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Revizijska sled: lanac heševa po organizaciji (svaki zapis sadrži heš prethodnog).
CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL PRIMARY KEY,
  org_id         INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_user_id  INTEGER,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  ip             TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS audit_org ON audit_log (org_id, id);
