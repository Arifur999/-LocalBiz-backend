import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Application, Request, Response } from "express";
import helmet from "helmet";
import cron from "node-cron";
import { prisma } from "./app/lib/prisma.js";
import { globalErrorHandler } from "./app/middleware/globalErrorHandler.js";
import notFound from "./app/middleware/notFound.js";
import { apiLimiter } from "./app/middleware/rateLimit.js";
import { indexRoute } from "./app/routes/index.js";
import { purgeExpiredOtps } from "./app/utils/otp.js";
import { purgeExpiredRevocations, syncRevokedSessions } from "./app/utils/sessionRevocation.js";
import { sendExpiryReminders } from "./app/utils/subscriptionReminders.js";
import { env } from "./config/env.js";

const app: Application = express();

// Hourly: flip active subscriptions past their expiry date to expired
// (replaces the lazy check_owner_subscription_expiry RPC with a sweep).
cron.schedule("0 * * * *", async () => {
    try {
        const result = await prisma.ownerSubscription.updateMany({
            where: {
                plan_status: "active",
                expiry_date: { lt: new Date() },
            },
            data: {
                plan_status: "expired",
                status: "expired",
            },
        });
        if (result.count > 0) {
            console.log(`Subscription sweep: marked ${result.count} subscription(s) as expired`);
        }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        console.error("Subscription expiry sweep failed:", error.message);
    }

    // Housekeeping for the two auth tables that only ever grow otherwise:
    // sign-outs whose session has ended, and codes nobody came back to use.
    try {
        await purgeExpiredRevocations();
        await purgeExpiredOtps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        console.error("Auth table cleanup failed:", error.message);
    }
});

// Every minute: pick up sign-outs recorded by another instance (and drop the
// ones that no longer matter). This process already knows its own at once, so
// with the single backend the compose file runs this only confirms the table.
cron.schedule("* * * * *", async () => {
    try {
        await syncRevokedSessions();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        console.error("Revoked-session sync failed:", error.message);
    }
});

// Daily at 9am: email owners whose subscription expires in exactly 15, 7 or
// 3 days, using the super-admin editable template (see platformSettings
// module). sendExpiryReminders() dedupes internally via ReminderLog.
cron.schedule("0 9 * * *", async () => {
    try {
        await sendExpiryReminders();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
        console.error("Expiry reminder cron failed:", error.message);
    }
});

// Sits behind nginx, so the client address arrives in X-Forwarded-For. Without
// this every request looks like it came from the proxy, which would put all
// users in one rate-limit bucket and let a single attacker lock out everybody.
// 1 = trust exactly one proxy hop, which is what the compose stack has.
app.set("trust proxy", 1);

// The API's own response headers (nosniff, no framing, no X-Powered-By ...).
// nginx sets these for the site as a whole, but only when a request comes
// through it; this covers the API whichever way it is reached.
//
// HSTS is left to nginx on purpose: helmet's default adds includeSubDomains,
// which would force HTTPS on every other subdomain of the site's domain - a
// decision for whoever owns the domain, not for this file.
app.use(helmet({ strictTransportSecurity: false }));

// FRONTEND_URL may be a single origin or a comma-separated list (e.g. both
// the www and bare-domain variants of a site: FRONTEND_URL=
// https://example.com,https://www.example.com).
const staticAllowedOrigins = [
    ...env.FRONTEND_URL.split(",").map((url) => url.trim()).filter(Boolean),
];

// The SPA and the API are served from one origin (nginx proxies /api/ on the
// same host), so in production the browser never makes a cross-origin request
// and nothing beyond the configured origin needs to be allowed.
//
// Development keeps the localhost allowances so `npm run dev` on any Vite port
// still reaches a local backend.
//
// Removed deliberately: `*.hostingersite.com`, which allowed ANY Hostinger
// preview subdomain - free for anyone to register - as a credentialed origin.
// It dated from a period when the frontend ran on a preview URL; that hosting
// is gone. Cookies are SameSite=lax so it was not exploitable on its own, but
// combined with the Bearer-token fallback in checkAuth it was one config change
// away from being a real cross-origin read of every tenant's data.
const isDevelopment = env.NODE_ENV !== "production";

function isAllowedOrigin(origin?: string): boolean {
    // No Origin header: same-origin navigations, curl, server-to-server.
    if (!origin) return true;
    if (staticAllowedOrigins.includes(origin)) return true;
    if (isDevelopment && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    return false;
}

app.use(cors({
    origin(origin, callback) {
        callback(null, isAllowedOrigin(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    // X-Client is deliberately NOT here: it switches auth into mobile mode,
    // which returns tokens in the body (shared/mobileClient.ts). The app is not
    // a browser and needs no CORS; keeping it out stops any web page using it.
    allowedHeaders: ["Content-Type", "Authorization"],
}));

// Cookies are parsed first because the limiter below keys on the signed-in
// user, and it sits ahead of the body parsers so a caller over the ceiling is
// turned away before a 2 MB body is read for them.
app.use(cookieParser());
app.use("/api/v1", apiLimiter);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api/v1", indexRoute);

app.get("/", async (req: Request, res: Response) => {
    res.status(200).json({
        success: true,
        message: "LocalBiz API is working",
    });
});

// notFound BEFORE globalErrorHandler, which is the order Express actually needs.
//
// It worked the other way round by accident: globalErrorHandler takes four
// arguments, so Express treats it as an error handler and skips it in the normal
// chain, letting notFound answer. But an error thrown from notFound itself had no
// handler after it, and the reversed order says the opposite of what it does.
app.use(notFound);
app.use(globalErrorHandler);

export default app;
