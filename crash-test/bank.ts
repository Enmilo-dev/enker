import Database from "better-sqlite3";

export function openBank(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS charges (
      idempotency_key TEXT UNIQUE,
      order_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  return {
    db,
    charge(orderId: string, key: string | null) {
      db.prepare(
        `INSERT INTO charges (idempotency_key, order_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).run(key, orderId, Date.now());
    },
  };
}
