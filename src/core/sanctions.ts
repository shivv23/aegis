/**
 * OFAC-lite sanctions screening (AEGIS "watchlist").
 *
 * A small, self-contained watchlist + name matcher that runs before any money
 * moves and at counterparty registration. This is deliberately a *demo-grade*
 * screening layer: a static list of fictional-but-realistic designations with
 * exact / alias / containment / fuzzy-token matching. Swapping in a real
 * provider (e.g. a sanctioned-persons API) is a drop-in change behind
 * `screenCounterparty`.
 *
 * Design rules:
 * - Pure and deterministic — no I/O, so it can run inside the guard.
 * - A match never silently passes: it blocks the transfer AND stamps the
 *   counterparty as BLOCKED with a `sanctioned:<name>` flag at registration.
 */

export interface SanctionsEntry {
  name: string;
  aliases?: string[];
  category: string;
  programs: string[];
}

export interface SanctionsMatch {
  entry: SanctionsEntry;
  input: string;
  kind: "exact" | "alias" | "contains" | "fuzzy";
}

/** Demo watchlist. All entries are fictional demo designations. */
export const SANCTIONS_LIST: SanctionsEntry[] = [
  { name: "Aurora Trade Group", aliases: ["Aurora Trading", "ATG Ltd"], category: "Terrorism", programs: ["SDGT"] },
  { name: "Al-Mirhan Trading", aliases: ["Al Mirhan Co", "Al-Mirhan Corp"], category: "Terrorism", programs: ["SDGT"] },
  { name: "Kreston Global Finance", aliases: ["KGF Bank", "Kreston Finance"], category: "Proliferation", programs: ["NS-PM"] },
  { name: "Vanguard Nexus", aliases: ["Vanguard NX", "Nexus Vanguard"], category: "Proliferation", programs: ["NS-PM"] },
  { name: "Ironclad Commodities", category: "Proliferation", programs: ["NS-PM"] },
  { name: "Orion Shipping Lines", aliases: ["Orion Freight", "OSL Shipping"], category: "Narco-Trafficking", programs: ["SDNTK"] },
  { name: "Drakon Marine", aliases: ["Drakon Shipping"], category: "Narco-Trafficking", programs: ["SDNTK"] },
  { name: "Boreal Capital Partners", aliases: ["Boreal Fund", "BCP Capital"], category: "Cyber", programs: ["CYBER2"] },
  { name: "Northwind Systems", aliases: ["Northwind Tech", "NWS"], category: "Cyber", programs: ["CYBER2"] },
  { name: "Hale & Voss Holdings", aliases: ["Hale Voss"], category: "Treasury", programs: ["CAPTA"] },
];

/** Lowercase, strip punctuation, collapse whitespace: "Hale & Voss" → "hale voss". */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function makeMatch(entry: SanctionsEntry, input: string, kind: SanctionsMatch["kind"]): SanctionsMatch {
  return { entry, input, kind };
}

/**
 * Screens a free-form name against the watchlist. Returns the first match
 * (exact > alias > containment > fuzzy token overlap). `null` = clean.
 */
export function screenName(name: string): SanctionsMatch | null {
  const norm = normalizeName(name);
  if (!norm) return null;
  const tokens = norm.split(" ");

  for (const entry of SANCTIONS_LIST) {
    const candidateNames = [entry.name, ...(entry.aliases ?? [])];
    for (const candidate of candidateNames) {
      const cand = normalizeName(candidate);
      if (!cand) continue;
      if (cand === norm) {
        return makeMatch(entry, name, cand === normalizeName(entry.name) ? "exact" : "alias");
      }
      // Containment needs a minimum length on both sides so a short
      // fragment (e.g. a single letter) can't match a full designation.
      if (cand.length >= 4 && norm.length >= 3 && (norm.includes(cand) || cand.includes(norm))) {
        return makeMatch(entry, name, "contains");
      }
      const candTokens = cand.split(" ");
      if (candTokens.length >= 2 && tokens.length >= 2) {
        const overlap = tokens.filter((t) => candTokens.includes(t)).length;
        if (overlap >= 2 && overlap === candTokens.length) {
          return makeMatch(entry, name, "fuzzy");
        }
      }
    }
  }
  return null;
}

/**
 * Screens a counterparty (by name and/or address). Address matching is exact
 * against the watchlist names so `compute:0x…` allowlist handles that point to
 * a sanctioned name are caught too.
 */
export function screenCounterparty(input: {
  name?: string;
  address?: string;
}): SanctionsMatch | null {
  if (input.name) {
    const byName = screenName(input.name);
    if (byName) return byName;
  }
  if (input.address) {
    const byAddress = screenName(input.address);
    if (byAddress) return byAddress;
  }
  return null;
}
