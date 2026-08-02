/**
 * Pluggable intent classifier for the `purpose` field. Off by default.
 *
 * When AEGIS_LLM_URL (+ optional AEGIS_LLM_KEY) is set, a real model may be
 * called (see classifyWithLLM). Without it, a deterministic keyword heuristic
 * runs instead — so the guard behaves identically whether or not an LLM is
 * configured. The classifier never gates a transfer by itself; it only feeds
 * the risk engine (see executor: intent anomaly adjustment).
 */

export type IntentCategory =
  | "compute"
  | "api"
  | "storage"
  | "salary"
  | "marketing"
  | "withdrawal"
  | "unknown";

export interface IntentVerdict {
  category: IntentCategory;
  confidence: number;
  source: "heuristic" | "llm";
  raw: string;
}

const KEYWORDS: Array<{ category: IntentCategory; words: string[] }> = [
  { category: "compute", words: ["gpu", "burst", "compute", "inference", "training", "render"] },
  { category: "api", words: ["api", "llm", "quota", "token", "endpoint", "webhook"] },
  { category: "storage", words: ["storage", "vector", "db", "database", "bucket", "s3"] },
  { category: "salary", words: ["salary", "payroll", "compensation", "wage"] },
  { category: "marketing", words: ["ads", "campaign", "influencer", "promo", "boost"] },
  { category: "withdrawal", words: ["withdraw", "cash out", "transfer out", "payout"] },
];

/** Deterministic keyword fallback — always available, zero external calls. */
export function classifyHeuristic(purpose: string): IntentVerdict {
  const raw = purpose.toLowerCase();
  let best: IntentCategory = "unknown";
  let bestHits = 0;
  for (const group of KEYWORDS) {
    const hits = group.words.filter((w) => raw.includes(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = group.category;
    }
  }
  const confidence = best === "unknown" ? 0.2 : Math.min(0.95, 0.5 + bestHits * 0.2);
  return { category: best, confidence, source: "heuristic", raw: purpose };
}

/**
 * Optional LLM path. Honors the same contract as the heuristic. Fire-and-read
 * with a short timeout; any failure falls back to the heuristic so the guard
 * is never blocked by a model outage.
 *
 * Speaks the OpenAI chat/completions dialect (works with OpenAI, Orca Router,
 * OpenRouter, and most gateways). Auth: sends `Authorization: Bearer
 * AEGIS_LLM_KEY` when set; `prompt`-style endpoints are also tolerated by
 * reading a plain-text body when there is no `choices` array.
 *
 * Results are cached per purpose for a short TTL so repeat purposes in a live
 * demo don't re-bill the model for every transfer.
 */
const llmCache = new Map<string, { expires: number; verdict: IntentVerdict }>();
const LLM_CACHE_TTL_MS = 10 * 60 * 1000;

export function classifyWithLLM(
  purpose: string,
  endpoint: string,
): Promise<IntentVerdict | null> {
  const cached = llmCache.get(purpose);
  if (cached && cached.expires > Date.now()) {
    return Promise.resolve(cached.verdict);
  }
  return classifyWithLLMUncached(purpose, endpoint).then((verdict) => {
    if (verdict) {
      llmCache.set(purpose, { expires: Date.now() + LLM_CACHE_TTL_MS, verdict });
      return verdict;
    }
    return null;
  });
}

async function classifyWithLLMUncached(
  purpose: string,
  endpoint: string,
): Promise<IntentVerdict | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = process.env.AEGIS_LLM_KEY;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: process.env.AEGIS_LLM_MODEL ?? "orcarouter/auto",
        messages: [
          {
            role: "system",
            content:
              "You classify payment purposes into exactly one category: compute, api, storage, salary, marketing, withdrawal, or unknown. Reply with only the single category word.",
          },
          { role: "user", content: `Purpose: ${purpose}` },
        ],
        temperature: 0,
        max_tokens: 64,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    let text: string;
    try {
      const parsed = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      text = parsed.choices?.[0]?.message?.content ?? "";
    } catch {
      text = await res.text();
    }
    text = text.trim().toLowerCase();
    const category = (KEYWORDS.map((k) => k.category) as string[]).includes(text)
      ? (text as IntentCategory)
      : "unknown";
    return { category, confidence: 0.9, source: "llm", raw: purpose };
  } catch {
    return null;
  }
}

/** Public entry: LLM when configured, heuristic otherwise. */
export async function classifyIntent(purpose: string): Promise<IntentVerdict> {
  const endpoint = process.env.AEGIS_LLM_URL;
  if (endpoint) {
    const llm = await classifyWithLLM(purpose, endpoint);
    if (llm) return llm;
  }
  return classifyHeuristic(purpose);
}
