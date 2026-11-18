import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migrations = [
  ["001_initial", new URL("../../src/memory/migrations/001_initial.sql", import.meta.url)],
  ["002_embeddings", new URL("../../src/memory/migrations/002_embeddings.sql", import.meta.url)],
  ["003_immutable_observations", new URL("../../src/memory/migrations/003_immutable_observations.sql", import.meta.url)],
] as const;

export function openDatabase(path: string): Database.Database {
  const filename = path === ":memory:" ? path : resolve(path);
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)");
  for (const [id, url] of migrations) {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(id)) continue;
    const sourceUrl = existsSync(fileURLToPath(url)) ? url : new URL(`../../../src/memory/migrations/${id}.sql`, import.meta.url);
    const migration = readFileSync(fileURLToPath(sourceUrl), "utf8");
    db.transaction(() => {
      db.exec(migration);
      db.prepare("INSERT INTO schema_migrations (id, applied_at_utc) VALUES (?, ?)").run(id, new Date().toISOString());
    })();
  }
  return db;
}
