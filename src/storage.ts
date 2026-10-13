import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";

export function openDB(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY NOT NULL,
      workflow TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'sleeping', 'completed', 'failed')),
      output TEXT,
      error TEXT,
      wake_at INTEGER,
      lease_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps(
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
      result TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      wake_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      PRIMARY KEY (run_id, name)
    );

    -- recover() polls by status every second
    CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
  `);

  return db;
}
