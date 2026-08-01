import { ethers } from "hardhat";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const POLICY_URI = "ipfs://aegis-policy-v1";

/**
 * Builds the exact WalletPolicy the app seeds for the demo wallet
 * (see src/core/seed.ts + src/core/store.ts runSeed) so the hash sealed
 * on-chain equals the hash the app computes via policyHash().
 */
function appPolicy(perTxCap: number, dailyLimit: number, velocityLimitPerMin: number) {
  return {
    maxPerTx: perTxCap,
    dailyLimit,
    monthlyLimit: 5000,
    velocityLimitPerMin,
    allowlist: ["compute:0xCAFE0001", "api:0xBEEF0002", "storage:0xDEAD0003"],
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const perTxCap = Number(process.env.AEGIS_POLICY_PER_TX ?? 100);
  const dailyLimit = Number(process.env.AEGIS_POLICY_DAILY ?? 1000);
  const velocityWindow = Number(process.env.AEGIS_POLICY_VELOCITY_WINDOW ?? 60);
  const velocityMax = Number(process.env.AEGIS_POLICY_VELOCITY_MAX ?? 30);
  const allowlist = (process.env.AEGIS_POLICY_ALLOWLIST ?? "").split(",").filter(Boolean);

  // Identical to src/core/store.ts policyHash(): sha256 hex of JSON.stringify(policy).
  const policyHash = ethers.sha256(
    ethers.toUtf8Bytes(JSON.stringify(appPolicy(perTxCap, dailyLimit, velocityMax))),
  );

  console.log("Deploying Guardian with", deployer.address, {
    perTxCap,
    dailyLimit,
    velocityWindow,
    velocityMax,
  });

  const Guardian = await ethers.getContractFactory("Guardian");
  const guardian = await Guardian.deploy(perTxCap, dailyLimit, velocityWindow, velocityMax);
  await guardian.waitForDeployment();

  const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
  const registry = await PolicyRegistry.deploy();
  await registry.waitForDeployment();

  for (const payee of allowlist) {
    await (await guardian.addAllowlist(payee)).wait();
  }
  await (await registry.sealPolicy(policyHash, POLICY_URI)).wait();
  await (await guardian.setPolicyHash(policyHash)).wait();

  const addresses = {
    network: process.env.AEGIS_CHAIN_NAME ?? "hardhat (local)",
    guardian: await guardian.getAddress(),
    registry: await registry.getAddress(),
    policyHash,
    deployedAt: new Date().toISOString(),
  };

  const dir = join(process.cwd(), "deployments");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sepolia.json"), JSON.stringify(addresses, null, 2));

  console.log("Guardian:", addresses.guardian);
  console.log("PolicyRegistry:", addresses.registry);
  console.log("Sealed policy hash:", policyHash);
  console.log("On-chain guardian paused:", await guardian.paused());
  console.log("");
  console.log("Artifact written to contracts/deployments/sepolia.json");
  console.log("");
  console.log("Set these env vars on Vercel to wire the live mirror:");
  console.log("  AEGIS_GUARDIAN_ADDRESS=" + addresses.guardian);
  console.log("  AEGIS_POLICY_REGISTRY=" + addresses.registry);
  console.log("  AEGIS_RPC_URL=" + (process.env.AEGIS_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"));
  console.log("  AEGIS_CHAIN_NAME=sepolia");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
