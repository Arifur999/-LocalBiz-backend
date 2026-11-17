// What has to be true of the secrets before a production server may start.
//
// env.ts used to check only that they were set. `.env.example` ships
// "change_this_access_secret", and that file is public - so a server started
// from a copied example signed its tokens with a value anyone can read, and
// anyone could mint a super-admin token for it.
//
// Kept free of imports (and of env.ts, which throws on load without a full
// environment) so the rules can be tested on their own.

export const MIN_TOKEN_SECRET_LENGTH = 32;
export const MIN_SUPER_ADMIN_PASSWORD_LENGTH = 12;

type SecretVars = Partial<Record<
    "ACCESS_TOKEN_SECRET" | "REFRESH_TOKEN_SECRET" | "SUPER_ADMIN_PASSWORD",
    string | undefined
>>;

// The values .env.example and the docs show, in any casing.
const looksLikePlaceholder = (value: string) =>
    /^(change[_-]?(this|me)|your[_-]|example|secret$|password$|<)/i.test(value.trim());

/** Every reason these secrets are unfit for production; empty when they are fine. */
export const weakSecretProblems = (vars: SecretVars): string[] => {
    const problems: string[] = [];
    const access = vars.ACCESS_TOKEN_SECRET ?? "";
    const refresh = vars.REFRESH_TOKEN_SECRET ?? "";
    const adminPassword = vars.SUPER_ADMIN_PASSWORD ?? "";

    for (const [name, value] of [["ACCESS_TOKEN_SECRET", access], ["REFRESH_TOKEN_SECRET", refresh]] as const) {
        if (looksLikePlaceholder(value)) {
            problems.push(`${name} is still an example value`);
        } else if (value.length < MIN_TOKEN_SECRET_LENGTH) {
            problems.push(`${name} must be at least ${MIN_TOKEN_SECRET_LENGTH} characters (try: openssl rand -hex 32)`);
        }
    }

    // One secret for both would let an access token be replayed as a refresh
    // token, which carries the session deadline the access token does not.
    if (access !== "" && access === refresh) {
        problems.push("ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different");
    }

    // This account reaches every workspace.
    if (looksLikePlaceholder(adminPassword)) {
        problems.push("SUPER_ADMIN_PASSWORD is still an example value");
    } else if (adminPassword.length < MIN_SUPER_ADMIN_PASSWORD_LENGTH) {
        problems.push(`SUPER_ADMIN_PASSWORD must be at least ${MIN_SUPER_ADMIN_PASSWORD_LENGTH} characters`);
    }

    return problems;
};
