import { describe, expect, it } from "vitest";
import { classifyHeuristic, classifyIntent } from "@/core/classify";

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
