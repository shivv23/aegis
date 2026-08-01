import { beforeAll, describe, expect, it } from "vitest";
import {
  addSigner,
  approveApproval,
  ensureDefaultSigners,
  getApproval,
  listApprovals,
  listSigners,
  MULTISIG_REQUIRED,
  proposeApproval,
  rejectApproval,
  removeSigner,
} from "@/core/store";
import { SEED_WALLET_ID } from "@/core/seed";
import { getStore } from "@/core/store";

beforeAll(async () => {
  await getStore().ready;
});

describe("multi-sig signers", () => {
  it("seeds three default signers", async () => {
    const signers = await ensureDefaultSigners();
    expect(signers.length).toBe(3);
    expect(new Set(signers.map((s) => s.role))).toEqual(new Set(["admin", "ops", "treasury"]));
  });

  it("creates and removes a signer", async () => {
    const added = await addSigner("Audit Guard", "admin");
    expect(added.enabled).toBe(true);
    expect((await listSigners()).some((s) => s.id === added.id)).toBe(true);
    expect(await removeSigner(added.id)).toBe(true);
    expect(await removeSigner(added.id)).toBe(false);
  });
});

describe("2-of-3 owner key issuance", () => {
  it("does not mint until two distinct signers approve", async () => {
    const signers = await ensureDefaultSigners();
    const approval = await proposeApproval({
      operation: "MINT_OWNER_KEY",
      walletId: SEED_WALLET_ID,
      label: "ops-console",
      proposer: signers[0].id,
    });
    expect(approval.status).toBe("PENDING");
    expect(approval.required).toBe(2);

    const first = await approveApproval(approval.id, signers[0].id);
    expect(first.mintedKey).toBeUndefined();
    expect(first.approval.approvers).toHaveLength(1);

    const second = await approveApproval(approval.id, signers[1].id);
    expect(second.mintedKey).toBeDefined();
    expect(second.mintedKey!.split(".")).toHaveLength(3);
    expect(second.approval.status).toBe("APPROVED");
    expect(second.approval.keyMinted).toBe(true);
  });

  it("rejects duplicate approval from the same signer", async () => {
    const signers = await ensureDefaultSigners();
    const approval = await proposeApproval({
      operation: "MINT_OWNER_KEY",
      walletId: SEED_WALLET_ID,
      label: "dup-check",
      proposer: signers[0].id,
    });
    await approveApproval(approval.id, signers[0].id);
    await expect(approveApproval(approval.id, signers[0].id)).rejects.toThrow(
      "already approved",
    );
  });

  it("rejects approval by an unknown signer", async () => {
    const approval = await proposeApproval({
      operation: "MINT_OWNER_KEY",
      walletId: SEED_WALLET_ID,
      label: "impostor-check",
      proposer: "unknown",
    });
    await expect(approveApproval(approval.id, "not-a-signer")).rejects.toThrow(
      "Unknown or disabled signer",
    );
  });

  it("expires an unapproved request and refuses late approval", async () => {
    const signers = await ensureDefaultSigners();
    const approval = await proposeApproval({
      operation: "MINT_OWNER_KEY",
      walletId: SEED_WALLET_ID,
      label: "slow-approval",
      proposer: signers[0].id,
    });
    await getStore().client.execute(
      "UPDATE approvals SET expires_at = ? WHERE id = ?",
      [Date.now() - 1, approval.id],
    );
    await expect(approveApproval(approval.id, signers[1].id)).rejects.toThrow("expired");
    const stored = await getApproval(approval.id);
    expect(stored!.status).toBe("EXPIRED");
  });

  it("a single rejection cancels the request", async () => {
    const signers = await ensureDefaultSigners();
    const approval = await proposeApproval({
      operation: "MINT_OWNER_KEY",
      walletId: SEED_WALLET_ID,
      label: "veto-check",
      proposer: signers[0].id,
    });
    await rejectApproval(approval.id, signers[2].id);
    const stored = await getApproval(approval.id);
    expect(stored!.status).toBe("REJECTED");
  });

  it("requires the configured threshold", async () => {
    expect(MULTISIG_REQUIRED).toBe(2);
  });

  it("lists all approval requests", async () => {
    const signers = await ensureDefaultSigners();
    await proposeApproval({
      operation: "MINT_OWNER_KEY",
      walletId: SEED_WALLET_ID,
      label: "list-check",
      proposer: signers[0].id,
    });
    expect((await listApprovals()).length).toBeGreaterThan(0);
  });
});
