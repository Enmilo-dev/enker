import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDB } from "../src/storage";

const insertRun = `
  INSERT INTO runs (id, workflow, input, status, created_at, updated_at)
  VALUES (?, 'checkout', 'null', ?, 1, 1)
`;

describe("openDB", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("creates the runs and steps tables", () => {
    const db = openDB(":memory:");

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();

    expect(tables).toEqual([{ name: "runs" }, { name: "steps" }]);
    db.close();
  });

  test("rejects an unknown run status", () => {
    const db = openDB(":memory:");

    expect(() => db.prepare(insertRun).run("r1", "complete")).toThrow(
      /CHECK constraint failed/,
    );
    db.close();
  });

  test("rejects a run with a null id", () => {
    const db = openDB(":memory:");

    expect(() => db.prepare(insertRun).run(null, "pending")).toThrow(
      /NOT NULL constraint failed/,
    );
    db.close();
  });

  test("reopening an existing file keeps its data", () => {
    dir = mkdtempSync(join(tmpdir(), "enker-"));
    const file = join(dir, "test.db");

    const first = openDB(file);
    first.prepare(insertRun).run("r1", "pending");
    first.close();

    const second = openDB(file);
    const row = second
      .prepare("SELECT id, status FROM runs WHERE id = ?")
      .get("r1");

    expect(row).toEqual({ id: "r1", status: "pending" });
    second.close();
  });
});
