import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorize, error, json } from "@/core/api";
import { addSigner, listSigners } from "@/core/store";
import { signKey } from "@/core/keys";
import type { SignerRole } from "@/core/types";

export const runtime = "nodejs";

const addSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.enum(["admin", "ops", "treasury"]),
});

/**
 * GET /api/signers — list the registered multi-sig signers.
 * POST /api/signers — master key only; create a signer and return its
 * owner-scoped key exactly once (the caller distributes it to the signer).
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  return json({ signers: await listSigners() });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);
  if (claims!.walletId !== "*") return error("Only the master key can register signers", 403);

  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid signer payload", 400);

  const signer = await addSigner(parsed.data.name, parsed.data.role as SignerRole);
  return json(
    {
      signer: { id: signer.id, name: signer.name, role: signer.role, enabled: signer.enabled },
      key: await signKey("*", "owner", signer.id),
      warning: "Hand this key to the signer. It is shown only once.",
    },
    201,
  );
}
