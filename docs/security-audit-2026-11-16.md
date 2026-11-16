# Security audit: LocalBiz backend + frontend (2026-11-16)

Auditor: Claude Code (`security-audit` skill). Commits: backend `913c516`, frontend `9038a2a`. Mode: code review plus local probes against the dev stack (`localhost:5100`, `localbiz-postgres`). Nothing was run against a production host.

## Scope

- Stack: Express 5 + Prisma 7 + PostgreSQL, custom JWT in httpOnly cookies (Bearer fallback for the mobile client), Vite + React 18 SPA, Docker + nginx.
- Entry points: 42 route files under `src/app/module/*`, two cron jobs in `app.ts`, image upload (`/uploads/image`, Cloudinary), SSE support stream.
- Roles: `super_admin`, `owner`, `manager`, `accountant`, `sales_staff`. Tenant key: `owner_id`, taken from the user row looked up by the JWT's `userId` (`checkAuth` sets `req.user.ownerId`), never from the request.
- Config reviewed: `.env.example`, `src/config/env.ts`, `docker-compose.yml`, `Dockerfile`, `nginx.conf`, `.github/workflows/ci.yml` (both repos).
- Known issues carried over: none (no `10-known-issues.md` exists for this repo on this machine).

## Summary

| Severity | Found | Fixed | Left open |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 2 | 2 | 0 |
| Medium | 4 | 4 | 0 |
| Low | 11 | 11 | 0 |

Verdict: every finding is fixed. The High findings, M4 and L8 were re-tested against the running dev stack. One design decision is recorded under L8: purchase money totals are still taken from the client.

## Findings

### H1. Updates accepted another workspace's ids (Fixed, A01 / API1)

- Where: the update path of eleven services checked that the record belonged to the caller but not the ids inside the payload, while the matching create path did:
  - `accountTransfer.service.ts` (`from_account_id`, `to_account_id`)
  - `expense.service.ts` (`account_id`, `category_id`)
  - `investment.service.ts`, `profitWithdrawal.service.ts` (`account_id`, `shareholder_id`)
  - `otherIncome.service.ts` (`account_id`, `supplier_id`)
  - `salePayment.service.ts` (update: `sale_id`, `customer_id`, `account_id`; create: `customer_id`, `account_id`)
  - `supplierPayment.service.ts` (`account_id`, `supplier_id`, `purchase_id`)
  - `salaryTransaction.service.ts` (`employee_id`, `account_id`, `category_id`, and `expense_id` on create and update)
  - `product.service.ts` (`supplier_id` on update and on CSV bulk upsert; the response includes the supplier row)
  - `purchase.service.ts` (`supplier_id` on update)
- Evidence: two E2E owners, A and B. As A, `PATCH /account-transfers/<A's transfer>` with `{"to_account_id": "<B's account>"}`. Before the fix this returned **HTTP 200** and the row pointed at B's account, so A's transfer moved money through B's balance. After the fix it returns **404 "Account not found"** and the row is unchanged, while a normal edit of A's own transfer still returns 200.
- Fix: every update path now runs `assertOwnedReferences` with the same spec as its create. `expense` was added to `REFERENCE_LOOKUPS`. The CSV upsert checks all distinct supplier ids with one `count` before it writes anything.
- Guard: `scripts/e2e-tenancy-check.sh` (local only). It creates both owners, tries the cross-tenant PATCH, expects 404 with the row unchanged, and deletes everything it made.

### H2. Vulnerable dependencies reachable in production (Fixed, A06)

- Backend: `body-parser` (DoS via trailing bytes after a compressed body; used by `express.json()`), `nodemailer <=10.1.3` (several address-parser DoS bugs and a TLS servername reuse bug; used for every OTP and reminder email), plus `fast-uri`, `deepmerge-ts` and `@hono/node-server` (Prisma tooling).
- Frontend: `axios` and `follow-redirects`.
- Fix: `npm audit fix` in both repos, and `nodemailer` upgraded to 10.6.0 (one type annotation adjusted in `utils/email.ts`). `npm audit --omit=dev` now reports 0 in the backend.

### M1. Unexpected 500s leaked internal messages, and production logged none (Fixed, A09)

- Where: `middleware/globalErrorHandler.ts`.
- Evidence: any non-AppError `Error` returned `err.message` to the client in every environment, which can include SQL or upstream text. Errors were only printed in development, so a production 500 left no trace. A malformed JSON body, or an upload over the size limit, came back as 500 instead of 400.
- Fix: production answers "Internal Server Error" for unexpected errors and logs every 5xx server-side. Exposed 4xx errors from body-parser (`expose: true`) and `MulterError` now answer 400. The upload type filter throws `AppError(400)`.

### M2. A blocked or suspended owner could clear their own block (Fixed, A01)

- Where: `subscription.service.ts`, `choosePlan` and `submitManualPayment`.
- Evidence: the lock check only guarded the free trial. A paid choice wrote `plan_status` and cleared `blocked_reason`, so the super admin's block disappeared from their own screen. Access still needed admin approval.
- Fix: a locked owner is refused for every plan. A locked owner may still submit a payment, but it no longer changes the subscription row.

### M3. Toggling an approved payment credited it twice (Fixed, API6)

- Where: `sms.service.ts` `updatePurchaseStatus`, `superAdmin.service.ts` payment status update.
- Evidence: approval acts on the move into `paid`. Moving a paid row to pending and back to paid topped up SMS credits, or extended the plan, a second time. Super admin only.
- Fix: a `paid` payment or purchase can no longer be moved to another status (409).

### M4. The activity feed ignored per-module read permissions (Fixed, API5)

- Where: `activity.route.ts:11`, `activity.service.ts`.
- Evidence: any signed-in staff role got amounts and party names for sales, purchases, expenses, loans and payments. Sales staff could see expense and loan figures here that their own routes refuse them. It was scoped by `owner_id`, so there was no cross-tenant leak.
- Fix: `activityAccess.ts` gives each source the same two gates as its own list route: the role list on that route's `checkAuth`, then `requirePermission` with its `READS` set. A source the caller fails returns nothing.
- Guard: `activityAccess.test.ts`.

### Low, fixed

- L1. JWT verification now pins `algorithms: ['HS256']` (`utils/jwt.ts`).
- L2. `POST /reports/email` sends caller-written content from the platform's mail domain with no limit. It now has `reportEmailLimiter`: 10 per hour per IP.
- L3. `sale` PATCH `delivery_status` was `z.string()`, so a bad value caused a 500. It is now the `DeliveryStatus` enum.
- L4. The CSV product bulk upsert had no maximum size. It is now capped at 500 rows; the browser sends 100 per request.
- L5. The draft update and delete paths checked only the kind sent, not the stored kind, so sales staff could overwrite or delete purchase-order drafts. Both now check the stored kind.
- L6. A `trx_id` claim blocked the id forever. Failed, refunded and rejected claims no longer block it. A pending claim still does until an admin rejects it.
- L7. `docker-compose.yml` now fails fast when `POSTGRES_PASSWORD` is unset (`${POSTGRES_PASSWORD:?}`).

- L8. Purchase `shipping_status` and item `received_qty` on create are no longer taken from the client. Create always stores lines unreceived. Update re-derives the status from the lines (`refreshShippingStatus`), so an order can only become "received" through the receive endpoints that add stock and the FIFO batch. Live check: a create claiming `received` with `received_qty: 5` stored `pending` and 0. A PATCH with `shipping_status: received` kept it `pending`. `receive-all` then made it `received`. **Kept by design:** the purchase money totals (`total/net/paid/due_amount`) are still the client's figures, because they encode discount and payment rules the browser owns. They only affect the caller's own ledger.
- L9. A requested `limit` is now capped at 500 (`MAX_PAGE_SIZE`); the browser asks for 40. Lists requested with no `limit` still return the tenant's whole list, because the browser's query shim (`lib/supabase.ts`) filters client-side and depends on it. Moving that filtering server-side is a separate refactor.
- L10. Recycle-bin delete metadata is cleaned in `buildRecycleItemData` (`cleanRecycleMeta`). Wrong types are dropped in favour of the server fallback and text is cut to 200 characters, so a delete never fails over a label. Guard: `recycleSnapshot.test.ts`.
- L11. `react-router-dom` upgraded 6.30 → 7.18.5. The app uses only declarative APIs (BrowserRouter, Routes, Link, NavLink, Navigate, Outlet and the hooks), which v7 keeps. Tests and build pass, and login, redirect and sidebar navigation were checked in the browser. `npm audit --omit=dev` reports 0 in both repos.

Informational: `requirePermission` lets staff with an empty `permissions` array through by design, for backward compatibility. The `checkAuth(Role…)` gates are the hard boundary.

## Checklist coverage

| Section | Result | Notes |
|---|---|---|
| Secrets | pass | Nothing hardcoded in src, compose or scripts. `.env` is gitignored, and the fresh git history has no secrets. Local secrets were generated new for this fork. |
| Authentication | pass | bcrypt passwords. OTP uses `crypto.randomInt`, is hashed, lives 2 minutes and allows 5 attempts. Auth routes are rate limited. `token_version` revokes tokens on password change. Sign-up schema has no `role`. JWT algorithm is now pinned. |
| Authorization and tenancy | fixed | H1, M2, M3 and M4 fixed. H1 re-tested end to end, and M4 has a unit test. |
| Input validation and injection | pass | zod on every body, with unknown keys stripped and the parsed body replacing `req.body`. No `$queryRawUnsafe`; inventory raw SQL uses tagged templates. |
| Web and transport | pass | CORS is an exact allowlist with credentials, and localhost is allowed only outside production. Cookies are httpOnly, `sameSite=lax` and `secure` in production. nginx sets HSTS, nosniff, X-Frame-Options, Referrer-Policy and CSP, with `server_tokens off`. `trust proxy` is 1. |
| File uploads | pass | MIME allowlist (no SVG), 5 MB, one file, generated names, auth plus subscription plus rate limit. |
| Logging and errors | fixed | M1. |
| Infrastructure | pass | App runs as `node` via su-exec, no published DB port, pinned image majors. CI deploy jobs were removed in this fork. |
| Frontend | pass | No tokens in localStorage. `document.write` print templates escape every field. Blank-target links carry `rel=noopener`. |
| Mobile (Expo) | n.a. | No Expo app in these repos. |

## Not checked

- Production nginx/TLS on a live host. This fork has no domain or server yet.
- Cloudinary, Resend, bKash and MRAM dashboards and key rotation. This fork carries none of the old project's keys; add new ones per environment.
- A full proof per service for H1. The transfer case was probed end to end. The other ten paths received the identical helper call and were verified by reading the code, type-check and the existing test suite.
