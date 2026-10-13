export type RunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed";

// no "pending" here: a step row only gets created once the code reaches it
export type StepStatus = "running" | "done" | "failed";

// Rows as better-sqlite3 returns them, so field names match the columns.
// INTEGER -> number, TEXT -> string, nullable column -> | null.
// Timestamps are ms since epoch (Date.now()).

export interface RunRow {
  id: string;
  workflow: string;
  input: string; // JSON, always set (undefined input is stored as "null")
  status: RunStatus;
  output: string | null; // JSON, set when the run completes
  error: string | null;
  wake_at: number | null; // only while sleeping
  lease_until: number | null; // set when claimed, cleared on sleep/replay
  created_at: number;
  updated_at: number;
}

export interface StepRow {
  run_id: string;
  name: string; // (run_id, name) is the primary key
  seq: number; // order the steps first ran in
  status: StepStatus;
  result: string | null; // JSON of what fn returned, null until done
  error: string | null;
  attempts: number;
  wake_at: number | null; // only for ctx.sleep steps
  started_at: number | null;
  finished_at: number | null;
}
