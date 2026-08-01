import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Guardian with", deployer.address);

  const Guardian = await ethers.getContractFactory("Guardian");
  const guardian = await Guardian.deploy(1000, 5000, 3600, 3);
  await guardian.waitForDeployment();

  const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
  const registry = await PolicyRegistry.deploy();
  await registry.waitForDeployment();

  const policyHash = ethers.keccak256(
    ethers.toUtf8Bytes("aegis-policy-v1:perTx=1000,daily=5000,velocity=3/3600s"),
  );
  await (await registry.sealPolicy(policyHash, "ipfs://aegis-policy-v1")).wait();
  await (await guardian.setPolicyHash(policyHash)).wait();

  console.log("Guardian:", await guardian.getAddress());
  console.log("PolicyRegistry:", await registry.getAddress());
  console.log("Sealed policy hash:", policyHash);
  console.log("On-chain guardian paused:", await guardian.paused());
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
