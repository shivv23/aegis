#!/usr/bin/env node
/**
 * AEGIS — the `aegis` CLI, a thin scaffold over the SDK.
 *
 *   npx tsx scripts/aegis.ts bootstrap
 *   npx tsx scripts/aegis.ts status
 *   npx tsx scripts/aegis.ts transfer --wallet <id> --to <addr> --amount <n> [--purpose <p>]
 *   npx tsx scripts/aegis.ts help
 *
 * Env: AEGIS_BASE_URL (default http://localhost:3000), AEGIS_OWNER_KEY (master
 * key from GET /api/bootstrap), optional AEGIS_AGENT_KEY to reuse an
 * already-minted agent private key instead of minting on demand.
 */
import { Aegis } from "../src/lib/sdk";

const BASE = process.env.AEGIS_BASE_URL ?? "http://localhost:3000";

const HELP = `
  aegis — agent wallet kill-switch CLI

  usage: npx tsx scripts/aegis.ts <command> [flags]

  bootstrap                 print the master owner key + seed wallet
  status                    rail health + ledger integrity (owner key)
  transfer                  send a signed transfer and print the verdict
      --wallet <id>         wallet the agent operates for
      --to <addr>           destination address
      --amount <n>          amount
      --purpose <p>         purpose string (default "agent-transfer")
  help                      this text

  env:  AEGIS_BASE_URL   (default http://localhost:3000)
        AEGIS_OWNER_KEY  master owner key (GET /api/bootstrap)
        AEGIS_AGENT_KEY  optional pre-minted agent private key
`;

function fail(msg: string): never {
  console.error(`aegis: ${msg}`);
  process.exit(1);
}

function requireOwner(): string {
  if (!process.env.AEGIS_OWNER_KEY) {
    fail("AEGIS_OWNER_KEY not set — run `aegis bootstrap` and export the key");
  }
  return process.env.AEGIS_OWNER_KEY;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function cmdBootstrap() {
  const { status, body } = await getJson("/api/bootstrap");
  const ownerKey = (body.ownerKey as string) ?? "";
  console.log(`\n  bootstrap          [GET /api/bootstrap -> HTTP ${status}]`);
  if (!ownerKey) fail("bootstrap returned no ownerKey (demo mode off?)");
  console.log(`  master owner key   ${ownerKey.slice(0, 24)}…`);
  console.log(`  seed wallet        ${String(body.seedWalletId)}`);
  console.log(`  seeded             ${String(body.seeded)}`);

  const owner = new Aegis({ baseUrl: BASE, apiKey: ownerKey });
  const w = await owner.listWallets();
  const wallets = (w.body.wallets as Array<{ id: string; name: string; balance: number; status: string }>) ?? [];
  console.log(`  wallets            ${wallets.length}`);
  for (const x of wallets) {
    console.log(`    - ${x.id}  ${x.name}  balance=${x.balance}  ${x.status}`);
  }
  console.log(`\n  export AEGIS_OWNER_KEY="${ownerKey}"\n`);
}

async function cmdStatus() {
  const owner = new Aegis({ baseUrl: BASE, apiKey: requireOwner() });
  const [h, l] = await Promise.all([owner.health(), owner.verifyLedger()]);
  console.log(`\n  rail/health   -> HTTP ${h.status}  ${JSON.stringify(h.body)}`);
  console.log(`  ledger/verify -> HTTP ${l.status}  ${JSON.stringify(l.body)}`);
  console.log();
}

async function cmdTransfer(args: string[]) {
  const wallet = flag(args, "wallet");
  const to = flag(args, "to");
  const amount = Number(flag(args, "amount"));
  const purpose = flag(args, "purpose") ?? "agent-transfer";
  if (!wallet || !to || !Number.isFinite(amount)) {
    console.log(HELP);
    fail("transfer requires --wallet, --to and --amount");
  }

  let agent: Aegis;
  if (process.env.AEGIS_AGENT_KEY) {
    agent = new Aegis({ baseUrl: BASE, walletId: wallet, privateKey: process.env.AEGIS_AGENT_KEY });
  } else {
    const owner = new Aegis({ baseUrl: BASE, apiKey: requireOwner() });
    const minted = await owner.mintAgentKey(wallet, "cli");
    if (minted.status !== 201) {
      fail(`mint agent key failed: HTTP ${minted.status} ${JSON.stringify(minted.body)}`);
    }
    agent = new Aegis({
      baseUrl: BASE,
      walletId: wallet,
      privateKey: (minted.body as { privateKey: string }).privateKey,
    });
  }

  const r = await agent.transfer({ to, amount, purpose });
  const body = r.body as Record<string, unknown>;
  const tx = body.transaction as Record<string, unknown> | undefined;
  console.log(`\n  transfer ${amount} ${to} (purpose: ${purpose})`);
  console.log(`  verdict    ${String(body.status ?? body.error ?? "")}  [HTTP ${r.status}]`);
  if (body.reason) console.log(`  reason     ${String(body.reason)}`);
  if (body.details) console.log(`  details    ${String(body.details)}`);
  if (tx?.id) console.log(`  tx         ${String(tx.id)}`);
  console.log();
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "help";
  switch (cmd) {
    case "bootstrap":
      await cmdBootstrap();
      break;
    case "status":
      await cmdStatus();
      break;
    case "transfer":
      await cmdTransfer(args.slice(1));
      break;
    case "help":
      console.log(HELP);
      break;
    default:
      console.error(`aegis: unknown command '${cmd}'`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

void main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
