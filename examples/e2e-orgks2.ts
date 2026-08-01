import { Aegis } from "../src/lib/sdk";

const BASE = process.env.AEGIS_BASE_URL ?? "http://localhost:3000";
const OWNER_KEY = process.env.AEGIS_OWNER_KEY ?? "";

function show(label: string, r: { status: number; body: unknown }) {
  const b = r.body as Record<string, unknown>;
  const tx = (b.transaction as Record<string, unknown>) ?? {};
  const d = [b.status, b.error, b.reason && `reason=${b.reason}`, tx.id && `tx=${String(tx.id).slice(0, 8)}`].filter(Boolean).join("  ");
  console.log(`  ${label.padEnd(40)} [HTTP ${r.status}] ${d}`);
}

async function main() {
  const owner = new Aegis({ baseUrl: BASE, apiKey: OWNER_KEY });
  const w = await owner.createWallet({ name: "e2e-orgks2", ownerDid: "did:org:acme", balance: 500, policy: { maxPerTx: 100, dailyLimit: 1000, monthlyLimit: 5000, velocityLimitPerMin: 30, allowlist: ["compute:0xCAFE0001"] } });
  const walletId = (w.body.wallet as { id: string }).id;
  console.log(`\n  wallet ${walletId} [HTTP ${w.status}] orgId=${(w.body.wallet as { orgId?: string }).orgId ?? "(missing)"}`);

  const minted = await owner.mintAgentKey(walletId, "e2e-orgks2");
  const agent = new Aegis({ baseUrl: BASE, walletId, privateKey: (minted.body as { privateKey: string }).privateKey });

  console.log("  --- baseline ---");
  show("tx (30, in-policy)", await agent.transfer({ to: "compute:0xCAFE0001", amount: 30, purpose: "baseline" }));

  const orgs = await owner.listOrgs();
  const orgId = (orgs.body.orgs as Array<{ id: string }>)[0].id;
  const ks = await fetch(`${BASE}/api/orgs/${orgId}/kill-switch`, {
    method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, reason: "e2e org freeze" }),
  });
  console.log(`\n  org kill-switch ENABLED on ${orgId} [HTTP ${ks.status}]`);

  console.log("  --- org kill-switch active -> transfers must be BLOCKED ---");
  show("tx (30, org frozen)", await agent.transfer({ to: "compute:0xCAFE0001", amount: 30, purpose: "frozen" }));
  show("tx (5, org frozen)", await agent.transfer({ to: "compute:0xCAFE0001", amount: 5, purpose: "frozen again" }));

  const ksOff = await fetch(`${BASE}/api/orgs/${orgId}/kill-switch`, {
    method: "POST", headers: { Authorization: `Bearer ${OWNER_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false, reason: "" }),
  });
  console.log(`\n  org kill-switch DISABLED [HTTP ${ksOff.status}]`);
  show("tx (30, unfrozen)", await agent.transfer({ to: "compute:0xCAFE0001", amount: 30, purpose: "recovered" }));
  console.log();
}

void main().catch((e) => { console.error("e2e failed:", e instanceof Error ? e.message : e); process.exit(1); });
