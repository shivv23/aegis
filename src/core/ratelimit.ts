/**
 * Token-bucket rate limiting (B3).
 *
 * Pure in-memory — no external deps so it can run in the Edge middleware on
 * every /api request. State is per-isolate: on serverless this bounds burst
 * within a single instance. For a shared, durable limiter the bucket keys can
 * be swapped for a Redis/DB-backed store without changing call sites.
 *
 * Env knobs:
 *   AEGIS_RL_DISABLED=1     turn off limiting entirely (tests, local dev)
 *   AEGIS_RL_KEY_CAP        per-key bucket capacity  (default 60)
 *   AEGIS_RL_KEY_RPS        per-key refill rate/s     (default 10)
 *   AEGIS_RL_IP_CAP         per-IP bucket capacity    (default 300)
 *   AEGIS_RL_IP_RPS         per-IP refill rate/s      (default 50)
 */

export interface BucketConfig {
  capacity: number;
  refillPerSec: number;
}

export function rlConfig(): {
  disabled: boolean;
  key: BucketConfig;
  ip: BucketConfig;
} {
  return {
    disabled: process.env.AEGIS_RL_DISABLED === "1",
    key: {
      capacity: Number(process.env.AEGIS_RL_KEY_CAP ?? 60),
      refillPerSec: Number(process.env.AEGIS_RL_KEY_RPS ?? 10),
    },
    ip: {
      capacity: Number(process.env.AEGIS_RL_IP_CAP ?? 300),
      refillPerSec: Number(process.env.AEGIS_RL_IP_RPS ?? 50),
    },
  };
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetInMs: number;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly config: BucketConfig) {
    this.tokens = config.capacity;
    this.lastRefill = Date.now();
  }

  take(): RateLimitResult {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + (elapsedMs / 1000) * this.config.refillPerSec,
    );
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return {
        ok: true,
        limit: this.config.capacity,
        remaining: Math.floor(this.tokens),
        resetInMs: 0,
      };
    }
    const deficit = 1 - this.tokens;
    return {
      ok: false,
      limit: this.config.capacity,
      remaining: 0,
      resetInMs: Math.ceil((deficit / this.config.refillPerSec) * 1000),
    };
  }
}

const keyBuckets = new Map<string, TokenBucket>();
const ipBuckets = new Map<string, TokenBucket>();
const MAX_BUCKETS = 10_000;

function bucketFor(map: Map<string, TokenBucket>, key: string, config: BucketConfig) {
  let bucket = map.get(key);
  if (!bucket) {
    if (map.size >= MAX_BUCKETS) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest) map.delete(oldest);
    }
    bucket = new TokenBucket(config);
    map.set(key, bucket);
  }
  return bucket;
}

/**
 * Checks a request against both the per-key and per-IP buckets. The key is the
 * raw bearer token (hashed to avoid holding secrets in memory) when present,
 * else the IP itself so unauthenticated bursts still get throttled.
 */
export function checkRateLimit(input: {
  keyHash?: string;
  ip: string;
}): { key: RateLimitResult; ip: RateLimitResult } {
  const cfg = rlConfig();
  if (cfg.disabled) {
    const unlimited: RateLimitResult = { ok: true, limit: Infinity, remaining: Infinity, resetInMs: 0 };
    return { key: unlimited, ip: unlimited };
  }
  const ipResult = bucketFor(ipBuckets, input.ip, cfg.ip).take();
  let keyResult: RateLimitResult = { ok: true, limit: cfg.key.capacity, remaining: cfg.key.capacity, resetInMs: 0 };
  if (input.keyHash) {
    keyResult = bucketFor(keyBuckets, input.keyHash, cfg.key).take();
  }
  return { key: keyResult, ip: ipResult };
}
