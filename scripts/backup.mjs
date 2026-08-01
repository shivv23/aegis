#!/usr/bin/env node
/**
 * Backup + retention for the AEGIS store.
 *
 *   AEGIS_DB_URL=postgres://… node scripts/backup.mjs     → pg_dump snapshot
 *   AEGIS_DB_URL=file:./data/aegis.db node scripts/backup.mjs → file copy
 *
 * Retention: AEGIS_RETENTION_DAYS (default 14) backups are kept; older
 * snapshots are pruned. Works for Postgres (Neon) and local libSQL.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const url = process.env.AEGIS_DB_URL ?? "file:./data/aegis.db";
const retentionDays = Number(process.env.AEGIS_RETENTION_DAYS ?? 14);
const outDir = process.env.AEGIS_BACKUP_DIR ?? "./backups";
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

if (url.startsWith("postgres")) {
  const target = join(outDir, `aegis-pg-${stamp}.dump`);
  execFileSync("pg_dump", [url, "-F", "c", "-f", target], { stdio: "inherit" });
  console.log(`snapshot: ${target}`);
} else if (url.startsWith("file:")) {
  const file = url.replace(/^file:/, "");
  if (!existsSync(file)) {
    console.error(`DB file not found: ${file}`);
    process.exit(1);
  }
  const target = join(outDir, `aegis-libsql-${stamp}.db`);
  copyFileSync(file, target);
  console.log(`snapshot: ${target}`);
} else {
  console.error(`Unsupported DB URL: ${url}`);
  process.exit(1);
}

// Prune old snapshots beyond retention.
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
let pruned = 0;
for (const name of readdirSync(outDir)) {
  const full = join(outDir, name);
  const stat = await import("node:fs").then((fs) => fs.statSync(full));
  if (stat.isFile() && stat.mtimeMs < cutoff) {
    rmSync(full);
    pruned += 1;
  }
}
console.log(`pruned ${pruned} snapshot(s) older than ${retentionDays}d`);
