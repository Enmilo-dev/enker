import { describe, test, expect, vi, afterEach } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { createEngine } from "../src/engine";
import type { RunRow } from "../src/types";

type Engine = ReturnType<typeof createEngine>;

function getRun(engine: Engine, id: string) {
  return engine.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow;
}

function insertRun(engine: Engine, id: string, status: string, leaseUntil: number | null = null) {
  engine.db
    .prepare(
      `INSERT INTO runs (id, workflow, input, status, lease_until, created_at, updated_at)
       VALUES (?, 'checkout', 'null', ?, ?, 1, 1)`,
    )
    .run(id, status, leaseUntil);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("recover loop", () => {
  test("start() picks up a run whose worker died", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    engine.workflow("checkout", async () => "ok");
    insertRun(engine, "r1", "running", Date.now() - 1);

    engine.start(20);

    await vi.waitFor(() => expect(getRun(engine, "r1").status).toBe("completed"));
    engine.close();
  });

  test("start() picks up a pending run", async () => {
    const engine = createEngine({ dbPath: ":memory:" });
    engine.workflow("checkout", async () => "ok");
    insertRun(engine, "r1", "pending");

    engine.start(20);

    await vi.waitFor(() => expect(getRun(engine, "r1").status).toBe("completed"));
    engine.close();
  });

  test("calling start() twice only creates one poller", () => {
    vi.useFakeTimers();
    const engine = createEngine({ dbPath: ":memory:" });

    engine.start();
    engine.start();

    expect(vi.getTimerCount()).toBe(1);
    engine.close();
  });

  test("close() stops the loop so it never touches the closed db", () => {
    vi.useFakeTimers();
    const engine = createEngine({ dbPath: ":memory:" });
    engine.start(1000);

    engine.close();

    expect(vi.getTimerCount()).toBe(0);
    // would throw "database connection is not open" if the interval were still alive
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});

describe("lease heartbeat", () => {
  test("a run longer than the lease isn't taken by another worker", async () => {
    const engine = createEngine({ dbPath: ":memory:", leaseMs: 60 });
    const fn = vi.fn(async () => {
      await sleep(200);
      return "ok";
    });
    const checkout = engine.workflow("checkout", fn);

    const running = checkout.run(null);
    await sleep(120); // past the original lease

    const id = (engine.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    expect(getRun(engine, id).lease_until).toBeGreaterThan(Date.now());

    // another worker trying to take it now must lose the claim
    await engine.execute(id);
    await running;

    expect(fn).toHaveBeenCalledTimes(1);
    expect(getRun(engine, id).status).toBe("completed");
    engine.close();
  });

  test("the heartbeat stops once the run finishes", async () => {
    vi.useFakeTimers();
    const engine = createEngine({ dbPath: ":memory:" });
    const checkout = engine.workflow("checkout", async () => "ok");

    await checkout.run(null);

    // a leaked setInterval would still be counted here
    expect(vi.getTimerCount()).toBe(0);
    engine.close();
  });

  test("the heartbeat stops when the run fails too", async () => {
    vi.useFakeTimers();
    const engine = createEngine({ dbPath: ":memory:" });
    const checkout = engine.workflow("checkout", async () => {
      throw new Error("boom");
    });

    await expect(checkout.run(null)).rejects.toThrow("boom");

    expect(vi.getTimerCount()).toBe(0);
    engine.close();
  });
});
