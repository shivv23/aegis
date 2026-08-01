/**
 * Runs before every test file imports its modules, so env-driven constants
 * (DB url, policy timelock) are already set. Each test file gets a fresh
 * in-memory ledger via a separate module registry.
 */
process.env.AEGIS_DB_URL = "file::memory:";
process.env.AEGIS_POLICY_TIMELOCK_MS = "60000";
process.env.AEGIS_SEED_DEMO = "1";
