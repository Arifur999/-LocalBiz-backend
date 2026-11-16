import { Role } from "../../../generated/prisma/enums.js";
import { IRequestUser } from "../../interfaces/requestUser.interface.js";
import { READS, type Permission } from "../../shared/permissions.js";

// The feed used to show every source to anyone in the workspace, so a sales
// clerk barred from the expense and loan pages still read those amounts here.
// Each source now passes the same two gates as its own list route: the role
// list on that route's checkAuth, then requirePermission with its READS set
// (owners always pass, and staff with no boxes ticked pass - see
// requirePermission for why).
const BACK_OFFICE: Role[] = [Role.owner, Role.manager, Role.accountant];

const mayRead = (user: IRequestUser, roles: Role[] | null, permissions: readonly Permission[]) => {
    if (user.role === Role.owner || user.role === Role.super_admin) return true;
    if (roles && !roles.includes(user.role)) return false;
    const granted = user.permissions ?? [];
    return granted.length === 0 || permissions.some((p) => granted.includes(p));
};

export const readableSources = (user: IRequestUser) => ({
    sales: mayRead(user, null, READS.sales),
    purchases: mayRead(user, BACK_OFFICE, READS.purchases),
    expenses: mayRead(user, BACK_OFFICE, READS.expenses),
    customerPayments: mayRead(user, null, READS.customerPayments),
    supplierPayments: mayRead(user, BACK_OFFICE, READS.supplierPayments),
    loans: mayRead(user, BACK_OFFICE, READS.loans),
    otherIncomes: mayRead(user, null, READS.otherIncomes),
});
