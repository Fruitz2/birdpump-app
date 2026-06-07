import { route } from "@/lib/http/middleware";
import { ok } from "@/lib/http/response";
import { listAvatars } from "@/lib/profile/avatars";

export const runtime = "nodejs";

export const GET = route({}, async () => {
  return ok({ avatars: listAvatars() });
});
