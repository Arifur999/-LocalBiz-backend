import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { weakSecretProblems } from "./secretStrength.js";

const strong = {
    ACCESS_TOKEN_SECRET: "a".repeat(20) + "9f3c1e7b5d2a4c6e8f0b",
    REFRESH_TOKEN_SECRET: "b".repeat(20) + "1d3f5a7c9e0b2d4f6a8c",
    SUPER_ADMIN_PASSWORD: "Xk4-long-admin-pass",
};

// A production server must refuse to start on these; see env.ts.
describe("weakSecretProblems", () => {
    it("accepts long, distinct, non-example secrets", () => {
        assert.deepEqual(weakSecretProblems(strong), []);
    });

    it("rejects the values .env.example ships", () => {
        const problems = weakSecretProblems({
            ...strong,
            ACCESS_TOKEN_SECRET: "change_this_access_secret",
            REFRESH_TOKEN_SECRET: "change_this_refresh_secret",
        });
        assert.equal(problems.length, 2);
        assert.ok(problems.every((p) => p.includes("example value")));
    });

    it("rejects short token secrets", () => {
        const problems = weakSecretProblems({ ...strong, ACCESS_TOKEN_SECRET: "short-secret" });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /ACCESS_TOKEN_SECRET must be at least 32/);
    });

    it("rejects one secret used for both tokens", () => {
        const problems = weakSecretProblems({ ...strong, REFRESH_TOKEN_SECRET: strong.ACCESS_TOKEN_SECRET });
        assert.deepEqual(problems, ["ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different"]);
    });

    it("rejects a short or missing super admin password", () => {
        assert.equal(weakSecretProblems({ ...strong, SUPER_ADMIN_PASSWORD: "admin123" }).length, 1);
        assert.equal(weakSecretProblems({ ...strong, SUPER_ADMIN_PASSWORD: undefined }).length, 1);
    });
});
