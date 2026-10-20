import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { openDB } from "../src/storage";
import { openBank } from "./bank";

const RUNS = 50;
const ROUNDS = 30;

for (const file of ["enker.db", "bank.db"]) {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`crash-test/${file}${suffix}`, { force: true });
  }
}

const db = openDB("crash-test/enker.db");
const insert = db.prepare(
  `INSERT INTO runs (id, workflow, input, status, created_at, updated_at)
   VALUES (?, 'checkout', ?, 'pending', ?, ?)`,
);
const now = Date.now();
for (let i = 1; i <= RUNS; i++) {
  insert.run(`order-${i}`, JSON.stringify({ orderId: `order-${i}` }), now, now);
}

function startWorker() {
  return spawn(process.execPath, ["--import", "tsx", "crash-test/worker.ts"], {
    stdio: "inherit",
  });
}

for (let round = 1; round <= ROUNDS; round++) {
  const worker = startWorker();
  await sleep(300 + Math.random() * 900);
  worker.kill("SIGKILL");
  await once(worker, "exit");
}
console.log(`killed the worker ${ROUNDS} times`);

const last = startWorker();
const unfinished = db.prepare(
  `SELECT COUNT(*) AS n FROM runs WHERE status != 'completed'`,
);

const deadline = Date.now() + 30_000;
while ((unfinished.get() as { n: number }).n > 0) {
  if (Date.now() > deadline) throw new Error("runs didn't finish in 30s");
  await sleep(200);
}
last.kill("SIGKILL");
await once(last, "exit");

const bank = openBank("crash-test/bank.db");
const charges = bank.db.prepare(`SELECT COUNT(*) AS n FROM charges`).get() as {
  n: number;
};
const doubles = bank.db
  .prepare(
    `SELECT order_id, COUNT(*) AS c FROM charges
     GROUP BY order_id HAVING c > 1`,
  )
  .all() as { order_id: string; c: number }[];
const reruns = db
  .prepare(
    `SELECT name, COUNT(*) AS n FROM steps
     WHERE attempts > 1 GROUP BY name`,
  )
  .all();

console.log(
  `mode:            ${process.env.NO_KEYS === "1" ? "NO keys" : "idempotency keys"}`,
);
console.log(`runs completed:  ${RUNS} / ${RUNS}`);
console.log(`charges in bank: ${charges.n}`);
console.log(`double charges:  ${doubles.length}`);
console.log("steps that ran again after a crash:");
console.table(reruns);
