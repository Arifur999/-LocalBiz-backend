import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import status from "http-status";
import { env } from "../../../config/env.js";
import { PlanStatus, Role, SubscriptionStatus } from "../../../generated/prisma/enums.js";
import AppError from "../../errorHelpers/AppError.js";
import { IRequestUser } from "../../interfaces/requestUser.interface.js";
import { prisma } from "../../lib/prisma.js";
import { skipsLoginOtp } from "../../shared/loginOtp.js";
import { logAdminActivity } from "../../utils/activityLog.js";
import { invalidateUser } from "../../utils/authCache.js";
import { jwtUtils } from "../../utils/jwt.js";
import { OTP_PURPOSE_RESET_PASSWORD, WRONG_CODE_MESSAGE, otpUtils } from "../../utils/otp.js";
import { SIGNED_OUT_MESSAGE, isSessionRevoked, revokeSession } from "../../utils/sessionRevocation.js";
import { SIGNUP_SMS_CREDITS } from "../../utils/smsGrants.js";
import { checkOwnerSubscriptionExpiry } from "../../utils/subscription.js";
import { SESSION_MAX_AGE_MS, newSessionExp, sessionTimeLeftMs, tokenUtils } from "../../utils/token.js";
import { ILoginPayload, IRegisterOwnerPayload } from "./auth.interface.js";

const TRIAL_DAYS = 7;

// A real bcrypt hash of a password nobody has, at the cost real accounts use.
// loginUser compares against it when the email is unknown so that case takes
// as long as a wrong password does.
const UNKNOWN_ACCOUNT_HASH = bcrypt.hashSync(randomUUID(), 10);

const addDays = (date: Date, days: number) => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toProfile = (user: any) => ({
    id: user.id,
    owner_id: user.owner_id,
    full_name: user.full_name,
    email: user.email,
    role: user.role,
    phone: user.phone,
    avatar_url: user.avatar_url,
    branch_id: user.branch_id,
    is_active: user.is_active,
    // The app hides menu entries this user cannot use. Presentation only - every
    // one of those routes is guarded on the server too.
    permissions: user.permissions ?? [],
    last_active: user.last_active,
    created_at: user.created_at,
});

const buildTokenPayload = (user: {
    id: string;
    owner_id: string | null;
    role: Role;
    email: string;
    full_name: string;
    token_version?: number;
}): IRequestUser => ({
    userId: user.id,
    ownerId: user.role === Role.super_admin ? user.id : (user.owner_id ?? user.id),
    // Deliberately not in the token. Permissions are read from the database by
    // checkAuth on every request, so changing them takes effect at once instead
    // of when the token expires - the same reasoning as token_version.
    permissions: [],
    role: user.role,
    email: user.email,
    name: user.full_name,
    // Stamped in so checkAuth can retire this token when the password changes.
    tokenVersion: user.token_version ?? 0,
});

const registerOwner = async (payload: IRegisterOwnerPayload) => {
    const email = payload.email.trim().toLowerCase();

    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
        throw new AppError(status.CONFLICT, "An account with this email already exists");
    }

    const hashedPassword = await bcrypt.hash(payload.password, 10);
    const registeredAt = new Date();

    // Registration no longer auto-starts the trial. The owner is created in a
    // "no active plan yet" state and, after verifying their email, lands on
    // /choose-plan where they explicitly start the 7-day trial (via the
    // free-trial card popup) or pick the yearly plan. Modelled as expired so
    // the frontend's ProtectedRoute sends them to /choose-plan (never a lock
    // screen), and trial_used=false so the trial is still available to start.
    const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: {
                email,
                password: hashedPassword,
                full_name: payload.fullName,
                phone: payload.phone,
                role: Role.owner,
            },
        });

        const updatedUser = await tx.user.update({
            where: { id: user.id },
            data: { owner_id: user.id },
        });

        const subscription = await tx.ownerSubscription.create({
            data: {
                owner_id: user.id,
                business_name: payload.businessName,
                owner_email: email,
                address: payload.address ?? "",
                status: SubscriptionStatus.expired,
                plan: "Trial",
                trial_start: registeredAt,
                trial_end: addDays(registeredAt, TRIAL_DAYS),
                active_until: null,
                plan_type: "free_trial",
                plan_status: PlanStatus.expired,
                start_date: registeredAt,
                expiry_date: registeredAt,
                // Trial not consumed yet - the owner starts it from the
                // free-trial card popup on /choose-plan.
                trial_used: false,
            },
        });

        // Welcome credits: the owner can try SMS out before buying a package.
        await tx.smsWallet.create({
            data: { owner_id: user.id, balance: SIGNUP_SMS_CREDITS },
        });

        return { user: updatedUser, subscription };
    });

    await logAdminActivity({
        ownerId: result.user.id,
        actorEmail: email,
        action: "owner_registered",
        detail: `${payload.businessName} registered with a ${TRIAL_DAYS}-day free trial`,
    });

    // SaaS email verification gate:
    // registration does NOT log the user in. We send a 6-digit OTP to their
    // inbox and the frontend shows the "enter code" screen. Cookies are only
    // issued after /auth/verify-otp succeeds.
    await otpUtils.issueOtp(email, payload.fullName);

    return {
        needsEmailConfirmation: true as const,
        email,
    };
};

// Builds the logged-in payload (profile + subscription + tokens) for a user.
// Shared by the OTP step and, when the OTP gate is switched off, by login.
//
// Never blocks on subscription status: pending / expired / blocked owners all
// sign in, and the frontend's ProtectedRoute shows the matching lock screen
// (expired owners are sent to checkout so they can pay again).
const issueSession = async (user: {
    id: string; email: string; full_name: string; role: Role;
    owner_id: string | null; phone: string; is_active: boolean;
    email_verified: boolean; branch_id: string | null;
    last_active: Date | null; created_at: Date; updated_at: Date; password: string;
}) => {
    let subscription = null;
    if (user.role !== Role.super_admin) {
        subscription = await checkOwnerSubscriptionExpiry(user.owner_id ?? user.id);
    }

    if (user.role === Role.owner) {
        await prisma.user.update({
            where: { id: user.id },
            data: { last_active: new Date() },
        });
    }

    // A fresh id per sign-in: it is what signing out revokes (endSession).
    const tokenPayload = { ...buildTokenPayload(user), sid: randomUUID() };
    // Signing in is the only thing that starts a session clock. From here the
    // deadline is fixed: refreshing carries it forward, it never moves.
    const sessionExp = newSessionExp();

    return {
        user: { id: user.id, email: user.email },
        profile: toProfile(user),
        subscription,
        accessToken: tokenUtils.getAccessToken(tokenPayload, sessionExp),
        refreshToken: tokenUtils.getRefreshToken(tokenPayload, sessionExp),
        sessionMaxAgeMs: sessionTimeLeftMs(sessionExp),
    };
};

// Step 2 of registration (and of unverified logins): the user submits the
// 6-digit code from their inbox. On success we flag the account verified and
// issue the auth cookies - this IS the login.
const verifyEmailOtp = async (email: string, code: string) => {
    const normalizedEmail = email.trim().toLowerCase();

    // The code is checked BEFORE the account is looked up. An address with no
    // account then answers exactly like a real one - wrong code, attempts left,
    // expired - instead of "no account found", which told anyone who asked
    // which emails are customers. Throws on every failure.
    await otpUtils.verifyOtp(normalizedEmail, code);

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (!user) {
        // Only reachable by guessing the undelivered code left for an unknown
        // address (see resendVerificationOtp). It opens nothing.
        throw new AppError(status.BAD_REQUEST, WRONG_CODE_MESSAGE);
    }

    // Mark the account verified (idempotent if it somehow already was).
    const verifiedUser = await prisma.user.update({
        where: { id: user.id },
        data: { email_verified: true },
    });
    // checkAuth reads email_verified from its cache.
    invalidateUser(user.id);

    // Code accepted -> this is the moment a session actually starts.
    return issueSession(verifiedUser);
};

// Re-send the verification code (60s cooldown enforced inside otpUtils).
const resendVerificationOtp = async (email: string) => {
    const normalizedEmail = email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    // No "already verified" rejection: verified accounts still need a code on
    // every login, so resend has to work for them too.
    //
    // And no "no account found": an unknown address goes through the same
    // cooldown and gets the same answer, with a code that is never mailed
    // (deliver = false). See issueOtp for why the row is still written.
    await otpUtils.resendOtp(normalizedEmail, user?.full_name ?? "", undefined, Boolean(user));

    return { sent: true, email: normalizedEmail };
};

// Step 1 of "forgot password": email a 6-digit reset code. Always responds
// success (never reveals whether the email is registered), but only sends a
// code when the account actually exists.
const forgotPassword = async (email: string) => {
    const normalizedEmail = email.trim().toLowerCase();

    // For a while this answered "This email is not registered" so a mistyped
    // address was obvious. That same answer let anyone test a list of emails
    // for customers of the platform, so it is gone: both cases now run the same
    // steps and say the same thing, and the reset screen tells the user to
    // check the address if nothing arrives.
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    // resendOtp, not issueOtp: this is the path an attacker would use to mint a
    // fresh code after burning the five attempts on the last one. issueOtp has
    // no cooldown, so calling it directly here meant the attempt cap could be
    // reset at will. resendOtp applies the 60s wait and issues the code itself.
    //
    // deliver = false for an unknown address: same cooldown, same row, no mail.
    await otpUtils.resendOtp(normalizedEmail, user?.full_name ?? "", OTP_PURPOSE_RESET_PASSWORD, Boolean(user));

    return { message: "If this email is registered, a reset code has been sent to it." };
};

// Step 2: verify the reset code and set the new password.
const resetPassword = async (email: string, code: string, newPassword: string) => {
    const normalizedEmail = email.trim().toLowerCase();

    // Code first, account second - same reason as verifyEmailOtp: an unknown
    // address must answer like a real one with a wrong code.
    // Throws on wrong/expired/over-attempted codes.
    await otpUtils.verifyOtp(normalizedEmail, code, OTP_PURPOSE_RESET_PASSWORD);

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
        throw new AppError(status.BAD_REQUEST, WRONG_CODE_MESSAGE);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
        where: { id: user.id },
        data: {
            password: hashedPassword,
            // The usual reason for resetting a password is that someone else
            // may have it. Bumping the version retires every token already
            // issued, so whoever else was signed in is signed out now rather
            // than when their token happens to expire.
            token_version: { increment: 1 },
        },
    });
    invalidateUser(user.id);

    return { message: "Password reset successfully. Please sign in with your new password." };
};

const loginUser = async (payload: ILoginPayload) => {
    const email = payload.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
        // Spend the same bcrypt time a real account would. Answering at once
        // made "no such email" measurably faster than "wrong password", which
        // gave away what the identical message was meant to hide.
        await bcrypt.compare(payload.password, UNKNOWN_ACCOUNT_HASH);
        throw new AppError(status.UNAUTHORIZED, "Invalid email or password");
    }

    const isPasswordValid = await bcrypt.compare(payload.password, user.password);

    if (!isPasswordValid) {
        throw new AppError(status.UNAUTHORIZED, "Invalid email or password");
    }

    if (!user.is_active) {
        throw new AppError(status.FORBIDDEN, "Your account has been deactivated. Please contact your owner or administrator.");
    }

    // Break-glass: if the mail provider ever goes down, every account would be
    // locked out with no way back in. Setting LOGIN_OTP_ENABLED=false on the
    // server restores password-only login without needing a code change. And
    // the accounts listed in REVIEW_LOGIN_EMAILS - the app stores' reviewers,
    // who cannot read the code - sign in with their password alone.
    // Unverified accounts still have to confirm their email.
    if (skipsLoginOtp({ otpEnabled: env.LOGIN_OTP_ENABLED, reviewEmails: env.REVIEW_LOGIN_EMAILS, email: user.email, emailVerified: user.email_verified })) {
        return issueSession(user);
    }

    // Two-factor gate: the password alone never logs anyone in. Every sign-in
    // mails a fresh 6-digit code, and tokens are only issued once that code is
    // submitted to verifyEmailOtp. This also covers the old "email was never
    // verified" case - that same step marks the account verified.
    try {
        await otpUtils.issueOtp(user.email, user.full_name);
    } catch (error) {
        // Mail issues must not block the response - the frontend still needs to
        // show the OTP screen with a resend button.
        console.error("[otp] Could not auto-send login OTP:", error);
    }

    return {
        needsEmailConfirmation: true as const,
        email: user.email,
    };
};


const getMe = async (requestUser: IRequestUser) => {
    const user = await prisma.user.findUnique({
        where: { id: requestUser.userId },
    });

    if (!user) {
        throw new AppError(status.NOT_FOUND, "User not found");
    }

    let subscription = null;

    if (user.role !== Role.super_admin) {
        const ownerId = user.owner_id ?? user.id;
        subscription = await checkOwnerSubscriptionExpiry(ownerId);
    }

    return {
        user: { id: user.id, email: user.email },
        profile: toProfile(user),
        subscription,
    };
};

// The refresh token carries one claim the access token does not: when this
// session must end. Everything else about the user is re-read from the row.
export type IRefreshTokenPayload = IRequestUser & { sessionExp?: number };

const getNewTokens = async (refreshTokenPayload: IRefreshTokenPayload) => {
    const user = await prisma.user.findUnique({
        where: { id: refreshTokenPayload.userId },
    });

    if (!user || !user.is_active) {
        throw new AppError(status.UNAUTHORIZED, "Unauthorized access!");
    }

    // Same check checkAuth makes: a refresh token issued before a password
    // change must not be able to mint a fresh pair, or the reset would only
    // last until the next refresh.
    if ((refreshTokenPayload.tokenVersion ?? 0) !== user.token_version) {
        throw new AppError(status.UNAUTHORIZED, "Your password was changed. Please sign in again.");
    }

    // Tokens minted before sessionExp existed carry none. Rather than sign
    // those people out the moment this ships, they are given a window starting
    // now - the old token could not have been more than a day old anyway.
    const sessionExp = refreshTokenPayload.sessionExp ?? newSessionExp();
    const timeLeftMs = sessionTimeLeftMs(sessionExp);

    // jwt.verify already rejects a refresh token past its own exp, and that exp
    // is capped to sessionExp - so this only catches a token whose claim says
    // the session is over while its signature has not expired yet.
    if (timeLeftMs <= 0) {
        throw new AppError(status.UNAUTHORIZED, "Your session has ended. Please sign in again.");
    }

    // A session that was signed out must not be able to renew itself. This is
    // the one place that asks the table rather than memory, so it holds across
    // restarts and across instances.
    if (refreshTokenPayload.sid && (await isSessionRevoked(refreshTokenPayload.sid))) {
        throw new AppError(status.UNAUTHORIZED, SIGNED_OUT_MESSAGE);
    }

    // The same session id forward; a token from before the claim existed gets
    // one here, which is the moment it becomes revocable.
    const tokenPayload = { ...buildTokenPayload(user), sid: refreshTokenPayload.sid ?? randomUUID() };

    return {
        accessToken: tokenUtils.getAccessToken(tokenPayload, sessionExp),
        // Same deadline, not a new one: rotation renews the token, never the
        // session.
        refreshToken: tokenUtils.getRefreshToken(tokenPayload, sessionExp),
        sessionMaxAgeMs: timeLeftMs,
    };
};

/**
 * Ends the session the given tokens belong to, on the server.
 *
 * Signing out used to clear the cookies and stop there, so a token copied off
 * the device beforehand kept working - and kept refreshing - for the rest of
 * the 15-day session. Now the session id is written to revoked_sessions:
 * checkAuth refuses its access tokens and getNewTokens refuses its refresh
 * tokens. Only this session ends; the user's other devices stay signed in.
 *
 * Either token identifies the session. The refresh token is preferred because
 * it carries the session deadline; an access token alone falls back to the
 * longest a session can last, which only means the row is kept a little longer
 * than needed.
 */
const endSession = async (tokens: { refreshToken?: string; accessToken?: string }) => {
    const verified = [
        tokens.refreshToken ? jwtUtils.verifyToken(tokens.refreshToken, env.REFRESH_TOKEN_SECRET) : null,
        tokens.accessToken ? jwtUtils.verifyToken(tokens.accessToken, env.ACCESS_TOKEN_SECRET) : null,
    ].find((result) => result?.success === true && typeof result.decoded.sid === "string");

    // No valid token, or one from before sessions had ids: nothing to revoke,
    // and nothing that was not already true before this existed.
    if (!verified || !verified.success) return { revoked: false };

    const { sid, userId, sessionExp } = verified.decoded;
    const expiresAt = typeof sessionExp === "number"
        ? new Date(sessionExp * 1000)
        : new Date(Date.now() + SESSION_MAX_AGE_MS);

    await revokeSession(sid, String(userId ?? ""), expiresAt);
    return { revoked: true };
};

const touchOwnerActivity = async (requestUser: IRequestUser) => {
    if (requestUser.role !== Role.owner) return { touched: false };

    await prisma.user.update({
        where: { id: requestUser.userId },
        data: { last_active: new Date() },
    });

    return { touched: true };
};

export const AuthService = {
    registerOwner,
    loginUser,
    verifyEmailOtp,
    resendVerificationOtp,
    forgotPassword,
    resetPassword,
    getMe,
    getNewTokens,
    endSession,
    touchOwnerActivity,
};
