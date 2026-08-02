import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, authorizeRead, error, json } from "@/core/api";
import { listAudit, listTransactions, ledgerHeadHash } from "@/core/store";
import { auditLogCsv, auditPackCsv, sarLiteReport } from "@/core/export";
import {
  canonicalPack,
  exportPublicKeyPem,
  packSha256,
  signExportPack,
  verifyExportPack,
} from "@/core/export-proof";

export const runtime = "nodejs";

const verifySchema = z.object({
  pack: z.string().min(1),
  signature: z.string().min(1),
});

export async function GET(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  const kind = req.nextUrl.searchParams.get("kind") ?? "report";
  const txs = await listTransactions();

  if (kind === "audit.csv") {
    return new Response(auditPackCsv(txs), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="aegis-audit.csv"',
      },
    });
  }
  if (kind === "auditlog.csv") {
    const log = await listAudit();
    return new Response(auditLogCsv(log), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="aegis-audit-log.csv"',
      },
    });
  }
  if (kind === "audit.json" || kind === "audit.proof") {
    const auditLog = await listAudit();
    const pack = canonicalPack({
      generatedAt: new Date().toISOString(),
      ledgerHeadHash: await ledgerHeadHash(),
      transactions: txs,
      audit: auditLog,
    });
    const proof = {
      algorithm: "ECDSA-P256-SHA256",
      packSha256: packSha256(pack),
      signature: signExportPack(pack),
      signedAt: new Date().toISOString(),
      ledgerHeadHash: await ledgerHeadHash(),
      publicKeyPem: exportPublicKeyPem(),
    };
    if (kind === "audit.proof") return json({ proof });
    return json({ ...JSON.parse(pack), proof });
  }

  return json(sarLiteReport(txs));
}

/**
 * POST /api/export/verify — verify an export pack offline-style, on the
 * server, with the same public key a regulator would use in a shell.
 */
export async function POST(req: NextRequest) {
  const claims = await authenticate(req);
  const authz = authorizeRead(claims);
  if (!authz.ok) return error(authz.reason!, 401);

  const parsed = verifySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("Invalid pack/signature payload", 400);

  const valid = verifyExportPack(parsed.data.pack, parsed.data.signature);
  return json({
    verified: valid,
    packSha256: packSha256(parsed.data.pack),
    publicKeyPem: exportPublicKeyPem(),
    verifyHint:
      'openssl dgst -sha256 -verify pubkey.pem -signature sig.bin pack.json  # 0 = genuine',
  });
}
