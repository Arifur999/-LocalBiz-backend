-- Sessions ended by signing out (see model RevokedSession).
--
-- Hand-trimmed. `prisma migrate dev` also wanted to DROP the trigram and
-- composite indexes that 20260808120000_list_performance_indexes and the loan
-- migrations create in raw SQL, and to change three DATE defaults from
-- CURRENT_DATE to CURRENT_TIMESTAMP - the schema file cannot express either,
-- so it reads them as drift. None of that belongs here; this adds one table.

-- CreateTable
CREATE TABLE "revoked_sessions" (
    "sid" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE INDEX "revoked_sessions_expires_at_idx" ON "revoked_sessions"("expires_at");
