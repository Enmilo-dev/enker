import type { Database as DB } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openDB } from "./storage";
import { Ctx } from "./context";
import type { RunRow } from "./types";
import { SuspendSignal } from "./errors";
import { replay } from "./replay";

export type WorkflowFn = (ctx: Ctx, input: any) => Promise<unknown>;

export interface Workflow {
  name: string;
  run(input: unknown): Promise<unknown>;
}

export interface Engine {
  db: DB;
  workflow(name: string, fn: WorkflowFn): Workflow;
  execute(runId: string): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
  replay(runId: string, fromStep?: string): void;
  close(): void;
}
export interface EngineOptions {
  dbPath: string;
  leaseMs?: number;
}

export function createEngine({
  dbPath,
  leaseMs = 30_000,
}: EngineOptions): Engine {
  const db = openDB(dbPath);
  const registry = new Map<string, WorkflowFn>();

  function workflow(name: string, fn: WorkflowFn) {
    if (registry.has(name)) {
      throw new Error(`workflow "${name}" is already registered`);
    }
    registry.set(name, fn);
    async function run(input: unknown) {
      const id = randomUUID();
      const now = Date.now();
      const json = JSON.stringify(input ?? null);

      db.prepare(
        `INSERT INTO runs (id, workflow, input, status, lease_until, created_at, updated_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      ).run(id, name, json, now + leaseMs, now, now);

      return perform(id, fn, JSON.parse(json));
    }

    return { name, run };
  }

  async function perform(id: string, fn: WorkflowFn, input: unknown) {
    const heartbeat = setInterval(() => {
      db.prepare(
        `UPDATE runs SET lease_until = ? WHERE id = ? AND status = 'running'`,
      ).run(Date.now() + leaseMs, id);
    }, leaseMs / 3);
    try {
      const out = await fn(new Ctx(db, id), input);

      db.prepare(
        `UPDATE runs SET status = 'completed', output = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?`,
      ).run(JSON.stringify(out ?? null), Date.now(), id);

      return out;
    } catch (err) {
      if (err instanceof SuspendSignal) {
        db.prepare(
          `UPDATE runs SET status = 'sleeping', wake_at = ?, lease_until = NULL, updated_at = ?
          WHERE id = ?`,
        ).run(err.wakeAt, Date.now(), id);
        return undefined;
      }

      db.prepare(
        `UPDATE runs SET status = 'failed', error = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?`,
      ).run(err instanceof Error ? err.message : String(err), Date.now(), id);

      throw err;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function execute(runId: string) {
    const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
      | RunRow
      | undefined;

    const fn = run && registry.get(run.workflow);
    if (!run || !fn) return;

    const now = Date.now();
    const claimed = db
      .prepare(
        `UPDATE runs SET status = 'running', lease_until = ?, wake_at = NULL, updated_at = ?
         WHERE id = ? AND (
           status = 'pending'
           OR (status = 'running' AND lease_until < ?)
           OR (status = 'sleeping' AND wake_at <= ?)
         )`,
      )
      .run(now + leaseMs, now, runId, now, now).changes;

    if (claimed !== 1) return;

    try {
      await perform(run.id, fn, JSON.parse(run.input));
    } catch {
      //perform already saved it as a failed
    }
  }

  function recover() {
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT id FROM runs
         WHERE status = 'pending'
            OR (status = 'running' AND lease_until < ?)
            OR (status = 'sleeping' AND wake_at <= ?)`,
      )
      .all(now, now) as { id: string }[];

    for (const { id } of rows) {
      execute(id).catch((err) =>
        console.error(`enker: run ${id} crashed`, err),
      );
    }
  }

  let timer: NodeJS.Timeout | undefined;

  function start(intervalMs = 1000) {
    if (timer) return;
    recover();
    timer = setInterval(recover, intervalMs);
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
  }
  return {
    db,
    workflow,
    execute,
    start,
    stop,
    replay: (runId: string, fromStep?: string) => replay(db, runId, fromStep),
    close: () => {
      stop();
      db.close();
    },
  };
}
