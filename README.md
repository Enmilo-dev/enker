# enker

[![npm](https://img.shields.io/npm/v/@enmilo/enker)](https://www.npmjs.com/package/@enmilo/enker)
[![license](https://img.shields.io/npm/l/@enmilo/enker)](./LICENSE)

Crash-safe workflow steps for Node.js and TypeScript, backed by SQLite. Resume after crashes, retry, sleep, and replay failed runs. No server, no queue, just a library and one database file.

```ts
const checkout = engine.workflow("checkout", async (ctx, order) => {
  const charge = await ctx.step("charge", () => chargeCard(order));
  await ctx.step("reserve-stock", () => reserveStock(order));
  await ctx.step("send-receipt", () => sendReceipt(order, charge));
});
```

If the process dies after `charge` and before `send-receipt`, the next start picks the run up again. `charge` is **not** run again (its saved result is returned), and the run continues from `reserve-stock`.

## Why

A checkout is several steps: charge the card, reserve stock, send an email. If your server crashes or restarts between two of them, you get the bugs that hurt the most: a customer charged without an order, or an order processed twice.

Tools like Temporal, Inngest and DBOS solve this with _durable execution_: every step's result is saved, and after a crash the workflow resumes where it stopped. enker is a small take on the same idea for projects that don't want to run extra infrastructure. It keeps everything in one SQLite file next to your app.

### Why I built it

I once bought medicine online for about 2,600 Taka. My bank took the money, but the app said the payment had failed, and it still said so after I restarted it. It took two days of talking to both the company and my bank before they told me I'd get my money back in 30 days.

I don't want anyone else to go through that. It doesn't happen every day, but when it does, it hurts most for someone with limited money who needs something important right now. The buyer and the seller should both end up with the correct transaction, and nobody should get caught in a system failure.

That moment (the money moved, but the system never recorded it) is exactly what the [crash test](#crash-test) below reproduces, and what enker is built to survive.

## Install

```bash
npm install @enmilo/enker
```

Requires Node.js 22.12 or newer. Works from ESM and CommonJS (`require("@enmilo/enker")`).

## Quick start

```ts
import { createEngine } from "@enmilo/enker";

const engine = createEngine({ dbPath: "./app.db" });

const checkout = engine.workflow(
  "checkout",
  async (ctx, order: { id: string; amount: number }) => {
    const charge = await ctx.step("charge", () =>
      payments.charge(order.amount, {
        idempotencyKey: ctx.idempotencyKey("charge"),
      }),
    );
    await ctx.step("reserve-stock", () => inventory.reserve(order.id));
    await ctx.sleep("wait-1h", 60 * 60 * 1000);
    await ctx.step("send-receipt", () => email.send(order.id, charge.id));
    return { chargeId: charge.id };
  },
);

// resume crashed, pending and sleeping runs (polls every second)
engine.start();

await checkout.run({ id: "order_1", amount: 4999 });
```

- `ctx.step(name, fn)` runs `fn` once and saves its result. On a later replay of the same run it returns the saved result instead of calling `fn` again.
- `ctx.sleep(name, ms)` pauses the run **without** keeping your process busy. The run is saved as `sleeping`, and `engine.start()` wakes it up when the time has passed, even after a restart.
- `ctx.idempotencyKey(name)` gives a key that is stable across retries and crashes (`"<runId>:<name>"`). Pass it to payment providers and other APIs that support idempotency keys.

## How it works

1. `workflow.run(input)` saves a run row in SQLite and executes your function.
2. Every `ctx.step` checks the `steps` table first. A step marked `done` returns its saved JSON result, and anything else runs (with retries).
3. If the process dies, the run row stays `running` with a **lease** (`lease_until`). While the worker is alive, a heartbeat keeps extending the lease. Once the worker is dead, the lease expires.
4. `engine.start()` polls for runs that are `pending`, `running` with an expired lease, or `sleeping` and due. It claims each one with a single atomic `UPDATE ... WHERE` (only one worker can win), and re-runs the workflow function from the top. Finished steps are skipped, so execution continues at the first unfinished step.

```
pending ──► running ──► completed
               │  ▲
               │  └── lease expired (worker crashed) → claimed again
               ├──► sleeping ──(wake_at reached)──► running
               └──► failed ──(engine.replay)──► pending
```

Several processes can share one database file: the claim is a compare-and-swap, so a run is only ever executed by one worker at a time.

## Crash test

The repo includes a test that kills the worker **30 times** with `SIGKILL` (no cleanup, like pulling the power plug) while it processes 50 checkout runs, then lets a final worker finish. The checkout charges a fake bank that ignores repeated idempotency keys.

|                              | with idempotency keys | without keys |
| ---------------------------- | --------------------- | ------------ |
| worker killed (SIGKILL)      | 30 times              | 30 times     |
| runs completed               | 50 / 50               | 50 / 50      |
| charges in the bank          | **50**                | **104**      |
| orders charged twice or more | **0**                 | **26**       |

Both columns use the same engine and the same kind of crashes. Every run completes, but a crash between "the bank charged" and "the step was saved" makes the `charge` step run again. With `ctx.idempotencyKey`, the bank recognises the repeat; without it, the customer pays twice.

**enker guarantees at-least-once execution of each step. Idempotency keys turn that into exactly-once side effects.**

Run it yourself:

```bash
pnpm tsx crash-test/run.ts
NO_KEYS=1 pnpm tsx crash-test/run.ts
```

The numbers vary between runs because the kill timing is random. The first column should always show 0 double charges.

## API

### `createEngine(options)`

```ts
const engine = createEngine({ dbPath: "./app.db", leaseMs: 30_000 });
```

| option    | default  |                                                                                                                                                             |
| --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dbPath`  | required | SQLite file (created if missing). `":memory:"` works for tests.                                                                                             |
| `leaseMs` | `30000`  | How long a run stays locked to a worker. A crashed worker's runs are picked up after this. The lease is renewed every `leaseMs / 3` while the run is alive. |

Returns an `Engine`:

|                                   |                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.workflow(name, fn)`       | Registers a workflow and returns `{ name, run }`. Names must be unique.                                                                                        |
| `engine.start(intervalMs = 1000)` | Starts the recovery loop. Call it in every process that should execute runs.                                                                                   |
| `engine.stop()`                   | Stops the recovery loop.                                                                                                                                       |
| `engine.execute(runId)`           | Tries to claim and run one run now. Does nothing if another worker holds it.                                                                                   |
| `engine.replay(runId, fromStep?)` | Resets a **failed** run to `pending`. Without `fromStep`, only unfinished steps are cleared. With `fromStep`, that step and every step after it are run again. |
| `engine.close()`                  | Stops the loop and closes the database.                                                                                                                        |
| `engine.db`                       | The underlying `better-sqlite3` database, if you want to query `runs` and `steps` yourself.                                                                    |

### `workflow.run(input)`

Saves a new run and executes it in the current process. It resolves with the workflow's return value, resolves with `undefined` if the workflow went to sleep, and rejects if the workflow failed (the run is saved as `failed`). `input` must be JSON-serialisable.

### `ctx.step(name, fn, options?)`

| option        | default |                                                                                                        |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `retries`     | `3`     | Total attempts, including the first. Attempts are saved, so attempts interrupted by a crash count too. |
| `baseDelayMs` | `1000`  | Backoff between attempts: `baseDelayMs * 2^(attempt-1)`, capped at 30s.                                |

### `ctx.sleep(name, ms)`

Durable sleep. The wake-up time is saved on the first call, so a restart doesn't reset the timer. How precisely it wakes depends on the `engine.start()` interval.

### `ctx.idempotencyKey(name)`

Returns `"<runId>:<name>"`: the same value on every attempt of that step in that run.

### `SuspendSignal`

The error `ctx.sleep` throws to pause a run. You only need it if you wrap a sleep in your own `try/catch`. See the rules below.

## CLI

```bash
npx enker list [--status failed] [--db ./app.db]
npx enker show <runId> [--db ./app.db]
npx enker replay <runId> [--from <step>] [--db ./app.db]
```

`show` prints the run and its steps with attempts, timings and results. `replay` only resets the run to `pending`; a process running `engine.start()` picks it up, because the CLI doesn't have your workflow code.

## Rules for workflow code

Workflow functions are re-run from the top after a crash, sleep or replay, so:

- **Step names are permanent ids.** Don't rename or reorder steps while runs are in flight, and don't use the same name twice in one run (enker throws).
- **Put side effects inside steps.** Code between steps runs again on every replay.
- **Make side effects idempotent.** A step can run more than once if the process dies after the side effect but before the result is saved. Use `ctx.idempotencyKey` (or your own upsert/unique key).
- **Results must be JSON-serialisable.** `undefined` comes back as `null`, and a `Date` comes back as a string.
- **Don't swallow `SuspendSignal`.** If you catch errors around `ctx.sleep`, rethrow it:
  ```ts
  try {
    await ctx.sleep("wait", 60_000);
  } catch (err) {
    if (err instanceof SuspendSignal) throw err;
    // ...
  }
  ```

## Limits

- **One machine.** Runs are stored in a single SQLite file, so all workers must share that file (one server, several processes is fine).
- **Polling.** The recovery loop polls the database. There are no push notifications or cron schedules.
- **Workflow versioning.** There is none: changing a workflow's steps affects runs already in progress.

## Development

```bash
pnpm install
pnpm test        # 36 tests (Vitest)
pnpm typecheck
pnpm build       # tsup → dist/
```

## License

[Apache-2.0](./LICENSE) © Md Raihan Ahmed
