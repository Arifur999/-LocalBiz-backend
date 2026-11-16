import z from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { IRequestUser } from "../interfaces/requestUser.interface.js";

// Deletable records get snapshotted into recycle_bin_items (the old app kept
// these snapshots in localStorage). The frontend passes the same display
// metadata it used to compute; the raw row JSON is captured server-side.
export const recycleMetaZodSchema = z.object({
    type: z.string("Recycle type must be string").min(1),
    title: z.string("Title must be string").optional(),
    subtitle: z.string("Subtitle must be string").optional(),
    amount: z.number("Amount must be a number").optional(),
}).optional();

export type IRecycleMeta = z.infer<typeof recycleMetaZodSchema>;

export const buildRecycleItemData = (input: {
    user: IRequestUser;
    tableName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any;
    meta?: IRecycleMeta;
    fallbackType: string;
    fallbackTitle?: string;
    fallbackSubtitle?: string;
    fallbackAmount?: number | Prisma.Decimal;
}) => {
    const meta = cleanRecycleMeta(input.meta);
    return {
        owner_id: input.user.ownerId,
        type: meta.type ?? input.fallbackType,
        title: meta.title ?? input.fallbackTitle ?? "",
        subtitle: meta.subtitle ?? input.fallbackSubtitle ?? "",
        amount: meta.amount ?? input.fallbackAmount ?? 0,
        table_name: input.tableName,
        data: JSON.parse(JSON.stringify(input.row)),
        deleted_by: input.user.userId,
    };
};

const META_TEXT_MAX = 200;

/**
 * The display metadata a DELETE carries, reduced to what is safe to store.
 *
 * It reaches here straight off req.body on eighteen delete routes, none of which
 * validate it. Rejecting a bad value would make a delete fail over a label, so
 * instead anything of the wrong type is dropped (the server-side fallback is
 * used) and text is cut to a sane length.
 */
export const cleanRecycleMeta = (raw: unknown): { type?: string; title?: string; subtitle?: string; amount?: number } => {
    if (!raw || typeof raw !== "object") return {};
    const m = raw as Record<string, unknown>;
    const text = (value: unknown) =>
        typeof value === "string" && value.trim() !== "" ? value.slice(0, META_TEXT_MAX) : undefined;
    return {
        type: text(m.type),
        title: text(m.title),
        subtitle: text(m.subtitle),
        amount: typeof m.amount === "number" && Number.isFinite(m.amount) ? m.amount : undefined,
    };
};
