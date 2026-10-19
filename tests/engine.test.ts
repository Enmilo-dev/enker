import { describe, test, expect, vi } from "vitest";
import { createEngine } from "../src/engine";
import type { RunRow, StepRow } from "../src/types";

type Engine = ReturnType<typeof createEngine>;

function getRun(engine: Engine, id: string) {
  return engine.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
}

function lastRun(engine: Engine) {
  return engine.db
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1")
    .get() as RunRow;
}

function insertRun(
  engine: Engine,
  id: string,
  status: string,
  leaseUntil: number | null = null,
) {
  engine.db
    .prepare(
      `INSERT INTO runs (id, workflow, input, status, lease_until, created_at, updated_at)
       VALUES (?, 'checkout', '{"amount":500}', ?, ?, 1, 1)`,
    )
    .run(id, status, leaseUntil);
}

describe("engine", () => {
  test("a successful run ends completed with its output", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const checkout = engine.workflow("checkout", async (ctx, input) => {
      const charge = await ctx.step("charge", () => ({
        id: "ch_1",
        amount: input.amount,
      }));
      return { chargeId: charge.id };
    });

    const out = await checkout.run({ amount: 500 });

    expect(out).toEqual({ chargeId: "ch_1" });
    const run = lastRun(engine);
    expect(run.status).toBe("completed");
    expect(run.output).toBe('{"chargeId":"ch_1"}');
    expect(run.lease_until).toBeNull();
    engine.db.close();
  });

  test("a failing run ends failed with the error saved", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const checkout = engine.workflow("checkout", async (ctx) => {
      await ctx.step(
        "charge",
        () => {
          throw new Error("card declined");
        },
        { retries: 1 },
      );
    });

    await expect(checkout.run(null)).rejects.toThrow("card declined");

    const run = lastRun(engine);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("card declined");
    const step = engine.db
      .prepare("SELECT * FROM steps WHERE run_id = ?")
      .get(run.id) as StepRow;
    expect(step.status).toBe("failed");
    engine.db.close();
  });

  test("two execute() calls on the same run: only one wins the claim", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const fn = vi.fn(async () => "ok");
    engine.workflow("checkout", fn);
    insertRun(engine, "r1", "pending");

    await Promise.all([engine.execute("r1"), engine.execute("r1")]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(getRun(engine, "r1").status).toBe("completed");
    engine.db.close();
  });

  test("leaves a run alone while its lease is valid", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const fn = vi.fn(async () => "ok");
    engine.workflow("checkout", fn);
    insertRun(engine, "r1", "running", Date.now() + 60_000);

    await engine.execute("r1");

    expect(fn).not.toHaveBeenCalled();
    expect(getRun(engine, "r1").status).toBe("running");
    engine.db.close();
  });

  test("resumes a run with an expired lease and skips finished steps", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const charge = vi.fn(() => ({ id: "ch_1" }));
    const email = vi.fn(() => "sent");
    engine.workflow("checkout", async (ctx) => {
      const c = await ctx.step("charge", charge);
      await ctx.step("email", email);
      return c.id;
    });

    insertRun(engine, "r1", "running", Date.now() - 1);
    engine.db
      .prepare(
        `INSERT INTO steps (run_id, name, seq, status, result, attempts)
         VALUES ('r1', 'charge', 1, 'done', '{"id":"ch_1"}', 1)`,
      )
      .run();

    await engine.execute("r1");

    expect(charge).not.toHaveBeenCalled();
    expect(email).toHaveBeenCalledTimes(1);
    const run = getRun(engine, "r1");
    expect(run.status).toBe("completed");
    expect(run.output).toBe('"ch_1"');
    engine.db.close();
  });

  test("execute() doesn't throw when the workflow fails", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    engine.workflow("checkout", async () => {
      throw new Error("boom");
    });
    insertRun(engine, "r1", "pending");

    await expect(engine.execute("r1")).resolves.toBeUndefined();
    expect(getRun(engine, "r1").status).toBe("failed");
    engine.db.close();
  });

  test("leaves runs alone when their workflow isn't registered here", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    insertRun(engine, "r1", "pending");

    await engine.execute("r1");

    expect(getRun(engine, "r1").status).toBe("pending");
    engine.db.close();
  });

  test("registering the same workflow name twice throws", () => {
    const engine = createEngine({ dbPath: ":memory:" });
    engine.workflow("checkout", async () => {});

    expect(() => engine.workflow("checkout", async () => {})).toThrow(
      /already registered/,
    );
    engine.db.close();
  });
});
