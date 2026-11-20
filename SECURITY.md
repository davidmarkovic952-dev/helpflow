# Security

## Reporting a vulnerability

Please do not open a public issue. Email **davidmarkovic952@gmail.com** with a description and reproduction steps. Expect a reply within 72 hours.

## Threat model (STRIDE)

Assets: customer messages and contact details, agent accounts, tenant boundaries, audit history.
Adversaries: anonymous internet users, malicious customers (through the portal), a compromised or malicious agent in one tenant, and a malicious tenant trying to reach another tenant.

| STRIDE | Scenario | Mitigation |
|---|---|---|
| **S**poofing | Password guessing, credential stuffing | Argon2id, IP and account rate limits, progressive lockout, HIBP check, TOTP 2FA |
| **S**poofing | Stolen session cookie | `__Host-` HttpOnly/Secure/SameSite=Strict cookie, idle and absolute expiry, session list with remote revoke, rotation on login |
| **T**ampering | Editing or deleting audit entries | DB triggers block UPDATE/DELETE/TRUNCATE on `audit_log`; the per-tenant SHA-256 hash chain detects direct edits by a DB superuser |
| **T**ampering | Mass assignment (`role`, `org_id` in the body) | Strict zod schemas; `org_id` always comes from the session |
| **R**epudiation | "I didn't change that ticket" | Every security-relevant action is logged with actor, IP and target |
| **I**nformation disclosure | Tenant A reads tenant B's tickets | PostgreSQL RLS with `FORCE`; the app role lacks `BYPASSRLS`; pre-auth lookups use narrow `SECURITY DEFINER` functions; 404 instead of 403 |
| **I**nformation disclosure | PII sent to an LLM provider | Redaction of email, phone, IBAN, card, JMBG, secrets before the prompt |
| **I**nformation disclosure | Internal notes visible to customers | The portal query excludes `internal` messages |
| **I**nformation disclosure | Stack traces, enumeration | Generic error handler; identical login responses; `Cache-Control: no-store` |
| **D**enial of service | Floods, large payloads | Global and per-route limits, 64 KB JSON limit, AI calls limited per user and timed out after 20 s |
| **E**levation of privilege | Agent → admin, admin → owner | Server-side role checks; only owners manage owners; last-owner protection; deactivation revokes sessions |
| **E**levation of privilege | Prompt injection makes the AI act | The AI only *suggests*; the output is schema-validated; there are no tool calls and no auto-send |

## OWASP Top 10 (2021) coverage

| Risk | How it is addressed |
|---|---|
| A01 Broken Access Control | RLS, role middleware, 404 on foreign IDs, same-org assignee check |
| A02 Cryptographic Failures | Argon2id, AES-256-GCM for TOTP secrets, SHA-256 token hashes, HSTS |
| A03 Injection | Parameterized SQL, CSP, React escaping, prompt isolation |
| A04 Insecure Design | Threat model, human-in-the-loop AI, least-privilege DB role |
| A05 Security Misconfiguration | helmet, config validation that refuses unsafe production settings, hardened container |
| A06 Vulnerable Components | `npm audit` gate, CodeQL, Dependabot |
| A07 Identification & Authentication Failures | Lockout, 2FA, session timeouts, password policy, no enumeration |
| A08 Software & Data Integrity Failures | Hash-chained audit log, `npm ci` with lockfile |
| A09 Logging & Monitoring Failures | Audit log of logins, failures, role changes, AI usage, ticket changes |
| A10 SSRF | No user-controlled outbound URLs; LLM endpoints are fixed |

## OWASP ASVS 4.0 (selected Level 2 controls)

- **V2 Authentication:** 2.1.1 (min. 12 chars), 2.1.7 (breached password check), 2.2.1 (anti-automation), 2.4.1 (Argon2id), 2.8 (TOTP), 2.5.6 (recovery codes)
- **V3 Session Management:** 3.2.1 (new token at login), 3.3.1/3.3.2 (logout, idle and absolute timeout), 3.3.4 (view and revoke sessions), 3.4 (cookie attributes, `__Host-`), 3.5.3 (CSRF)
- **V4 Access Control:** 4.1.1 (enforced server-side), 4.2.1 (IDOR protection), 4.3.1 (admin interfaces are role-gated)
- **V5 Validation:** 5.1.3 (allow-list schemas), 5.3.3 (output encoding)
- **V7 Logging:** 7.1.3 (security events), 7.3.3 (log integrity)
- **V8 Data Protection:** 8.3.1 (no sensitive data in URLs; the portal token sits in the hash fragment)
- **V14 Configuration:** 14.4 (security headers)

## Known limitations

- Rate limits and lockout counters live in memory **per instance**. When scaling horizontally, move them to Redis or PostgreSQL.
- The CSRF and encryption key (`ENCRYPTION_KEY`) is a single key. Rotating it invalidates active sessions' CSRF tokens and requires re-encrypting TOTP secrets.
- Email delivery (notifications, invite emails) is out of scope; invite links are shown once to the admin.
- WebAuthn/passkeys are not yet supported (planned).
