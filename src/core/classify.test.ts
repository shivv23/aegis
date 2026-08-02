import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyHeuristic, classifyIntent, classifyWithLLM } from "@/core/classify";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AEGIS_LLM_URL;
  delete process.env.AEGIS_LLM_KEY;
  delete process.env.AEGIS_LLM_MODEL;
});

describe("classifyHeuristic", () => {
  it("classifies compute purposes", () => {
    expect(classifyHeuristic("GPU burst #147").category).toBe("compute");
  });

  it("classifies api purposes", () => {
    expect(classifyHeuristic("LLM API quota").category).toBe("api");
  });

  it("classifies storage purposes", () => {
    expect(classifyHeuristic("vector DB storage").category).toBe("storage");
  });

  it("classifies withdrawals", () => {
    expect(classifyHeuristic("cash out to treasury").category).toBe("withdrawal");
  });

  it("returns unknown with low confidence for ambiguous text", () => {
    const v = classifyHeuristic("miscellaneous expense");
    expect(v.category).toBe("unknown");
    expect(v.confidence).toBeLessThan(0.5);
  });

  it("reports heuristic as the source", () => {
    expect(classifyHeuristic("gpu").source).toBe("heuristic");
  });
});

describe("classifyIntent", () => {
  it("uses the heuristic when no LLM endpoint is configured", async () => {
    const prev = process.env.AEGIS_LLM_URL;
    delete process.env.AEGIS_LLM_URL;
    try {
      const v = await classifyIntent("GPU burst");
      expect(v.source).toBe("heuristic");
      expect(v.category).toBe("compute");
    } finally {
      if (prev) process.env.AEGIS_LLM_URL = prev;
    }
  });
});

describe("classifyWithLLM", () => {
  it("parses an OpenAI chat/completions response and sends the bearer key", async () => {
    process.env.AEGIS_LLM_URL = "https://api.example.test/v1/chat/completions";
    process.env.AEGIS_LLM_KEY = "sk-test-secret";
    let captured: { headers: Record<string, string>; body: unknown } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        captured = { headers: init?.headers ?? {}, body: init?.body };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "withdrawal" } }],
          }),
        } as unknown as Response;
      }),
    );
    const verdict = await classifyWithLLM("rebalance treasury", process.env.AEGIS_LLM_URL);
    expect(verdict?.category).toBe("withdrawal");
    expect(verdict?.source).toBe("llm");
    const sent = captured as unknown as {
      headers: Record<string, string>;
      body: string;
    };
    expect(sent.headers["authorization"] ?? sent.headers["Authorization"]).toBe("Bearer sk-test-secret");
    const body = JSON.parse(sent.body) as { model: string; messages: unknown[] };
    expect(body.model).toBe("orcarouter/auto");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("falls back to null on a non-ok response so the heuristic takes over", async () => {
    process.env.AEGIS_LLM_URL = "https://api.example.test/v1/chat/completions";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response),
    );
    expect(await classifyWithLLM("gpu", process.env.AEGIS_LLM_URL)).toBeNull();
  });

  it("tolerates a plain-text body for prompt-style endpoints", async () => {
    process.env.AEGIS_LLM_URL = "https://api.example.test/v1/completions";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const r = new Response("compute", { status: 200 });
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("not json");
          },
          text: async () => r.text(),
        } as unknown as Response;
      }),
    );
    const verdict = await classifyWithLLM("gpu burst", process.env.AEGIS_LLM_URL);
    expect(verdict?.category).toBe("compute");
  });
});
