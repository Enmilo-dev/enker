#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDB } from "./storage";
import type { RunRow, StepRow } from "./types";
import { replay } from "./replay";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string", default: "enker.db" },
    status: { type: "string" },
    from: { type: "string" },
  },
});

const [command, id] = positionals;

const usage = `usage:
  enker list [--status failed] [--db path]
  enker show <runId>
  enker replay <runId> [--from step]`;

if (!["list", "show", "replay"].includes(command ?? "")) {
  console.log(usage);
  process.exit(command ? 1 : 0);
}

if (!existsSync(values.db)) {
  console.error(`no database at ${values.db} (use --db <path>)`);
  process.exit(1);
}
const db = openDB(values.db);

function list() {
  const where = values.status ? "WHERE status = ?" : "";
  const params = values.status ? [values.status] : [];
  const rows = db
    .prepare(
      `SELECT id, workflow, status, updated_at FROM runs ${where}
    ORDER BY created_at DESC LIMIT 20`,
    )
    .all(...params) as Pick<
    RunRow,
    "id" | "workflow" | "status" | "updated_at"
  >[];
  if (rows.length === 0) return console.log("no runs");
  console.table(
    rows.map((r) => ({
      ...r,
      updated_at: new Date(r.updated_at).toLocaleString(),
    })),
  );
}

function fail(message: string) {
  console.error(message);
  process.exitCode = 1;
}

function show(runId: string | undefined) {
  if (!runId) return fail("usage: enker show <runId>");

  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
    | RunRow
    | undefined;

  if (!run) return fail(`run "${runId}" not found`);

  console.log(`run       ${run.id}`);
  console.log(`workflow  ${run.workflow}`);
  console.log(`status    ${run.status}`);
  console.log(`input     ${run.input}`);
  if (run.output !== null) console.log(`output    ${run.output}`);
  if (run.error !== null) console.log(`error     ${run.error}`);
  if (run.wake_at !== null)
    console.log(`wakes at  ${new Date(run.wake_at).toLocaleString()}`);

  const steps = db
    .prepare(`SELECT * FROM steps WHERE run_id = ? ORDER BY seq`)
    .all(runId) as StepRow[];

  console.table(
    steps.map((s) => ({
      step: s.name,
      status: s.status,
      attempts: s.attempts,
      ms: s.finished_at && s.started_at ? s.finished_at - s.started_at : "",
      result: s.result ?? s.error ?? "",
    })),
  );
}

function replayRun(runId: string | undefined) {
  if (!runId) return fail("usage: enker replay <runId> [--from step]");
  try {
    replay(db, runId, values.from);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const from = values.from ? ` from step "${values.from}"` : "";
  console.log(
    `run ${runId} reset to pending${from}; a running worker will pick it up`,
  );
}

switch (command) {
  case "list":
    list();
    break;
  case "show":
    show(id);
    break;
  case "replay":
    replayRun(id);
    break;
  default:
    console.log(usage);
}

db.close();
