import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readOnChainMirror, decodeBytes32, decodeUint, decodeBool } from "./chain";

const HASH =
  "0x892c1ba54e6f5d9d2b8d0f8a5a4c9f1a0b3d5e7f2a4c6e8f0a1b3c5d7e9f0a1b";

const freshEnv = () => {
  const prev = { ...process.env };
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  };
};

describe("chain decoders", () => {
  it("decodes a bytes32 word", () => {
    const hex = "0x" + HASH.slice(2);
    expect(decodeBytes32(hex)).toBe(HASH);
  });

  it("decodes a uint256 word", () => {
    expect(decodeUint("0x" + "00000000000000000000000000000000000000000000000000000000000003e8")).toBe("1000");
  });

  it("decodes a bool word", () => {
    expect(decodeBool("0x" + "0000000000000000000000000000000000000000000000000000000000000000" + "01")).toBe(true);
    expect(decodeBool("0x" + "0000000000000000000000000000000000000000000000000000000000000000" + "00")).toBe(false);
  });
});

describe("readOnChainMirror", () => {
  const restore = freshEnv();
  let fetches: { to: string; data: string }[] = [];
  const word = (v: string) => "0x" + v.padStart(64, "0");

  beforeEach(() => {
    fetches = [];
    process.env.AEGIS_RPC_URL = "https://rpc.example.com";
    process.env.AEGIS_GUARDIAN_ADDRESS = "0xGuardian00000000000000000000000000000001";
    process.env.AEGIS_POLICY_REGISTRY = "0xRegistry00000000000000000000000000000001";
    process.env.AEGIS_CHAIN_NAME = "sepolia";
    global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const { to, data } = body.params[0];
      fetches.push({ to, data });
      const result =
        data === "0x5c975abb" ? word("01") : // paused -> true
        data === "0xad82cbea" ? word("03e8") : // perTxCap -> 1000
        data === "0x67eeba0c" ? word("1388") : // dailyLimit -> 5000
        data === "0xf42c9cba" ? word("03") : // velocityMax -> 3
        data === "0x6f17d258" ? HASH :
        data === "0x098fb624" ? HASH :
        word("00");
      return new Response(JSON.stringify({ jsonrpc: "2.0", result, id: 1 }), { status: 200 });
    });
  });

  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it("reads live guardian + registry state and confirms the seal matches", async () => {
    const mirror = await readOnChainMirror();
    expect(mirror.chain).toBe("sepolia");
    expect(mirror.guardian.paused).toBe(true);
    expect(mirror.guardian.perTxCap).toBe("1000");
    expect(mirror.guardian.dailyLimit).toBe("5000");
    expect(mirror.guardian.velocityMax).toBe("3");
    expect(mirror.registry.sealedHash).toBe(HASH);
    expect(mirror.matches).toBe(true);
    expect(mirror.error).toBeUndefined();
  });

  it("reports mismatch when the Guardian policy hash differs from the sealed hash", async () => {
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const { data } = body.params[0];
      const result = data === "0x098fb624" ? HASH.slice(0, 10) + "0".repeat(54) : "0x" + "00".repeat(32);
      return new Response(JSON.stringify({ jsonrpc: "2.0", result, id: 1 }), { status: 200 });
    });
    const mirror = await readOnChainMirror();
    expect(mirror.matches).toBe(false);
  });

  it("returns nulls (no error) when no RPC is configured", async () => {
    delete process.env.AEGIS_RPC_URL;
    delete process.env.AEGIS_GUARDIAN_ADDRESS;
    delete process.env.AEGIS_POLICY_REGISTRY;
    const mirror = await readOnChainMirror();
    expect(mirror.rpcUrl).toBeNull();
    expect(mirror.guardian.address).toBeNull();
    expect(mirror.matches).toBeNull();
  });

  it("swallows RPC failures into an error field", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const mirror = await readOnChainMirror();
    expect(mirror.error).toBeTruthy();
  });
});
