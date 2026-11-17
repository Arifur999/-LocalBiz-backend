import { Role } from "../../generated/prisma/enums.js";

export interface IRequestUser {
    userId: string;
    // Workspace owner id: for owners this equals userId, for team members it
    // points at their owner. Every workspace query is scoped by this.
    ownerId: string;
    role: Role;
    email: string;
    name: string;
    // Copied from users.token_version when the token is minted and compared
    // against the current value on every request, so a password change ends
    // sessions that were already open. Optional: tokens issued before the
    // column existed carry no version and are read as 0.
    tokenVersion?: number;
    // Which sign-in this token belongs to. Minted at login, copied through
    // every refresh, and written to revoked_sessions on sign-out so that one
    // session can be ended without touching the user's other devices.
    // Optional: tokens issued before the claim existed carry none and get one
    // at their next refresh.
    sid?: string;
    // What this user may do within their role. Empty means "everything the role
    // allows" - see shared/permissions.ts for why that is the safe default.
    permissions: string[];
}
