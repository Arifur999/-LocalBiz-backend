# Security audit, follow-up: LocalBiz backend + frontend (2026-11-17)

Auditor: Claude Code (`security-audit` skill). Audited at backend `ad8a011`, frontend `d75705d`. Mode: code review plus local probes against the dev stack (`localhost:5100`, `localbiz-postgres`). The fixes below were made the same day, after the read-only pass.

This is a second pass, one day after [security-audit-2026-11-16.md](security-audit-2026-11-16.md). It re-checked that yesterday's fixes hold and covered what the first pass did not: secrets in git history, logging, refresh-token lifetime, account enumeration, secret strength, bad query values, response headers and CSV exports.

## Scope

- Stack: Express 5 + Prisma 7 + PostgreSQL, custom JWT in httpOnly cookies (Bearer and body tokens for the mobile client), Vite + React 18 SPA on React Router 7, Docker + nginx.
- Entry points: 42 route files under `src/app/module/*`, cron jobs in `app.ts`, image upload, SSE support stream.
- Roles: `super_admin`, `owner`, `manager`, `accountant`, `sales_staff`. Tenant key: `owner_id`, set by `checkAuth` from the user row, never from the request.
- Config reviewed: `.env.example`, `src/config/env.ts`, `docker-compose.yml`, `Dockerfile`, `nginx.conf`, `.github/workflows/ci.yml`.
- Known issues carried over: the two design decisions recorded yesterday (purchase money totals come from the client; lists requested without `limit` return the whole tenant list). No `10-known-issues.md` exists on this machine.

## Summary

| Severity | Found | Fixed | Left open |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 3 | 3 | 0 |
| Low | 4 | 4 | 0 |

Verdict: nothing found that was exploitable across tenants or without an account, and all seven findings are fixed and re-tested. Two limits of the fixes are recorded under M1 (sign-up still reveals a taken email) and L4 (pinned versions need refreshing by hand).

## Yesterday's fixes, re-checked

| Check | Result |
|---|---|
| Backend tests | all pass (315 before today's work, 325 after) |
| `scripts/e2e-tenancy-check.sh` | PASS: cross-tenant PATCH answers 404 |
| `npm audit --omit=dev` | 0 vulnerabilities in both repos |
| Page-size cap | `GET /products?limit=99999999` answers with `limit: 500` |
| Malformed JSON body | 400 (was 500) |
| Forged `alg: none` JWT | 401 |

## Findings

### M1. Password-reset and resend-code endpoints revealed which emails have accounts (Fixed, A07)

- Where: `src/app/module/auth/auth.service.ts` (forgot-password, resend, verify, reset, login), `src/app/utils/otp.ts`.
- Evidence before: `POST /auth/forgot-password` with an unknown email answered **404** "This email is not registered"; with a real one, **200**. `POST /auth/resend-otp` answered 404 "No account found" against 200. Login already gave one message for both, but answered an unknown email without the bcrypt comparison, so it was faster.
- Fix: an unknown address now runs the same steps as a real one. A code row is written for it and never mailed (`issueOtp(..., deliver = false)`), so the cooldown, the attempt counter and the expiry all behave identically, and the verify and reset steps check the code before they look up the account. Login compares against a dummy hash when the email is unknown. The hourly sweep deletes code rows an hour after they expire.
- Evidence after: forgot-password answers 200 "If this email is registered, a reset code has been sent to it." for both; a wrong reset code answers "Wrong code. 4 attempts left." for both; a second request inside the cooldown answers the same 429 for both. Login took 0.10 s for an unknown email and 0.07 s for a wrong password.
- What the user loses: the "not registered" hint for a mistyped address. The reset screen now says to check the address if no email arrives.
- Not covered: `POST /auth/register` still answers 409 "An account with this email already exists". Hiding that needs sign-up to finish by email for existing addresses too, which is a change to the sign-up flow.
- Guard: `scripts/e2e-auth-check.sh` (local) compares status and body for a known and an unknown email at both steps.

### M2. A weak or example JWT secret was accepted in production (Fixed, A02 / A05)

- Where: `src/config/env.ts`, new `src/config/secretStrength.ts`.
- Evidence before: the only check was that the two token secrets were non-empty. `.env.example` ships `change_this_access_secret`, and that file is public.
- Fix: with `NODE_ENV=production` the server refuses to start if either token secret is an example value or shorter than 32 characters, if the two are equal, or if `SUPER_ADMIN_PASSWORD` is an example value or shorter than 12 characters. Development is unaffected. `.env.example` and `DEPLOY.md` state the rule.
- Evidence after: a production start with the example values exits with "Refusing to start with weak secrets" and lists the three problems; with the real local secrets it starts.
- Guard: `secretStrength.test.ts` (5 tests).

### M3. Signing out did not end the session on the server (Fixed, A07)

- Where: `auth.controller.ts` (logout), `auth.service.ts` (`issueSession`, `getNewTokens`, new `endSession`), `checkAuth.ts`, new `utils/sessionRevocation.ts` and `utils/revokedSessionStore.ts`, new table `revoked_sessions`.
- Evidence before: logout cleared the cookies only. A token copied beforehand kept working, and kept refreshing, for the rest of the 15-day session.
- Fix: each sign-in gets a session id (the `sid` claim), copied through every refresh. Signing out writes it to `revoked_sessions`; `checkAuth` refuses its access tokens (an in-memory lookup, no query per request) and refresh refuses its refresh tokens (checked against the table). Only that session ends, so the user's other devices stay signed in. The store is loaded at boot and re-read every minute; rows are deleted once the session would have ended anyway.
- Evidence after: signed in twice as the same user; after logout on the first, its copied access token and refresh token both got **401** "You have signed out", the second session stayed at 200, and the first was still refused after a server restart.
- Limits: tokens issued before this change carry no `sid` and cannot be revoked until their next refresh gives them one (within a day at the default access-token lifetime). Within one live session an older refresh token still works until sign-out; detecting reuse would need a row per refresh.
- Guard: `revokedSessionStore.test.ts` (5 tests) and `scripts/e2e-auth-check.sh`.

### L1. The API announced Express and had no headers of its own (Fixed, A05)

- Fix: `helmet` in `src/app.ts`. `X-Powered-By` is gone and the API now sends nosniff, frame, referrer and CSP headers however it is reached. HSTS is left to nginx on purpose: helmet's default adds `includeSubDomains`, which is a decision about the whole domain.
- Evidence after: `curl -D - http://localhost:5100/` shows the new headers and no `X-Powered-By`. In the browser every API call, including the SSE stream, still returns 200.

### L2. No general request limit on the API (Fixed, API4)

- Fix: `apiLimiter` in `rateLimit.ts`, mounted on `/api/v1` ahead of the body parsers: 1500 requests a minute per signed-in user, or per address when there is no valid token. It is keyed by user first because shops often share a carrier NAT address with strangers. A page load measured 13 requests, so the ceiling is a backstop, not a throttle.
- Not changed: `nginx.conf` still has no `limit_req`. That file could not be tested here without a full production stack, and the app-level limit covers the finding.

### L3. CSV exports did not neutralise spreadsheet formulas (Fixed, A03)

- Where: frontend `src/lib/spreadsheet.ts`, `src/pages/Inventory.tsx`.
- Fix: `csvSafeText` prefixes a text cell that starts with `=`, `+`, `-`, `@`, tab or CR with an apostrophe. Numbers and number-like text (`-500`, `+8801719731884`) are left alone, so amounts and phone numbers survive a re-import unchanged. The Inventory export now goes through the shared `downloadCsv`, which also fixes a second bug there: it did not double the quotes inside a name, so a `6" shelf` broke the row.
- Guard: `spreadsheet.test.ts` (5 tests, including an export-import round trip).

### L4. Base images and CI actions were pinned by tag, not digest (Fixed, A08)

- Fix: `Dockerfile` pins `node:22-alpine` by digest (Node 22.23.5); both CI workflows pin `actions/checkout` (v5.1.0) and `actions/setup-node` (v5.0.0) to commits. `docker build` passes with the pinned image.
- Trade-off: security updates to the base image no longer arrive on their own. The Dockerfile comment gives the command to refresh the digest; nothing does it automatically (Dependabot can, if it is switched on for the repos).

## Caught while fixing: `prisma migrate dev` wants to drop hand-written indexes

Generating the migration for `revoked_sessions` also produced `DROP INDEX` for 13 indexes and changed three column defaults, and applied them to the local database. Those indexes (trigram search and composite list indexes) and `CURRENT_DATE` defaults exist only in raw-SQL migrations, so Prisma treats them as drift on every run.

- What was done: the migration file was trimmed to the one new table, the indexes and defaults were restored locally, and the result was checked by building a second database from the 42 migrations and comparing `pg_dump --schema-only` of the two: identical. Nothing had been committed or deployed.
- Why it matters: the next person to run `npm run migrate` will get the same destructive lines. `README.md` now explains what to delete and how to avoid applying it (`--create-only`).

## Checklist coverage

| Section | Result | Notes |
|---|---|---|
| Secrets | pass | Nothing hardcoded. `git log -p --all` in both repos shows no secret and no `.env`. The frontend exposes only `VITE_API_BASE_URL`. Weak production secrets are now refused (M2). |
| Authentication | fixed | M1, M3. Also confirmed: sign-up with `role: super_admin`, `email_verified`, `owner_id` and `permissions` in the body stored a plain unverified `owner`; no cookies before verification; OTP by `crypto.randomInt`, hashed, 2 minutes, 5 attempts; auth routes limited; JWT pinned to HS256. |
| Authorization and tenancy | pass | Tenancy guard passes. An owner without an approved plan gets 403 on `/accounts`; an owner gets 403 on `/platform-settings` and `/notifications` (super-admin). |
| Input validation and injection | fixed | zod on bodies; bad dates and malformed JSON answer 400; a bad id is a 404; no unsafe raw SQL. L3 closed the output-side gap. |
| Web and transport | fixed | CORS allowlist, cookie flags and nginx headers as recorded yesterday; L1 and L2 added the API's own headers and ceiling. |
| File uploads | pass | Unchanged since yesterday. |
| Logging and errors | pass | OTP codes are printed only outside production; no tokens, cookies or request bodies are logged; production 5xx are generic to the client and logged on the server. No request id on log lines. |
| Infrastructure | fixed | Non-root runtime, no published DB port, `${POSTGRES_PASSWORD:?}`; base image and actions pinned (L4). |
| Frontend | pass | No tokens in browser storage, no `dangerouslySetInnerHTML`, print templates escape every field. |
| Mobile (Expo) | n.a. | No Expo app in these repos. The API's mobile mode (`X-Client: mobile`) is not allowed by CORS, so a web page cannot switch it on. |

## Not checked

- A production host: TLS, live nginx, firewall, backups off the server. There is no deployment yet.
- Provider dashboards and key rotation (Cloudinary, Resend, bKash, MRAM). The local `.env` holds none of these keys.
- The mobile app itself. Sign-out revocation reads the app's refresh token from the body and its access token from the Bearer header; whether the app sends either on logout was not verified.
- The Inventory CSV download was not clicked through in a browser; it is covered by type-check and the unit tests of the shared writer.
- `D:\dev\knowledge-base` (the checklist and `10-known-issues.md`) is not on this machine, so the checklist sections above follow the skill's own list.
