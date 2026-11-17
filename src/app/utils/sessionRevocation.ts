import { prisma } from "../lib/prisma.js";
import { RevokedSessionStore } from "./revokedSessionStore.js";

// ---------------------------------------------------------------------------
// Ending one session on the server.
//
// Tokens are stateless, so signing out could only ask the browser to forget
// them - a token copied beforehand kept working until the session's own
// deadline. Each login now carries a session id (`sid`), and signing out writes
// that id here. Other devices signed in to the same account are not touched;
// a password change still ends all of them at once through token_version.
//
// Two copies are kept:
//   - the revoked_sessions table, which survives a restart, and
//   - an in-memory store, because checkAuth runs on every request and must not
//     pay a query to learn that a session is fine.
//
// This process learns of its own sign-outs at once. With more than one
// instance, another instance's sign-out reaches this one at the next sync (a
// minute at most, see app.ts) - and a refresh always asks the table directly.
// ---------------------------------------------------------------------------

const store = new RevokedSessionStore();

/** What a request on a signed-out session is told, by checkAuth and by refresh. */
export const SIGNED_OUT_MESSAGE = "You have signed out. Please sign in again.";

/** The per-request check: memory only. */
export const isSessionRevokedLocally = (sid: unknown): boolean => store.has(sid);

/** The refresh-time check: memory, then the table. */
export const isSessionRevoked = async (sid: string): Promise<boolean> => {
    if (store.has(sid)) return true;

    const row = await prisma.revokedSession.findUnique({
        where: { sid },
        select: { expires_at: true },
    });
    if (!row) return false;

    store.add(sid, row.expires_at.getTime());
    return store.has(sid);
};

/** Sign a session out. `expiresAt` is when it would have ended anyway. */
export const revokeSession = async (sid: string, userId: string, expiresAt: Date): Promise<void> => {
    // Memory first, so the very next request is refused even if the write is slow.
    store.add(sid, expiresAt.getTime());

    await prisma.revokedSession.upsert({
        where: { sid },
        create: { sid, user_id: userId, expires_at: expiresAt },
        update: {},
    });
};

/** Load every still-relevant revocation from the table. Run at boot and on a timer. */
export const syncRevokedSessions = async (): Promise<void> => {
    const rows = await prisma.revokedSession.findMany({
        where: { expires_at: { gt: new Date() } },
        select: { sid: true, expires_at: true },
    });
    // Added, never replaced: an entry revoked a moment ago may not be in the
    // rows just read.
    for (const row of rows) store.add(row.sid, row.expires_at.getTime());
    store.prune();
};

/** Rows for sessions that have ended are of no further use. */
export const purgeExpiredRevocations = () =>
    prisma.revokedSession.deleteMany({ where: { expires_at: { lt: new Date() } } });
