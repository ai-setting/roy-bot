#!/usr/bin/env bun
/**
 * TaskBackend cost probe (Task #4380).
 *
 * Measured evidence for the design decision documented in
 * `src/env/task/backend/task-store-backend.ts`: every `listTasks` filter is
 * applied in memory, because the earlier "fast path" silently dropped `status`
 * and could never see archived rows (cross-validation round 1, D1/D2).
 *
 * That correctness choice has a cost, and this script records it instead of
 * hand-waving. Run it when the tradeoff needs revisiting:
 *
 *     bun run scripts/bench-task-backend.ts [rows]
 *
 * Measured on 2026-10-20 (this machine, tmpfs SQLite):
 *     rows=200   limit:5  →  104 ms
 *     rows=2000  limit:5  → 1140 ms   ← ~1.1 s per page at 2k tasks
 *
 * Implication: fine for the plugin's own task table (hundreds of rows), not
 * fine for a 10k+ task library.
 *
 * If that ever happens, the fix is NOT already in place (cross-validation round
 * 3 called an earlier claim to that effect oversold). What exists today is only
 * `includeArchived`, which is a *visibility* switch — it makes archived rows
 * reachable, it does not push filtering into SQL. `TaskStoreBackend` has exactly
 * one `port.listTasks` call site, always `limit: SCAN_ALL`, with no capability
 * check and no pushdown path. Reaching SQL-filtering parity would mean:
 *   1. adding `status` / `priority` / `type` / `parentTaskId` / `depth` to the
 *      port contract (types.ts),
 *   2. adding a capability probe + a second call path in task-store-backend.ts,
 *   3. implementing (and testing) the pushdown in EVERY port.
 * That is a real project, not a knob — which is why the simple all-in-memory
 * implementation stays until a >10k-row deployment actually shows up.
 *
 * This is a script, not a test: at 2k rows it takes ~270 s, which does not
 * belong in CI.
 */

import { tmpdir } from "os";
import { join } from "path";
import { SQLiteTaskStore } from "../src/env/task/storage/sqlite-task-store";
import { createSQLiteTaskPort, TaskStoreBackend } from "../src/env/task/backend";

const rows = Number(process.argv[2] ?? 2000);
const dbPath = join(tmpdir(), `bench-task-backend-${Date.now()}.db`);
const store = new SQLiteTaskStore(dbPath);
const backend = new TaskStoreBackend(createSQLiteTaskPort(store), { sessionId: "ses_bench" });

console.log(`seeding ${rows} tasks…`);
const t0 = Date.now();
for (let i = 0; i < rows; i++) {
  await backend.createTask({ title: `bulk ${i}`, project_path: "/r", context: "{}" });
}
console.log(`seeded in ${Date.now() - t0} ms`);

for (const limit of [5, 20, 100]) {
  const t = Date.now();
  const page = await backend.listTasks({ limit, offset: 0 });
  console.log(
    `  listTasks({limit:${limit}}) → returned=${page.tasks.length} total=${page.total} cost=${Date.now() - t} ms`,
  );
}

const t1 = Date.now();
const filtered = await backend.listTasks({ status: "todo", limit: 5 });
console.log(
  `  listTasks({status:"todo",limit:5}) → returned=${filtered.tasks.length} total=${filtered.total} cost=${Date.now() - t1} ms`,
);

await store.close();
