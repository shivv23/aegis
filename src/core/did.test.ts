import { describe, expect, it } from "vitest";
import {
  didDocument,
  didForWallet,
  registerDID,
  resolveDID,
  rotateDIDKey,
  verifyDIDProof,
} from "./did";
import { generateAgentKeyPair, signAgentMessage } from "./signing";

const DID_CONTEXT = "https://www.w3.org/ns/did/v1";

describe("DID document shape", () => {
  it("builds a did:key-style document with the expected id and fields", () => {
    const kp = generateAgentKeyPair();
    const doc = didDocument("w-shape", kp.publicKey, "orgA");

    expect(doc["@context"]).toContain(DID_CONTEXT);
    expect(doc.id).toBe("did:aegis:w-shape");
    expect(doc.walletId).toBe("w-shape");
    expect(doc.version).toBe(1);
    expect(doc.controller).toEqual([doc.id]);

    expect(doc.verificationMethod).toHaveLength(1);
    const method = doc.verificationMethod[0];
    expect(method.type).toBe("Ed25519VerificationKey2020");
    expect(method.id).toBe("did:aegis:w-shape#key");
    expect(method.controller).toBe(doc.id);
    expect(method.publicKeyBase64).toBe(kp.publicKey);
    expect(method.publicKeyMultibase.startsWith("z")).toBe(true);

    expect(doc.authentication).toContain(method.id);
    expect(doc.alsoKnownAs).toEqual(["did:org:orgA"]);
    expect(doc.created).toBeGreaterThan(0);
    expect(doc.updated).toBe(doc.created);
  });

  it("omits alsoKnownAs for wallets without an org", () => {
    const kp = generateAgentKeyPair();
    const doc = didDocument("w-shape2", kp.publicKey);
    expect(doc.alsoKnownAs).toEqual([]);
  });
});

describe("DID registry", () => {
  it("registers and resolves round-trip, and indexes by wallet", () => {
    const kp = generateAgentKeyPair();
    const doc = didDocument("w-roundtrip", kp.publicKey, "orgB");
    registerDID(doc);

    expect(resolveDID(doc.id)).toEqual(doc);
    expect(didForWallet("w-roundtrip")).toBe(doc.id);
  });

  it("returns null for unknown DIDs and does not choke on them", () => {
    expect(resolveDID("did:aegis:missing")).toBeNull();
    expect(didForWallet("missing")).toBeNull();
    expect(verifyDIDProof("did:aegis:missing", "msg", "sig")).toBe(false);
    expect(rotateDIDKey("did:aegis:missing", "key")).toBe(false);
  });
});

describe("DID proof verification", () => {
  it("verifies a real Ed25519 signature and rejects tampering or wrong keys", () => {
    const kp = generateAgentKeyPair();
    const other = generateAgentKeyPair();
    const doc = didDocument("w-verify", kp.publicKey);
    registerDID(doc);

    const message = "aegis did proof v1|w-verify|123";
    const signature = signAgentMessage(kp.privateKey, message);

    expect(verifyDIDProof(doc.id, message, signature)).toBe(true);
    expect(verifyDIDProof(doc.id, message + "tampered", signature)).toBe(false);
    const forged = signAgentMessage(other.privateKey, message);
    expect(verifyDIDProof(doc.id, message, forged)).toBe(false);
  });
});

describe("DID key rotation", () => {
  it("bumps the version, swaps the key, and revokes old signatures", () => {
    const kp1 = generateAgentKeyPair();
    const kp2 = generateAgentKeyPair();
    const doc = didDocument("w-rotate", kp1.publicKey);
    registerDID(doc);

    const message = "rotation check";
    const oldSignature = signAgentMessage(kp1.privateKey, message);
    expect(verifyDIDProof(doc.id, message, oldSignature)).toBe(true);

    expect(rotateDIDKey(doc.id, kp2.publicKey)).toBe(true);

    const resolved = resolveDID(doc.id);
    expect(resolved!.version).toBe(2);
    expect(resolved!.verificationMethod[0].publicKeyBase64).toBe(kp2.publicKey);
    expect(resolved!.verificationMethod[0].id).toBe("did:aegis:w-rotate#key");
    expect(resolved!.updated).toBeGreaterThanOrEqual(resolved!.created);

    expect(verifyDIDProof(doc.id, message, oldSignature)).toBe(false);
    const newSignature = signAgentMessage(kp2.privateKey, message);
    expect(verifyDIDProof(doc.id, message, newSignature)).toBe(true);
  });
});
