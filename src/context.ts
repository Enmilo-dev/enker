import type { Database as DB } from "better-sqlite3";
import type { StepRow } from "./types";

export interface StepOptions {
  retries?: number;
  baseDelayMs?: number;
}

export class Ctx {
  private db: DB;
  private seen = new Set<string>();

  constructor(
    db: DB,
    readonly runId: string,
  ) {
    this.db = db;
  }

  idempotencyKey(name: string): string {
    return `${this.runId}:${name}`;
  }

  private markDone(name: string, result: unknown) {
    this.db
      .prepare(
        `UPDATE steps SET status = 'done', result = ?, finished_at = ? WHERE run_id = ? AND name = ?`,
      )
      .run(JSON.stringify(result ?? null), Date.now(), this.runId, name);
  }

  private markFailed(name: string, err: unknown) {
    this.db
      .prepare(
        `UPDATE steps SET status = 'failed', error = ?, finished_at = ? WHERE run_id = ? AND name = ?`,
      )
      .run(
        err instanceof Error ? err.message : String(err),
        Date.now(),
        this.runId,
        name,
      );
  }

  private markRunning(name: string, attempt: number) {
    this.db
      .prepare(
        `INSERT INTO steps (run_id, name, seq, status, attempts, started_at)
      VALUES(?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE run_id = ?), 'running', ?, ?)
      ON CONFLICT (run_id, name) DO UPDATE SET status = 'running', attempts = excluded.attempts
      `,
      )
      .run(this.runId, name, this.runId, attempt, Date.now());
  }
}
