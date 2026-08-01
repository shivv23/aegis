/**
 * Lightweight on-chain mirror reader — no ethers dependency.
 *
 * Reads the deployed Guardian + PolicyRegistry state over a raw JSON-RPC
 * eth_call, so the app can *prove* the active policy hash is sealed on-chain
 * (Sepolia by default). Falls back gracefully when the chain is unreachable.
 */

const SELECTORS = {
  paused: "0x5c975abb",
  policyHash: "0x098fb624",
  perTxCap: "0xad82cbea",
  dailyLimit: "0x67eeba0c",
  velocityMax: "0xf42c9cba",
  latestHash: "0x6f17d258",
} as const;

export interface OnChainMirror {
  chain: string;
  rpcUrl: string | null;
  guardian: { address: string | null; paused: boolean | null; perTxCap: string | null; dailyLimit: string | null; velocityMax: string | null };
  registry: { address: string | null; sealedHash: string | null };
  matches: boolean | null;
  error?: string;
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{ to, data }, "latest"],
      id: 1,
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result ?? "0x";
}

export function decodeBytes32(hex: string): string {
  return "0x" + (hex.length >= 66 ? hex.slice(2, 66) : hex.padStart(66, "0"));
}

export function decodeUint(hex: string): string {
  const word = hex.length >= 66 ? hex.slice(2, 66) : hex.slice(2).padStart(64, "0");
  return BigInt("0x" + word).toString();
}

export function decodeBool(hex: string): boolean {
  return hex.length >= 66 && hex.endsWith("01");
}

export async function readOnChainMirror(): Promise<OnChainMirror> {
  let readFailed = false;

  async function readWord(rpcUrl: string, to: string, selector: string): Promise<string> {
    try {
      return await ethCall(rpcUrl, to, selector);
    } catch {
      readFailed = true;
      return "0x";
    }
  }

  const rpcUrl = process.env.AEGIS_RPC_URL ?? null;
  const guardianAddr = process.env.AEGIS_GUARDIAN_ADDRESS ?? null;
  const registryAddr = process.env.AEGIS_POLICY_REGISTRY ?? null;
  const chain = process.env.AEGIS_CHAIN_NAME ?? "hardhat (local)";

  const mirror: OnChainMirror = {
    chain,
    rpcUrl,
    guardian: { address: guardianAddr, paused: null, perTxCap: null, dailyLimit: null, velocityMax: null },
    registry: { address: registryAddr, sealedHash: null },
    matches: null,
  };

  if (!rpcUrl) return mirror;

  try {
    if (guardianAddr) {
      mirror.guardian.paused = decodeBool(await readWord(rpcUrl, guardianAddr, SELECTORS.paused));
      mirror.guardian.perTxCap = decodeUint(await readWord(rpcUrl, guardianAddr, SELECTORS.perTxCap));
      mirror.guardian.dailyLimit = decodeUint(await readWord(rpcUrl, guardianAddr, SELECTORS.dailyLimit));
      mirror.guardian.velocityMax = decodeUint(await readWord(rpcUrl, guardianAddr, SELECTORS.velocityMax));
    }
    if (registryAddr) {
      mirror.registry.sealedHash = decodeBytes32(await readWord(rpcUrl, registryAddr, SELECTORS.latestHash));
    }
    if (guardianAddr) {
      const onChainPolicy = decodeBytes32(await readWord(rpcUrl, guardianAddr, SELECTORS.policyHash));
      if (mirror.registry.sealedHash && onChainPolicy !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        mirror.matches = mirror.registry.sealedHash.toLowerCase() === onChainPolicy.toLowerCase();
      }
    }
  } catch (e) {
    mirror.error = (e as Error).message;
  }
  if (!mirror.error && readFailed) {
    mirror.error = "on-chain read failed: RPC unreachable or contract address invalid";
  }
  return mirror;
}
