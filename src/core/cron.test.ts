import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as runCron } from "@/app/api/cron/jobs/route";
import { addAudit, createWallet, getStore, recordAnomaly, releaseExpiredBreakerFreezes, setWalletStatus } from "@/core/store";
import type { WalletPolicy } from "@/core/types";

const baseWalletPolicy: WalletPolicy = {
  maxPerTx: 200,
  dailyLimit: 2000,
  monthlyLimit: 20000,
  velocityLimitPerMin: 20,
  allowlist: [],
};

let seq = 0;

beforeAll(async () => {
  await getStore().ready;
});

afterEach(async () => {
  const s = getStore();
  await s.ready;
  await s.client.execute("DELETE FROM transactions WHERE wallet_id LIKE 'wallet-cron-%'");
  await s.client.execute("DELETE FROM wallets WHERE id LIKE 'wallet-cron-%'");
});

describe("cron breaker reset (C6)", () => {
  it("auto-releases a breaker freeze once the anomaly window elapses", async () => {
    const wallet = await createWallet({ id: `wallet-cron-${++seq}`, name: "Cron Bot", ownerDid: "did:org:cron", balance: 1000, policy: baseWalletPolicy });

    for (let i = 0; i < 5; i++) {
      await recordAnomaly(wallet.id, "TX_BLOCKED", `test block ${i}`);
    }
    expect((await getStore()).client).toBeDefined();
    const { rows } = await getStore().client.execute("SELECT status FROM wallets WHERE id = ?", [wallet.id]);
    expect(rows[0].status).toBe("FROZEN");

    const s = getStore();
    s.anomalies.set(wallet.id, [Date.now() - 120_000]);

    const released = await releaseExpiredBreakerFreezes(Date.now());
    expect(released).toContain(wallet.id);
    const after = await getStore().client.execute("SELECT status FROM wallets WHERE id = ?", [wallet.id]);
    expect(after.rows[0].status).toBe("ACTIVE");
  });

  it("never auto-releases an owner kill-switch freeze", async () => {
    const wallet = await createWallet({ id: `wallet-cron-${++seq}`, name: "Manual Bot", ownerDid: "did:org:cron", balance: 1000, policy: baseWalletPolicy });
    await setWalletStatus(wallet.id, "FROZEN");
    await addAudit({ walletId: wallet.id, actor: "owner", action: "WALLET_FROZEN", details: "Kill switch" });

    const s = getStore();
    s.anomalies.set(wallet.id, []);

    const released = await releaseExpiredBreakerFreezes(Date.now());
    expect(released).not.toContain(wallet.id);
    const after = await getStore().client.execute("SELECT status FROM wallets WHERE id = ?", [wallet.id]);
    expect(after.rows[0].status).toBe("FROZEN");
  });
});

describe("cron endpoint auth (C6)", () => {
  it("rejects requests without the vercel-cron header", async () => {
    const res = await runCron(new NextRequest("http://x/api/cron/jobs"));
    expect(res.status).toBe(401);
  });

  it("runs the job suite when invoked by the scheduler", async () => {
    const res = await runCron(new NextRequest("http://x/api/cron/jobs", { headers: { "x-vercel-cron": "1" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("settled");
    expect(body).toHaveProperty("expired");
    expect(body).toHaveProperty("released");
    expect(body.ledgerIntact).toBe(true);
  });
});
