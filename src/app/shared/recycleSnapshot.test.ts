import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanRecycleMeta } from "./recycleSnapshot.js";

// The recycle meta comes off the DELETE body unvalidated. A wrong type used to
// reach Prisma as a 500 and text had no length cap; now it is cleaned instead,
// so a delete never fails over a label.
describe("cleanRecycleMeta", () => {
    it("keeps well-formed metadata", () => {
        assert.deepEqual(cleanRecycleMeta({ type: "sale", title: "INV-1", subtitle: "Rahim", amount: 500 }), {
            type: "sale", title: "INV-1", subtitle: "Rahim", amount: 500,
        });
    });

    it("drops values of the wrong type so the server fallback is used", () => {
        assert.deepEqual(cleanRecycleMeta({ type: 42, title: { x: 1 }, amount: "500" }), {
            type: undefined, title: undefined, subtitle: undefined, amount: undefined,
        });
        assert.deepEqual(cleanRecycleMeta("nonsense"), {});
        assert.deepEqual(cleanRecycleMeta(undefined), {});
    });

    it("caps text length and rejects non-finite amounts", () => {
        const cleaned = cleanRecycleMeta({ title: "x".repeat(10_000), amount: Infinity });
        assert.equal(cleaned.title?.length, 200);
        assert.equal(cleaned.amount, undefined);
    });
});
