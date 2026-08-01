import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Guardian, PolicyRegistry } from "../typechain-types";

describe("Guardian", function () {
  let g: Guardian;
  let payee: HardhatEthersSigner, stranger: HardhatEthersSigner;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    payee = signers[1];
    stranger = signers[2];
    const factory = await ethers.getContractFactory("Guardian");
    g = await factory.deploy(1000, 5000, 3600, 3);
    await g.addAllowlist(payee.address);
  });

  it("approves an allowlisted payee within limits", async function () {
    await expect(g.execute(payee.address, 500, "gpu burst"))
      .to.emit(g, "TransferApproved")
      .withArgs(payee.address, 500, "gpu burst", (t: number) => t > 0);
  });

  it("blocks a payee that is not allowlisted", async function () {
    await expect(g.execute(stranger.address, 100, "random")).to.be.revertedWith(
      "Guardian: payee not allowlisted",
    );
  });

  it("blocks a transfer over the per-tx cap", async function () {
    await expect(g.execute(payee.address, 1001, "big")).to.be.revertedWith(
      "Guardian: over per-tx cap",
    );
  });

  it("blocks the balance that would breach the daily limit", async function () {
    await g.setLimits(5000, 6000, 3600, 10);
    await g.execute(payee.address, 4000, "a");
    await g.execute(payee.address, 500, "b");
    await expect(g.execute(payee.address, 1501, "c")).to.be.revertedWith(
      "Guardian: daily limit exceeded",
    );
  });

  it("enforces the rolling velocity limit", async function () {
    await g.execute(payee.address, 100, "a");
    await g.execute(payee.address, 100, "b");
    await g.execute(payee.address, 100, "c");
    await expect(g.execute(payee.address, 100, "d")).to.be.revertedWith(
      "Guardian: velocity limit exceeded",
    );
  });

  it("lets the owner relax limits (timelocked off-chain)", async function () {
    await g.setLimits(10, 20, 3600, 3);
    await expect(g.execute(payee.address, 11, "x")).to.be.revertedWith("Guardian: over per-tx cap");
    await g.setLimits(1000, 5000, 3600, 3);
    await expect(g.execute(payee.address, 11, "x")).to.emit(g, "TransferApproved");
  });

  it("freezes permanently once revoke() is called", async function () {
    await g.revoke();
    await expect(g.execute(payee.address, 100, "x")).to.be.revertedWith("Guardian: paused");
    await expect(g.execute(payee.address, 100, "x")).to.be.revertedWith("Guardian: paused");
  });

  it("seals the policy hash so the registry and guardian agree", async function () {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("policy-v1"));
    await expect(g.setPolicyHash(hash)).to.emit(g, "PolicySealed").withArgs(hash);
    expect(await g.policyHash()).to.equal(hash);
  });
});

describe("PolicyRegistry", function () {
  it("seals a policy hash and only the owner can seal", async function () {
    const signers = await ethers.getSigners();
    const [owner, other] = signers;
    const factory = await ethers.getContractFactory("PolicyRegistry");
    const reg: PolicyRegistry = await factory.deploy();

    const hash = ethers.keccak256(ethers.toUtf8Bytes("policy-v1"));
    await expect(reg.sealPolicy(hash, "ipfs://aegis-policy-v1"))
      .to.emit(reg, "PolicySealed")
      .withArgs(hash, "ipfs://aegis-policy-v1", (b: number) => b > 0, (t: number) => t > 0);
    expect(await reg.latestHash()).to.equal(hash);
    expect(await reg.sealedBlock()).to.be.greaterThan(0);

    await expect(reg.connect(other).sealPolicy(hash, "x")).to.be.revertedWith(
      "PolicyRegistry: not owner",
    );
  });

  it("reflects the sealed policy into the Guardian contract", async function () {
    await ethers.getSigners();
    const regFactory = await ethers.getContractFactory("PolicyRegistry");
    const reg: PolicyRegistry = await regFactory.deploy();
    const gFactory = await ethers.getContractFactory("Guardian");
    const g: Guardian = await gFactory.deploy(1000, 5000, 3600, 3);

    const hash = ethers.keccak256(ethers.toUtf8Bytes("policy-v2"));
    await reg.sealPolicy(hash, "ipfs://aegis-policy-v2");
    await g.setPolicyHash(hash);

    const [sealedHash] = await reg.latest();
    expect(sealedHash).to.equal(hash);
    expect(await g.policyHash()).to.equal(sealedHash);
  });
});
