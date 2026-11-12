// The product's own identity, in one place.
//
// It used to be typed out at each call site - "Local Business Management"
// in two different From headers, "LocalBiz" in the app's title bar
// - so a customer could get three names for one product in a single week.
// Change it here and every system email follows.

/** What the logo says, and what a customer recognises the software by. */
export const PRODUCT_NAME = "LocalBiz";

/** The one-liner under the name, for places with room for it. */
export const PRODUCT_TAGLINE = "Local Business Management";

/** Where the app lives - used for links in outgoing email. */
export const PRODUCT_URL = process.env.FRONTEND_URL || "http://localhost:5174";

/**
 * The support line to print when platform settings carry none. Kept in step
 * with the frontend's localbiz-frontend/src/lib/support.ts, and with the column default on
 * PlatformSetting.support_number.
 */
export const SUPPORT_NUMBER_FALLBACK = "01719731884";

/** A tel: href for any Bangladeshi local number, e.g. 01719731884 -> +8801719731884. */
export const telHref = (localNumber: string): string => {
    const digits = String(localNumber || "").replace(/\D/g, "");
    // 01XXXXXXXXX -> +880 1XXXXXXXXX. Anything else is passed through as typed,
    // because guessing a country code onto an unexpected format is worse than
    // a link that dials exactly what is printed.
    return digits.length === 11 && digits.startsWith("01")
        ? `tel:+88${digits}`
        : `tel:${digits || localNumber}`;
};
