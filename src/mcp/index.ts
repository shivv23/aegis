/**
 * AEGIS MCP server — exposes AEGIS as Model Context Protocol tools for AI
 * agents (2025 spec, JSON-RPC 2.0 over stdio or HTTP via handleMessage).
 *
 * ```ts
 * import { createServer, startStdioServer } from "@/mcp";
 *
 * const server = createServer({
 *   baseUrl: "https://aegis.example.com",
 *   masterOwnerKey: process.env.AEGIS_MASTER_OWNER_KEY, // owner reads
 *   privateKey: process.env.AGENT_PRIVATE_KEY,          // signed transfers
 *   walletId: "wallet-tradingbot-42",
 * });
 *
 * const response = await server.handleMCPRequest({
 *   jsonrpc: "2.0", method: "tools/call", id: 1,
 *   params: { name: "balance", arguments: { walletId: "wallet-tradingbot-42" } },
 * });
 * ```
 */

import { Aegis } from "@/lib/sdk";
import type { AegisResponse, AegisTransferInput } from "@/lib/sdk";
import type { Counterparty, Transaction, Wallet } from "@/core/types";

export const SERVER_NAME = "aegis-mcp";
export const SERVER_VERSION = "0.1.0";
export const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** Minimal SDK surface the server drives. The real `Aegis` class satisfies it. */
export interface AegisSdkLike {
  transfer(input: AegisTransferInput): Promise<AegisResponse>;
  getWallet(walletId: string): Promise<AegisResponse>;
  listCounterparties(orgId?: string): Promise<AegisResponse>;
}

export interface McpServerOptions {
  baseUrl?: string;
  /** Owner-scoped JWT used for reads (balance, policy, counterparties). */
  masterOwnerKey?: string;
  /** Agent-scoped JWT used for transfers (legacy bearer mode). */
  agentKey?: string;
  /** Agent wallet identity, required with `privateKey`. */
  walletId?: string;
  /** Ed25519 PKCS8 DER base64url key — the signed-agent transfer path. */
  privateKey?: string;
  /** Injected backend (tests / custom transports); overrides credentials. */
  sdk?: AegisSdkLike;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServer {
  /** Dispatch a parsed JSON-RPC request object; notifications return undefined. */
  handleMCPRequest(request: unknown): Promise<unknown>;
  /** Parse a raw JSON line and return the JSON string response ("" for notifications). */
  handleMessage(rawJson: string): Promise<string>;
}

const TOOLS: McpTool[] = [
  {
    name: "transfer",
    description:
      "Create a signed AEGIS transfer from the agent's wallet. The guard evaluates the request; the result includes the transaction id and status, or the block reason.",
    inputSchema: {
      type: "object",
      properties: {
        walletId: { type: "string", description: "The agent's wallet to transfer from." },
        to: { type: "string", description: "Destination address or counterparty." },
        amount: { type: "number", description: "Amount to transfer (positive)." },
        purpose: { type: "string", description: "Optional purpose label for risk classification." },
        nonce: { type: "string", description: "Optional client nonce (the rail mints one if omitted)." },
      },
      required: ["walletId", "to", "amount"],
    },
  },
  {
    name: "balance",
    description: "Returns the wallet balance and status.",
    inputSchema: {
      type: "object",
      properties: { walletId: { type: "string", description: "The wallet to query." } },
      required: ["walletId"],
    },
  },
  {
    name: "policy.get",
    description: "Returns the effective wallet policy (per-tx, daily, monthly, velocity limits and the allowlist).",
    inputSchema: {
      type: "object",
      properties: { walletId: { type: "string", description: "The wallet whose policy to read." } },
      required: ["walletId"],
    },
  },
  {
    name: "counterparties.list",
    description: "Lists the counterparty registry (address, name, status, totalPaid, flags).",
    inputSchema: {
      type: "object",
      properties: { orgId: { type: "string", description: "Optional organization id to filter by." } },
    },
  },
];

interface Backend {
  transfer(input: AegisTransferInput): Promise<AegisResponse>;
  getWallet(walletId: string): Promise<AegisResponse>;
  listCounterparties(orgId?: string): Promise<AegisResponse>;
}

function resolveBackend(options: McpServerOptions): Backend {
  if (options.sdk) {
    const sdk = options.sdk;
    return {
      transfer: (input) => sdk.transfer(input),
      getWallet: (id) => sdk.getWallet(id),
      listCounterparties: (orgId) => sdk.listCounterparties(orgId),
    };
  }

  const { baseUrl } = options;
  const readSdk = options.masterOwnerKey
    ? new Aegis({ baseUrl, apiKey: options.masterOwnerKey })
    : undefined;
  const agentSdk =
    options.privateKey && options.walletId
      ? new Aegis({ baseUrl, walletId: options.walletId, privateKey: options.privateKey })
      : options.agentKey
        ? new Aegis({ baseUrl, apiKey: options.agentKey })
        : undefined;

  return {
    transfer(input) {
      if (!agentSdk) {
        throw new Error("missing agent credentials: provide agentKey or privateKey + walletId");
      }
      return agentSdk.transfer(input);
    },
    getWallet(walletId) {
      if (!readSdk) {
        throw new Error("missing owner credentials: provide masterOwnerKey");
      }
      return readSdk.getWallet(walletId);
    },
    async listCounterparties(orgId) {
      if (!readSdk) {
        throw new Error("missing owner credentials: provide masterOwnerKey");
      }
      const res = await readSdk.listCounterparties();
      if (!res.ok || !orgId) return res;
      const list = (res.body as { counterparties?: Counterparty[] }).counterparties ?? [];
      return { ...res, body: { counterparties: list.filter((cp) => cp.orgId === orgId) } };
    },
  };
}

export function createServer(options: McpServerOptions): McpServer {
  if (options.privateKey && !options.walletId) {
    throw new Error("AEGIS MCP: walletId is required when using privateKey");
  }
  const backend = resolveBackend(options);
  return {
    handleMCPRequest(request: unknown): Promise<unknown> {
      return dispatch(request, backend);
    },
    async handleMessage(rawJson: string): Promise<string> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        return JSON.stringify(rpcError(null, PARSE_ERROR, "Parse error"));
      }
      const response = await dispatch(parsed, backend);
      return response === undefined ? "" : JSON.stringify(response);
    },
  };
}

export function startStdioServer(options: McpServerOptions): void {
  const server = createServer(options);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        void server
          .handleMessage(line)
          .then((out) => {
            if (out) process.stdout.write(`${out}\n`);
          })
          .catch(() => undefined);
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

async function dispatch(request: unknown, backend: Backend): Promise<unknown> {
  try {
    return await route(request, backend);
  } catch (err) {
    return rpcError(null, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
  }
}

async function route(request: unknown, backend: Backend): Promise<unknown> {
  if (!isRecord(request) || request.jsonrpc !== "2.0") {
    return rpcError(null, INVALID_REQUEST, "Invalid Request");
  }
  const method = typeof request.method === "string" ? request.method : undefined;
  const id = isId(request.id) ? request.id : null;
  if (!method) {
    return rpcError(id, INVALID_REQUEST, "Invalid Request");
  }

  switch (method) {
    case "initialize": {
      const params = isRecord(request.params) ? request.params : {};
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            requested && PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
    }
    case "notifications/initialized":
      return id === null ? undefined : { jsonrpc: "2.0", id, result: {} };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const result = await callTool(name, params.arguments, backend);
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

async function callTool(name: string, rawArgs: unknown, backend: Backend): Promise<McpToolResult> {
  const args = isRecord(rawArgs) ? rawArgs : {};
  try {
    switch (name) {
      case "transfer":
        return await callTransfer(args, backend);
      case "balance":
        return await callBalance(args, backend);
      case "policy.get":
        return await callPolicyGet(args, backend);
      case "counterparties.list":
        return await callCounterpartiesList(args, backend);
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return toolError(err instanceof Error ? err.message : "Tool call failed");
  }
}

async function callTransfer(args: Record<string, unknown>, backend: Backend): Promise<McpToolResult> {
  const walletId = args.walletId;
  const to = args.to;
  const amount = args.amount;
  if (
    typeof walletId !== "string" ||
    walletId === "" ||
    typeof to !== "string" ||
    to === "" ||
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    return toolError("transfer requires walletId (string), to (string) and a positive amount (number)");
  }
  const input: AegisTransferInput = {
    to,
    amount,
    ...(typeof args.purpose === "string" && args.purpose ? { purpose: args.purpose } : {}),
  };
  const res = await backend.transfer(input);
  return toolOk(transferSummary(res));
}

async function callBalance(args: Record<string, unknown>, backend: Backend): Promise<McpToolResult> {
  const walletId = args.walletId;
  if (typeof walletId !== "string" || walletId === "") {
    return toolError("balance requires walletId (string)");
  }
  const res = await backend.getWallet(walletId);
  if (!res.ok) return toolError(`balance failed (${res.status}): ${bodyText(res)}`);
  const wallet = (res.body as { wallet?: Wallet }).wallet;
  if (!wallet) return toolError("balance failed: wallet missing from response");
  return toolOk({ walletId: wallet.id, balance: wallet.balance, status: wallet.status });
}

async function callPolicyGet(args: Record<string, unknown>, backend: Backend): Promise<McpToolResult> {
  const walletId = args.walletId;
  if (typeof walletId !== "string" || walletId === "") {
    return toolError("policy.get requires walletId (string)");
  }
  const res = await backend.getWallet(walletId);
  if (!res.ok) return toolError(`policy.get failed (${res.status}): ${bodyText(res)}`);
  const wallet = (res.body as { wallet?: Wallet }).wallet;
  if (!wallet) return toolError("policy.get failed: wallet missing from response");
  return toolOk({
    maxPerTx: wallet.policy.maxPerTx,
    dailyLimit: wallet.policy.dailyLimit,
    monthlyLimit: wallet.policy.monthlyLimit,
    velocityLimitPerMin: wallet.policy.velocityLimitPerMin,
    allowlist: wallet.policy.allowlist,
  });
}

async function callCounterpartiesList(
  args: Record<string, unknown>,
  backend: Backend,
): Promise<McpToolResult> {
  const orgId = typeof args.orgId === "string" && args.orgId ? args.orgId : undefined;
  const res = await backend.listCounterparties(orgId);
  if (!res.ok) return toolError(`counterparties.list failed (${res.status}): ${bodyText(res)}`);
  const list = (res.body as { counterparties?: Counterparty[] }).counterparties ?? [];
  return toolOk(
    list.map((cp) => ({
      address: cp.address,
      name: cp.name,
      status: cp.status,
      totalPaid: cp.totalPaid,
      flags: cp.flags,
    })),
  );
}

function transferSummary(res: AegisResponse): Record<string, unknown> {
  const body = res.body;
  const tx = (body as { transaction?: Transaction }).transaction;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      transactionStatus: body.status,
      reason: body.reason,
      details: body.details,
      error: body.error,
      transactionId: tx?.id,
    };
  }
  return {
    ok: true,
    status: res.status,
    transactionStatus: body.status,
    transactionId: tx?.id,
    score: body.score,
    message: body.message,
  };
}

function bodyText(res: AegisResponse): string {
  const body = res.body;
  if (typeof body.error === "string") return body.error;
  if (typeof body.reason === "string") return body.reason;
  return `HTTP ${res.status}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is number | string | null {
  return v === null || typeof v === "number" || typeof v === "string";
}

function rpcError(id: number | string | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolOk(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
