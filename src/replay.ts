import type { Database as DB } from "better-sqlite3";

export function replay(db: DB, runId: string, fromStep?: string) {
  db.transaction(() => {
    const reset = db
      .prepare(
        `UPDATE runs SET status = 'pending', error = NULL, output = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed'`,
      )
      .run(Date.now(), runId);

    if (reset.changes !== 1) {
      throw new Error(`run ${runId} not found or not failed`);
    }

    if (fromStep) {
      const step = db
        .prepare(`SELECT seq FROM steps WHERE run_id = ? AND name = ?`)
        .get(runId, fromStep) as { seq: number } | undefined;

      if (!step) {
        throw new Error(`run ${runId} has no step "${fromStep}"`);
      }
      db.prepare(`DELETE FROM steps WHERE run_id = ? AND seq >= ?`).run(
        runId,
        step.seq,
      );
    } else {
      db.prepare(`DELETE FROM steps WHERE run_id = ? AND status != 'done'`).run(
        runId,
      );
    }
  })();
}
