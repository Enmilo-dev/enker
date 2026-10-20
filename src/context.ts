import type { Database as DB } from "better-sqlite3";
import type { StepRow } from "./types";
import { SuspendSignal } from "./errors";

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

  async step<T>(
    name: string,
    fn: () => Promise<T> | T,
    opts: StepOptions = {},
  ): Promise<T> {
    this.useName(name);

    const row = this.db
      .prepare(`SELECT * FROM steps WHERE run_id = ? AND name = ?`)
      .get(this.runId, name) as StepRow | undefined;

    if (row?.status === "done") {
      return JSON.parse(row.result!) as T;
    }

    const retries = opts.retries ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 1000;

    let attempt = row?.attempts ?? 0;

    while (true) {
      attempt++;
      this.markRunning(name, attempt);

      try {
        const result = await fn();
        this.markDone(name, result);
        return result;
      } catch (err) {
        if (err instanceof SuspendSignal) throw err;

        if (attempt >= retries) {
          this.markFailed(name, err);
          throw err;
        }
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async sleep(name: string, ms: number): Promise<void> {
    this.useName(name);

    const row = this.db
      .prepare(`SELECT * FROM steps WHERE run_id = ? AND name = ?`)
      .get(this.runId, name) as StepRow | undefined;

    if (row?.status === "done") return;

    const wakeAt = row?.wake_at ?? Date.now() + ms;
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO steps (run_id, name, seq, status, wake_at, started_at)
           VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM steps WHERE run_id = ?), 'running', ?, ?)`,
        )
        .run(this.runId, name, this.runId, wakeAt, Date.now());
    }

    if (Date.now() < wakeAt) throw new SuspendSignal(wakeAt);

    this.markDone(name, null);
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

  private useName(name: string) {
    if (this.seen.has(name)) {
      throw new Error(`duplicate step name "${name}" in run "${this.runId}"`);
    }
    this.seen.add(name);
  }
}
