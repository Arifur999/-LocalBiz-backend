# LocalBiz — Backend

Multi-tenant SaaS backend for the LocalBiz app.

## Stack

- **Express 5** + **TypeScript** (ESM)
- **Prisma 7** + **PostgreSQL** (driver adapter: `@prisma/adapter-pg`)
- **Zod v4** request validation
- **JWT** auth (access + refresh cookies), role-based access (`super_admin`, `owner`, `manager`, `sales_staff`, `accountant`)
- **Cloudinary** image uploads
- **node-cron** subscription expiry checks

## Architecture

```
src/
  config/          env, cloudinary, multer
  app/
    lib/           prisma client
    errorHelpers/  AppError + zod/prisma error normalizers
    middleware/    checkAuth, checkSubscription, validateRequest, globalErrorHandler, notFound
    shared/        catchAsync, sendResponse
    utils/         jwt, token, cookie, seed, subscription, activityLog
    module/        one folder per feature: <feature>.{interface,validation,service,controller,route}.ts
    routes/        mounts every module under /api/v1
prisma/schema/     multi-file Prisma schema (33+ models)
```

Every workspace table carries `owner_id`; all queries are scoped by the authenticated user's workspace (replaces Supabase RLS). Owner access is gated by subscription status (`checkSubscription` middleware).

## Getting started

```bash
npm install --legacy-peer-deps
cp .env.example .env   # fill DATABASE_URL and secrets
npm run migrate        # create database schema
npm run dev            # start dev server on :5100
```

The super admin account is seeded automatically on boot from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`.

### Writing a new migration: read the SQL before you keep it

`npm run migrate` (`prisma migrate dev`) compares the schema files with the database, and the database has things the schema files cannot describe: the trigram and composite indexes from `20260808120000_list_performance_indexes` and the loan migrations, and three `DATE` columns that default to `CURRENT_DATE`. Prisma reads those as drift, so **every generated migration starts with `DROP INDEX` lines for them and three `ALTER COLUMN ... SET DEFAULT CURRENT_TIMESTAMP` lines** - and `migrate dev` applies the file to your database as it writes it.

After generating one:

1. Open the new `migration.sql` and delete everything that is not your change (see `20261117024213_revoked_sessions` for a trimmed example).
2. If it already ran against your local database, put the indexes and defaults back (the `CREATE INDEX IF NOT EXISTS` statements are in the migrations named above), then re-record the file:
   `delete from _prisma_migrations where migration_name = '<name>'`, followed by `npx prisma migrate resolve --applied <name>`.

`npx prisma migrate dev --create-only --name <name>` writes the file without applying it, which avoids step 2.
