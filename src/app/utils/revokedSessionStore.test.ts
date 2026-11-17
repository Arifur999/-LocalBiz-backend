import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RevokedSessionStore } from "./revokedSessionStore.js";

// Signing out used to clear the cookies and nothing else, so a copied token
// went on working for the rest of the 15-day session. This store is what
// checkAuth consults to refuse it.
describe("RevokedSessionStore", () => {
    const now = 1_000_000;

    it("refuses a signed-out session until its deadline", () => {
        const store = new RevokedSessionStore();
        store.add("sid-1", now + 5_000);
        assert.equal(store.has("sid-1", now), true);
        assert.equal(store.has("sid-1", now + 4_999), true);
    });

    it("leaves other sessions of the same user alone", () => {
        const store = new RevokedSessionStore();
        store.add("phone", now + 5_000);
        assert.equal(store.has("laptop", now), false);
    });

    it("forgets a session once it would have ended anyway", () => {
        const store = new RevokedSessionStore();
        store.add("sid-1", now + 5_000);
        assert.equal(store.has("sid-1", now + 5_000), false);
        assert.equal(store.size, 0);
    });

    it("treats a token without a session id as not revoked", () => {
        const store = new RevokedSessionStore();
        store.add("sid-1", now + 5_000);
        assert.equal(store.has(undefined, now), false);
        assert.equal(store.has("", now), false);
        assert.equal(store.has(42, now), false);
    });

    it("prunes only the entries that have ended", () => {
        const store = new RevokedSessionStore();
        store.add("old", now - 1);
        store.add("live", now + 5_000);
        store.prune(now);
        assert.equal(store.size, 1);
        assert.equal(store.has("live", now), true);
    });
});
