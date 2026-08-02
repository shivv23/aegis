import { ethers } from "hardhat";

const POLICY_URI = "ipfs://aegis-policy-v1";

/**
 * Re-seals the PolicyRegistry and the Guardian to a new policy hash — the
 * one-command fix when the app's live wallet policy changes and the on-chain
 * mirror reports `matches: false`.
 *
 * Usage (from contracts/, with a funded deployer key in the hardhat network
 * config, e.g. AEGIS_DEPLOYER_KEY):
 *
 *   AEGIS_POLICY_HASH=<bare-hex> npx hardhat run scripts/reseal.ts --network sepolia
 *
 * AEGIS_POLICY_REGISTRY / AEGIS_GUARDIAN_ADDRESS default to the values in
 * deployments/sepolia.json when present. AEGIS_POLICY_HASH is the bare sha256
 * hex (no 0x) returned by GET /api/guardian (policy.hash) or by the
 * /api/admin/reseal endpoint.
 */
async function main() {
  const hash = (process.env.AEGIS_POLICY_HASH ?? "").replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error("AEGIS_POLICY_HASH must be the 64-char sha256 hex of the wallet policy (no 0x)");
  }
  const policyHash = "0x" + hash;

  let registryAddr = process.env.AEGIS_POLICY_REGISTRY;
  let guardianAddr = process.env.AEGIS_GUARDIAN_ADDRESS;
  if (!registryAddr || !guardianAddr) {
    // Fall back to the last deployment record.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const rec = require("../deployments/sepolia.json");
      registryAddr = registryAddr ?? rec.registry;
      guardianAddr = guardianAddr ?? rec.guardian;
    } catch {
      /* no record — env vars required */
    }
  }
  if (!registryAddr || !guardianAddr) {
    throw new Error(
      "Set AEGIS_POLICY_REGISTRY and AEGIS_GUARDIAN_ADDRESS (or run deploy.ts first so deployments/sepolia.json exists)",
    );
  }

  const [signer] = await ethers.getSigners();
  console.log("Re-sealing policy", policyHash, "as", signer.address);

  const Registry = await ethers.getContractAt("PolicyRegistry", registryAddr);
  const Guardian = await ethers.getContractAt("Guardian", guardianAddr);

  const previous = await Registry.latestHash();
  console.log("Registry previous hash:", previous);
  if (previous.toLowerCase() === policyHash) {
    console.log("Registry already sealed to", policyHash, "— nothing to do.");
  } else {
    const sealTx = await Registry.sealPolicy(policyHash, POLICY_URI);
    await sealTx.wait();
    console.log("PolicyRegistry sealed → tx", sealTx.hash);
  }

  const guardianHash = await Guardian.policyHash();
  if (guardianHash.toLowerCase() === policyHash) {
    console.log("Guardian already enforcing", policyHash, "— nothing to do.");
  } else {
    const setTx = await Guardian.setPolicyHash(policyHash);
    await setTx.wait();
    console.log("Guardian.setPolicyHash → tx", setTx.hash);
  }

  console.log("Done. GET /api/guardian should now report matches: true.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
