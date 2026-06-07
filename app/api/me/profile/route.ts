import { z } from "zod";
import { eq } from "drizzle-orm";
import { route } from "@/lib/http/middleware";
import { ok, bad } from "@/lib/http/response";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { listAvatars } from "@/lib/profile/avatars";

const Body = z.object({
  displayName: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9_.-]+$/u, "letters, digits, underscore, dot, hyphen only")
    .optional(),
  avatarId: z.string().min(1).max(64).optional()
});

export const runtime = "nodejs";

export const PUT = route(
  {
    auth: true,
    rateLimit: { scope: "profile_put", limit: 20, windowSec: 60 }
  },
  async (req, ctx) => {
    const wallet = ctx.session!.sub;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return bad("invalid_body", parsed.error.message);

    const updates: Partial<{ displayName: string; avatarId: string }> = {};
    if (parsed.data.displayName !== undefined) {
      updates.displayName = parsed.data.displayName;
    }
    if (parsed.data.avatarId !== undefined) {
      const valid = listAvatars().some((a) => a.id === parsed.data.avatarId);
      if (!valid) return bad("invalid_avatar", "Avatar not in catalog");
      updates.avatarId = parsed.data.avatarId;
    }

    if (Object.keys(updates).length === 0) {
      return bad("no_changes", "Provide displayName and/or avatarId");
    }

    await db.update(users).set(updates).where(eq(users.wallet, wallet));

    const [row] = await db.select().from(users).where(eq(users.wallet, wallet)).limit(1);
    return ok({
      user: {
        wallet: row!.wallet,
        displayName: row!.displayName,
        avatarId: row!.avatarId
      }
    });
  }
);
