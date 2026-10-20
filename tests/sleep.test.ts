import { describe, test, expect, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { createEngine } from "../src/engine";
import { openDB } from "../src/storage";
import { Ctx } from "../src/context";
import { SuspendSignal } from "../src/errors";
import type { RunRow, StepRow } from "../src/types";

type Engine = ReturnType<typeof createEngine>;

function onlyRun(engine: Engine) {
  return engine.db.prepare("SELECT * FROM runs").get() as RunRow;
}

function getStep(engine: Engine, runId: string, name: string) {
  return engine.db
    .prepare("SELECT * FROM steps WHERE run_id = ? AND name = ?")
    .get(runId, name) as StepRow;
}

// signup -> sleep -> follow-up, with spies to see what actually ran
function signupFlow(engine: Engine, sleepMs: number) {
  const signup = vi.fn(() => "user_1");
  const followUp = vi.fn(() => "sent");
  const wf = engine.workflow("signup", async (ctx) => {
    const user = await ctx.step("signup", signup);
    await ctx.sleep("wait", sleepMs);
    await ctx.step("follow-up", followUp);
    return user;
  });
  return { wf, signup, followUp };
}

describe("ctx.sleep", () => {
  test("suspends the run instead of blocking", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { wf, followUp } = signupFlow(engine, 60_000);

    const before = Date.now();
    const out = await wf.run(null);

    expect(out).toBeUndefined();
    expect(followUp).not.toHaveBeenCalled();
    const run = onlyRun(engine);
    expect(run.status).toBe("sleeping");
    expect(run.lease_until).toBeNull();
    expect(run.wake_at).toBeGreaterThanOrEqual(before + 60_000);
    engine.close();
  });

  test("wakes up after wake_at and finishes without repeating earlier steps", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { wf, signup, followUp } = signupFlow(engine, 50);

    await wf.run(null);
    await sleep(60);
    await engine.execute(onlyRun(engine).id);

    expect(signup).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);
    const run = onlyRun(engine);
    expect(run.status).toBe("completed");
    expect(run.output).toBe('"user_1"');
    expect(run.wake_at).toBeNull();
    expect(getStep(engine, run.id, "wait").status).toBe("done");
    engine.close();
  });

  test("execute() leaves a sleeping run alone until it's due", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { wf, followUp } = signupFlow(engine, 60_000);

    await wf.run(null);
    await engine.execute(onlyRun(engine).id);

    expect(followUp).not.toHaveBeenCalled();
    expect(onlyRun(engine).status).toBe("sleeping");
    engine.close();
  });

  test("a restart keeps the original wake-up time", async () => {
    const db = openDB(":memory:");

    const first = await new Ctx(db, "r1").sleep("wait", 10_000).catch((e) => e);
    await sleep(20);
    // new Ctx = the workflow replaying after a restart
    const second = await new Ctx(db, "r1").sleep("wait", 10_000).catch((e) => e);

    expect(first).toBeInstanceOf(SuspendSignal);
    expect(second).toBeInstanceOf(SuspendSignal);
    expect(second.wakeAt).toBe(first.wakeAt);
    db.close();
  });

  test("ctx.step doesn't retry or fail on a sleep inside it", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    let calls = 0;
    const wf = engine.workflow("onboard", async (ctx) => {
      await ctx.step("onboard", async () => {
        calls++;
        await ctx.sleep("wait", 60_000);
      });
    });

    await wf.run(null);

    expect(calls).toBe(1);
    const run = onlyRun(engine);
    expect(run.status).toBe("sleeping");
    expect(getStep(engine, run.id, "onboard").status).toBe("running");
    engine.close();
  });

  test("throws on a duplicate sleep name", async () => {
    const db = openDB(":memory:");
    const ctx = new Ctx(db, "r1");

    await ctx.step("wait", () => 1);

    await expect(ctx.sleep("wait", 1000)).rejects.toThrow(/duplicate/);
    db.close();
  });

  test("the recover loop wakes a due run on its own", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    const { wf, followUp } = signupFlow(engine, 50);

    await wf.run(null);
    engine.start(20);

    await vi.waitFor(() => expect(onlyRun(engine).status).toBe("completed"));
    expect(followUp).toHaveBeenCalledTimes(1);
    engine.close();
  });
});
