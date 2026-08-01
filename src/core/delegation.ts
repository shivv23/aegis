/**
 * Delegation tree (D4): org → team → wallet policy inheritance.
 *
 * Precedence rule — a child can only tighten, never loosen:
 *   - every numeric limit is the minimum across the levels that define it
 *   - allowlist / spending windows / region allowlist: the most specific
 *     non-empty definition wins (wallet → team → org)
 * The sources map records which level supplied each field so the UI can show
 * exactly where every effective limit came from.
 */
import type { WalletPolicy } from "./types";

export type PolicyLevel = "org" | "team" | "wallet";

export type PartialPolicy = Partial<WalletPolicy>;

export interface EffectivePolicy {
  policy: WalletPolicy;
  sources: Record<string, PolicyLevel>;
}

const NUMERIC_KEYS = [
  "maxPerTx",
  "dailyLimit",
  "monthlyLimit",
  "velocityLimitPerMin",
] as const;

const INHERITED_KEYS = ["allowlist", "spendingWindows", "regionAllowlist"] as const;

export function mergePolicy(
  walletPolicy: WalletPolicy,
  orgPolicy?: PartialPolicy,
  teamPolicy?: PartialPolicy,
): EffectivePolicy {
  const sources: Record<string, PolicyLevel> = {};
  const policy: WalletPolicy = { ...walletPolicy };

  // Numeric limits: effective = min across levels; the tightest wins.
  for (const key of NUMERIC_KEYS) {
    const values: { level: PolicyLevel; value: number }[] = [];
    if (typeof walletPolicy[key] === "number") values.push({ level: "wallet", value: walletPolicy[key] });
    if (teamPolicy && typeof teamPolicy[key] === "number") values.push({ level: "team", value: teamPolicy[key]! });
    if (orgPolicy && typeof orgPolicy[key] === "number") values.push({ level: "org", value: orgPolicy[key]! });
    if (values.length === 0) continue;
    const tightest = values.reduce((a, b) => (b.value < a.value ? b : a));
    policy[key] = tightest.value;
    sources[key] = tightest.level;
  }

  // Inherited lists: most specific non-empty definition wins.
  for (const key of INHERITED_KEYS) {
    const walletVal = walletPolicy[key];
    const teamVal = teamPolicy?.[key];
    const orgVal = orgPolicy?.[key];
    const pick = (v: PartialPolicy[typeof key] | undefined): boolean =>
      Array.isArray(v) ? v.length > 0 : Boolean(v);
    if (pick(walletVal)) {
      policy[key] = walletVal as never;
      sources[key] = "wallet";
    } else if (pick(teamVal)) {
      policy[key] = teamVal as never;
      sources[key] = "team";
    } else if (pick(orgVal)) {
      policy[key] = orgVal as never;
      sources[key] = "org";
    } else {
      policy[key] = walletVal as never;
      sources[key] = "wallet";
    }
  }

  return { policy, sources };
}
