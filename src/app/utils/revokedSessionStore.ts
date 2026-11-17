// The in-memory half of session revocation: which session ids have been signed
// out, and until when that still matters.
//
// checkAuth asks this on every request, so it has to answer without a database
// round trip. The database (revoked_sessions) is the record; this is the copy
// kept close at hand - see sessionRevocation.ts for how the two stay together.
//
// No imports, so the rules can be tested on their own.

export class RevokedSessionStore {
    /** session id -> the moment (ms) its session would have ended anyway. */
    private readonly endsAt = new Map<string, number>();

    add(sid: string, expiresAtMs: number): void {
        this.endsAt.set(sid, expiresAtMs);
    }

    /**
     * True while a signed-out session could still be carrying valid tokens.
     * Once its deadline passes the tokens are dead on their own, so the entry
     * is dropped rather than kept forever.
     */
    has(sid: unknown, now: number = Date.now()): boolean {
        if (typeof sid !== "string" || sid === "") return false;
        const endsAt = this.endsAt.get(sid);
        if (endsAt === undefined) return false;
        if (endsAt <= now) {
            this.endsAt.delete(sid);
            return false;
        }
        return true;
    }

    /** Drop every entry whose session has ended. */
    prune(now: number = Date.now()): void {
        for (const [sid, endsAt] of this.endsAt) {
            if (endsAt <= now) this.endsAt.delete(sid);
        }
    }

    get size(): number {
        return this.endsAt.size;
    }
}
