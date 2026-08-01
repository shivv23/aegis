import { Aegis } from "../src/lib/sdk";

const BASE = process.env.AEGIS_BASE ?? "https://aegis-shivv23s-projects.vercel.app";
const WALLET = process.env.AEGIS_WALLET ?? "wallet-tradingbot-42";

async function main() {
  const bs = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const ownerKey = bs.ownerKey;
  const mintRes = await fetch(`${BASE}/api/keys/mint`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ walletId: WALLET, label: "e3-demo" }),
  });
  const mint = await mintRes.json();
  if (!mint.privateKey) {
    console.error("mint failed:", JSON.stringify(mint));
    process.exit(1);
  }
  const aegis = new Aegis({ baseUrl: BASE, walletId: WALLET, privateKey: mint.privateKey });
  const targets = ["compute:0xCAFE0001", "api:0xBEEF0002", "storage:0xDEAD0003"];
  for (let i = 1; i <= 5; i++) {
    const r = await aegis.transfer({ to: targets[i % 3], amount: 20 + i * 7, purpose: "market-data" });
    const tx = r.body as { tx?: { id: string; status: string; amount: number } };
    console.log(`tx ${i}: http=${r.status} id=${tx.tx?.id ?? "?"} status=${tx.tx?.status ?? JSON.stringify(r.body)} amount=${tx.tx?.amount ?? "?"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
