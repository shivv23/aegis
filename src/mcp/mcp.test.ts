/**
 * AEGIS MCP server — JSON-RPC handshake, tool registry and tool dispatch.
 */

import { describe, expect, it } from "vitest";
import { createServer } from "@/mcp";
import type { AegisSdkLike, McpToolResult } from "@/mcp";

function jsonrpc(method: string, params: unknown, id: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}), id };
}

interface FakeCall {
  method: string;
  args: unknown[];
}

function fakeSdk(): { sdk: AegisSdkLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const sdk: AegisSdkLike = {
    async transfer(input) {
      calls.push({ method: "transfer", args: [input] });
      return {
        ok: true,
        status: 201,
        body: { status: "PENDING", transaction: { id: "tx-1", status: "PENDING" } },
      };
    },
    async getWallet(walletId) {
      calls.push({ method: "getWallet", args: [walletId] });
      return {
        ok: true,
        status: 200,
        body: {
          wallet: {
            id: walletId,
            name: "TradingBot-42",
            ownerDid: "did:org:acme",
            status: "ACTIVE",
            balance: 500,
            createdAt: 0,
            policy: {
              maxPerTx: 100,
              dailyLimit: 1000,
              monthlyLimit: 5000,
              velocityLimitPerMin: 30,
              allowlist: ["compute:0xCAFE0001"],
            },
          },
        },
      };
    },
    async listCounterparties(orgId) {
      calls.push({ method: "listCounterparties", args: [orgId] });
      return {
        ok: true,
        status: 200,
        body: {
          counterparties: [
            {
              id: "cp-1",
              name: "ComputeGrid",
              address: "compute:0xCAFE0001",
              orgId: "org-1",
              status: "ACTIVE",
              flags: [],
              totalPaid: 250,
              totalTx: 3,
              createdAt: 0,
            },
          ],
        },
      };
    },
  };
  return { sdk, calls };
}

describe("AEGIS MCP server", () => {
  it("answers an initialize handshake with protocolVersion and serverInfo", async () => {
    const server = createServer({ sdk: fakeSdk().sdk });
    const res = (await server.handleMCPRequest(
      jsonrpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }, 1),
    )) as { result: Record<string, unknown> };
    expect(res.result.protocolVersion).toBe("2025-03-26");
    expect(res.result.serverInfo).toEqual(
      expect.objectContaining({ name: expect.any(String), version: expect.any(String) }),
    );
  });

  it("acknowledges the initialized notification without a response", async () => {
    const server = createServer({ sdk: fakeSdk().sdk });
    const out = await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(out).toBe("");
  });

  it("answers ping", async () => {
    const server = createServer({ sdk: fakeSdk().sdk });
    const res = await server.handleMCPRequest(jsonrpc("ping", {}, 7));
    expect(res).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("lists the 4 tools with input schemas", async () => {
    const server = createServer({ sdk: fakeSdk().sdk });
    const res = (await server.handleMCPRequest(jsonrpc("tools/list", {}, 2))) as {
      result: { tools: { name: string; inputSchema: Record<string, unknown> }[] };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual([
      "transfer",
      "balance",
      "policy.get",
      "counterparties.list",
    ]);
    for (const tool of res.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("invokes the SDK when calling the balance tool with valid args", async () => {
    const { sdk, calls } = fakeSdk();
    const server = createServer({ sdk });
    const res = (await server.handleMCPRequest(
      jsonrpc("tools/call", { name: "balance", arguments: { walletId: "wallet-1" } }, 3),
    )) as { result: McpToolResult };
    expect(res.result.isError).toBeUndefined();
    const parsed = JSON.parse(res.result.content[0].text) as { walletId: string; balance: number; status: string };
    expect(parsed).toEqual({ walletId: "wallet-1", balance: 500, status: "ACTIVE" });
    expect(calls).toEqual([{ method: "getWallet", args: ["wallet-1"] }]);
  });

  it("returns the transaction id and status from a transfer call", async () => {
    const { sdk, calls } = fakeSdk();
    const server = createServer({ sdk });
    const res = (await server.handleMCPRequest(
      jsonrpc("tools/call", { name: "transfer", arguments: { walletId: "wallet-1", to: "compute:0xCAFE0001", amount: 30, purpose: "gpu burst" } }, 4),
    )) as { result: McpToolResult };
    expect(res.result.isError).toBeUndefined();
    const parsed = JSON.parse(res.result.content[0].text) as {
      ok: boolean;
      transactionStatus: string;
      transactionId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.transactionStatus).toBe("PENDING");
    expect(parsed.transactionId).toBe("tx-1");
    expect(calls[0]).toEqual({ method: "transfer", args: [{ to: "compute:0xCAFE0001", amount: 30, purpose: "gpu burst" }] });
  });

  it("returns an isError result for an unknown tool name", async () => {
    const { sdk } = fakeSdk();
    const server = createServer({ sdk });
    const res = (await server.handleMCPRequest(
      jsonrpc("tools/call", { name: "nope", arguments: {} }, 5),
    )) as { result: McpToolResult };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Unknown tool");
  });

  it("returns an isError result when credentials are missing", async () => {
    const server = createServer({});
    const res = (await server.handleMCPRequest(
      jsonrpc("tools/call", { name: "balance", arguments: { walletId: "wallet-1" } }, 6),
    )) as { result: McpToolResult };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("credentials");
  });

  it("falls back to method-not-found for unknown methods", async () => {
    const server = createServer({ sdk: fakeSdk().sdk });
    const res = (await server.handleMCPRequest(jsonrpc("bogus", {}, 8))) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });
});
