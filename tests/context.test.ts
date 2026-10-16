import { describe, test, expect, vi } from "vitest";
import { openDB } from "../src/storage";
import { Ctx } from "../src/context";
import type { StepRow } from "../src/types";

function getStep(db: ReturnType<typeof openDB>, name: string) {
  return db
    .prepare("SELECT * FROM steps WHERE run_id = ? AND name = ?")
    .get("r1", name) as StepRow | undefined;
}

describe("ctx.step", () => {
  test("runs fn and saves the result", async () => {
    const db = openDB(":memory:");
    const ctx = new Ctx(db, "r1");

    const out = await ctx.step("charge", () => ({ id: "ch_1" }));

    expect(out).toEqual({ id: "ch_1" });
    const row = getStep(db, "charge");
    expect(row?.status).toBe("done");
    expect(row?.result).toBe('{"id":"ch_1"}');
    expect(row?.attempts).toBe(1);
    db.close();
  });

  test("skips fn on replay and returns the saved result", async () => {
    const db = openDB(":memory:");
    const fn = vi.fn(() => ({ id: "ch_1" }));

    await new Ctx(db, "r1").step("charge", fn);
    const out = await new Ctx(db, "r1").step("charge", fn);

    expect(out).toEqual({ id: "ch_1" });
    expect(fn).toHaveBeenCalledTimes(1);
    db.close();
  });

  test("throws on a duplicate step name", async () => {
    const db = openDB(":memory:");
    const ctx = new Ctx(db, "r1");

    await ctx.step("charge", () => 1);

    await expect(ctx.step("charge", () => 2)).rejects.toThrow(/duplicate/);
    db.close();
  });

  test("retries until fn succeeds", async () => {
    const db = openDB(":memory:");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("ok");

    const out = await new Ctx(db, "r1").step("charge", fn, { baseDelayMs: 0 });

    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(getStep(db, "charge")?.attempts).toBe(3);
    db.close();
  });

  test("marks the step failed after the last attempt", async () => {
    const db = openDB(":memory:");
    const fn = vi.fn().mockRejectedValue(new Error("card declined"));

    await expect(
      new Ctx(db, "r1").step("charge", fn, { retries: 2, baseDelayMs: 0 }),
    ).rejects.toThrow("card declined");

    expect(fn).toHaveBeenCalledTimes(2);
    const row = getStep(db, "charge");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("card declined");
    db.close();
  });
});
