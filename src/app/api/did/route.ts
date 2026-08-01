import type { NextRequest } from "next/server";
import { authenticate, authorize, error, json } from "@/core/api";
import { getDidDoc, listDidDocs, registerDidDoc } from "@/core/store";
import { didDocument, registerDID } from "@/core/did";

export const runtime = "nodejs";

/**
 * DID registry (D2): register, resolve and list agent DID documents. The
 * durable copy lives in the store; verification logic lives in did.ts.
 */
export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const did = req.nextUrl.searchParams.get("did");
  if (did) {
    const doc = await getDidDoc(did);
    if (!doc) return error("DID not found", 404);
    return json({ did, doc });
  }
  return json({ dids: await listDidDocs() });
}

export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorize(claims, "owner");
  if (!authz.ok) return error(authz.reason!, 401);

  const body = (await req.json().catch(() => null)) as
    | { walletId?: string; publicKey?: string; orgId?: string }
    | null;
  if (!body?.walletId || !body?.publicKey) {
    return error("walletId (string) and publicKey (string) required", 400);
  }
  const doc = didDocument(body.walletId, body.publicKey, body.orgId);
  registerDID(doc);
  await registerDidDoc(doc.id, doc);
  return json({ did: doc.id, doc }, 201);
}
