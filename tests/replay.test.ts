import { describe, test, expect, vi } from "vitest";
import { createEngine } from "../src/engine";
import type { RunRow, StepRow } from "../src/types";

type Engine = ReturnType<typeof createEngine>;

function onlyRun(engine: Engine) {
  return engine.db.prepare("SELECT * FROM runs").get() as RunRow;
}

function steps(engine: Engine, runId: string) {
  return engine.db
    .prepare("SELECT name, status FROM steps WHERE run_id = ? ORDER BY seq")
    .all(runId) as Pick<StepRow, "name" | "status">[];
}

// charge -> reserve -> email; email fails while `broken` is true
function checkoutFlow(engine: Engine) {
  const state = { broken: true };
  const charge = vi.fn(() => "ch_1");
  const reserve = vi.fn(() => "ok");
  const wf = engine.workflow("checkout", async (ctx) => {
    await ctx.step("charge", charge);
    await ctx.step("reserve", reserve);
    await ctx.step(
      "email",
      () => {
        if (state.broken) throw new Error("smtp down");
        return "sent";
      },
      { retries: 1 },
    );
    return "done";
  });
  return { wf, state, charge, reserve };
}

async function failedRun(engine: Engine) {
  const flow = checkoutFlow(engine);
  await expect(flow.wf.run(null)).rejects.toThrow("smtp down");
  return { ...flow, id: onlyRun(engine).id };
}

describe("replay", () => {
  test("resets a failed run to pending and drops only the unfinished steps", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { id } = await failedRun(engine);

    engine.replay(id);

    const run = onlyRun(engine);
    expect(run.status).toBe("pending");
    expect(run.error).toBeNull();
    expect(steps(engine, id)).toEqual([
      { name: "charge", status: "done" },
      { name: "reserve", status: "done" },
    ]);
    engine.close();
  });

  test("after a fix, the replayed run completes without redoing finished steps", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { id, state, charge, reserve } = await failedRun(engine);

    state.broken = false; // the "deploy a fix" part
    engine.replay(id);
    engine.start(20);

    await vi.waitFor(() => expect(onlyRun(engine).status).toBe("completed"));
    expect(charge).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    engine.close();
  });

  test("refuses to replay a run that isn't failed", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const wf = engine.workflow("ok", async () => "fine");
    await wf.run(null);
    const id = onlyRun(engine).id;

    expect(() => engine.replay(id)).toThrow(/not failed/);
    expect(onlyRun(engine).status).toBe("completed");

    // a run someone is executing right now must not be reset either
    engine.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(id);
    expect(() => engine.replay(id)).toThrow(/not failed/);
    expect(onlyRun(engine).status).toBe("running");
    engine.close();
  });

  test("fromStep drops that step and everything after it", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { id } = await failedRun(engine);

    engine.replay(id, "reserve");

    expect(onlyRun(engine).status).toBe("pending");
    expect(steps(engine, id)).toEqual([{ name: "charge", status: "done" }]);
    engine.close();
  });

  test("an unknown fromStep throws and rolls everything back", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { id } = await failedRun(engine);

    expect(() => engine.replay(id, "nope")).toThrow(/no step "nope"/);

    const run = onlyRun(engine);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("smtp down");
    expect(steps(engine, id)).toHaveLength(3);
    engine.close();
  });
});
