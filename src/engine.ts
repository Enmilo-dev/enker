import { randomUUID } from "node:crypto";
import { openDB } from "./storage";
import { Ctx } from "./context";
import type { RunRow } from "./types";

type WorkflowFn = (ctx: Ctx, input: any) => Promise<unknown>;

export interface EngineOptions {
  dbPath: string;
  leaseMs?: number;
}

export function createEngine({ dbPath, leaseMs = 30_000 }: EngineOptions) {
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
    try {
      const out = await fn(new Ctx(db, id), input);

      db.prepare(
        `UPDATE runs SET status = 'completed', output = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?`,
      ).run(JSON.stringify(out ?? null), Date.now(), id);

      return out;
    } catch (err) {
      db.prepare(
        `UPDATE runs SET status = 'failed', error = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?`,
      ).run(err instanceof Error ? err.message : String(err), Date.now(), id);
      throw err;
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
        `UPDATE runs SET status = 'running', lease_until = ?, updated_at = ?
      WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_until < ?))`,
      )
      .run(now + leaseMs, now, runId, now).changes;

    if (claimed !== 1) return;

    try {
      await perform(run.id, fn, JSON.parse(run.input));
    } catch {
      //perform already saved it as a failed
    }
  }
  return { db, workflow, execute, close: () => db.close() };
}
