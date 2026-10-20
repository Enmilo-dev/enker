import { setTimeout as sleep } from "node:timers/promises";
import { createEngine } from "../src/engine";
import { openBank } from "./bank";

const useKeys = process.env.NO_KEYS !== "1";
const engine = createEngine({ dbPath: "crash-test/enker.db", leaseMs: 500 });
const bank = openBank("crash-test/bank.db");

const jitter = () => sleep(Math.random() * 300);

engine.workflow("checkout", async (ctx, input: { orderId: string }) => {
  await ctx.step("charge", async () => {
    await jitter();
    bank.charge(input.orderId, useKeys ? ctx.idempotencyKey("charge") : null);
    await jitter();
  });
  await ctx.step("reserve-stock", jitter);
  await ctx.step("email", jitter);
});

engine.start(100);
