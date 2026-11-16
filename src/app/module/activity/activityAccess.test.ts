import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "../../../generated/prisma/enums.js";
import type { IRequestUser } from "../../interfaces/requestUser.interface.js";
import { readableSources } from "./activityAccess.js";

const user = (role: Role, permissions: string[] = []): IRequestUser => ({
    userId: "u1", ownerId: "o1", role, email: "x@example.com", name: "X", permissions,
});

/**
 * The day feed must show a source only to someone its own list route would
 * serve. Before this, every source went to anyone in the workspace, so a sales
 * clerk read expense and loan amounts they could not open as pages.
 */
describe("readableSources", () => {
    it("lets an owner read everything", () => {
        assert.ok(Object.values(readableSources(user(Role.owner))).every(Boolean));
    });

    it("keeps sales staff out of the back-office sources even with no boxes ticked", () => {
        const r = readableSources(user(Role.sales_staff));
        assert.equal(r.expenses, false);
        assert.equal(r.loans, false);
        assert.equal(r.purchases, false);
        assert.equal(r.supplierPayments, false);
        // ...while what their own routes allow still shows.
        assert.equal(r.sales, true);
        assert.equal(r.customerPayments, true);
    });

    it("follows the ticked permissions for a back-office role", () => {
        const r = readableSources(user(Role.accountant, ["page:sales.ledger"]));
        assert.equal(r.sales, true);
        assert.equal(r.expenses, false);
    });

    it("lets a manager with no restrictions read the back-office sources", () => {
        const r = readableSources(user(Role.manager));
        assert.equal(r.expenses, true);
        assert.equal(r.loans, true);
    });
});
