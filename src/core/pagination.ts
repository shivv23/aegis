/** Keyset cursor: the last row's ordering value + id tiebreak. */
export interface Cursor {
  at: number;
  id: string;
}

const PREFIX = "aegis:cursor:v1:";

export function encodeCursor(at: number, id: string): string {
  return Buffer.from(PREFIX + `${at}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    if (!decoded.startsWith(PREFIX)) return null;
    const [at, id] = decoded.slice(PREFIX.length).split(":");
    const ts = Number(at);
    if (!Number.isFinite(ts) || !id) return null;
    return { at: ts, id };
  } catch {
    return null;
  }
}

export function clampLimit(raw: string | null, def = 100, max = 1000): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}
