/**
 * @fileoverview Codex P1-3 / P1-4 / P1-uncertain (Task #2245)
 *
 * P1-3: Cascade caller does fire-and-forget Promise; failures invisible to user
 *   - handleEscKey calls cascadeStopSessionTree without awaiting
 *   - REPL resets isExecuting=false before cascade completes → race
 *   - Fix: handleEscKey must await the cascade (with timeout fallback)
 *
 * P1-4: TaskComponent.backgroundTaskManager is private but accessed via `as any`
 *   - session-tree-stopper.ts reads taskComp.backgroundTaskManager with `as any` cast
 *   - Fix: expose public getter; cascade uses typed accessor
 *
 * P1-uncertain: WorkflowSessionMetadata.status 'cancelled' never written
 *   - status union includes 'cancelled' but no caller writes it
 *   - Fix: drop 'cancelled' (no production writes it)
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect } from "bun:test";
import * as path from "path";

// Task #2245 — Codex v2 P1 fix: compute source paths relative to the
// test file location, not the worktree root. This makes the tests
// portable across any checkout / CI environment.
//
// Note: bun's `import.meta.url` resolves to the bun binary location
// when the test is run from a different cwd. We use the test filename
// captured at module load time, which bun correctly reports.
const TEST_FILE_URL = (require("url").pathToFileURL(__filename)).href;
const TEST_DIR = path.dirname(new URL(TEST_FILE_URL).pathname);
// Test file is at: packages/core/src/env/workflow/service/workflow-codex-p1-remaining.test.ts
// So 5 levels up gets to the worktree root.
const WORKTREE_ROOT = path.resolve(TEST_DIR, "../../../../../..");
const WORKFLOW_SERVICE_SRC = path.join(WORKTREE_ROOT, "packages/core/src/env/workflow/service/workflow-service.ts");
const TASK_COMPONENT_SRC = path.join(WORKTREE_ROOT, "packages/core/src/env/task/task-component.ts");
const SESSION_TREE_STOPPER_SRC = path.join(WORKTREE_ROOT, "packages/core/src/env/session-tree-stopper.ts");
// Task #4674: `commands/run.ts` 与 `commands/interactive.ts` 对调了文件名。
// `handleEscKey` / `cascadeStopSessionTree` 属于 **Ink REPL 链路**，
// 该链路现在住在 `packages/cli/src/commands/run.ts`（注册命令名 `run`）。
const REPL_SRC = path.join(WORKTREE_ROOT, "packages/cli/src/commands/run.ts");

describe("Codex P1-uncertain: WorkflowSessionMetadata.status drops 'cancelled'", () => {
  test("P1-uncertain-a: WorkflowSessionMetadata.status union 不含 'cancelled' (无 caller writes it)", () => {
    // Import the type indirectly via reading the source file
    // since this is a type-only assertion
    const fs = require("fs");
    const src = fs.readFileSync(WORKFLOW_SERVICE_SRC, "utf8");
    // Verify the source still has 'cancelled' in the status union
    // (this test will be RED after we drop 'cancelled')
    const statusLine = src.match(/status:\s*'running'\s*\|\s*'paused'\s*\|\s*'completed'\s*\|\s*'failed'\s*\|\s*'stopped'\s*\|\s*'cancelled'/);
    expect(statusLine).toBeNull();
  });

  test("P1-uncertain-b: WorkflowSessionMetadata 注释不引用 'cancelled' 为 legacy (已 drop)", () => {
    const fs = require("fs");
    const src = fs.readFileSync(WORKFLOW_SERVICE_SRC, "utf8");
    // After the fix, the comment should not say "'cancelled' is an alias
    // kept for legacy caller compatibility"
    expect(src).not.toMatch(/'cancelled'\s+is\s+an?\s+alias\s+kept\s+for\s+legacy/);
  });
});

// ---------------------------------------------------------------------------
// P1-4: TaskComponent exposes public getter for backgroundTaskManager
// ---------------------------------------------------------------------------

describe("Codex P1-4: TaskComponent exposes public getter for backgroundTaskManager", () => {
  test("P1-4a: getBackgroundTaskManager() 方法存在于 TaskComponent 类型上（type-level guard）", () => {
    // The getter is checked at the type level via TypeScript compile.
    // The runtime check verifies the method body via grep on source.
    const fs = require("fs");
    const src = fs.readFileSync(TASK_COMPONENT_SRC, "utf8");
    // After the fix, a public getter must exist
    const hasGetter = /public\s+getBackgroundTaskManager\s*\(/.test(src) ||
      /getBackgroundTaskManager\s*\(\s*\)\s*:\s*BackgroundTaskManager/.test(src);
    expect(hasGetter).toBe(true);
  });

  test("P1-4b: backgroundTaskManager 字段类型不再 strict-private (允许类型安全访问)", () => {
    // session-tree-stopper.ts should no longer need `as any` cast when
    // accessing backgroundTaskManager. We check for `as any` casts within
    // 50 chars after `backgroundTaskManager` (or in surrounding context).
    const fs = require("fs");
    const src = fs.readFileSync(SESSION_TREE_STOPPER_SRC, "utf8");
    // Find any `as any` cast that's used for accessing backgroundTaskManager
    // pattern: optional chain or direct access followed by backgroundTaskManager
    const hasAsAnyBgMgr =
      /\(\s*\w+\s+as\s+any\s*\)\s*\??\.backgroundTaskManager/.test(src) ||
      /\(\s*\w+\s+as\s+any\s*\)\s*\??\s*\[\s*['"]backgroundTaskManager['"]\s*\]/.test(src);
    expect(hasAsAnyBgMgr).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-3: handleEscKey awaits cascade (no fire-and-forget)
// ---------------------------------------------------------------------------

describe("Codex P1-3: handleEscKey cascade lifecycle", () => {
  // This test verifies the cascade call pattern in interactive.ts.
  // We grep the source to ensure cascadeStopSessionTree is awaited (not
  // fire-and-forget). The authoritative fix is the code change; this
  // test guards against regression to the .then().catch() pattern.
  test("P1-3a: handleEscKey 不使用 fire-and-forget cascade 调用", () => {
    const fs = require("fs");
    const src = fs.readFileSync(REPL_SRC, "utf8");
    // After the fix, the cascade should be `await`ed, not chained via
    // `.then(...).catch(...)`. Use a generous 1000-char window to handle
    // the actual span (which can be 200+ chars due to logger.info body).
    const cascadeBlockMatch = src.match(
      /cascadeStopSessionTree[\s\S]{0,1000}?\.then\([\s\S]{0,1000}?\.catch\(/
    );
    expect(cascadeBlockMatch).toBeNull();
  });

  test("P1-3b: handleEscKey uses await for cascadeStopSessionTree (via Promise.race or direct await)", () => {
    const fs = require("fs");
    const src = fs.readFileSync(REPL_SRC, "utf8");
    // After the fix, the cascade must be `await`ed — either directly
    // (`await cascadeStopSessionTree(...)`) or via Promise.race([cascade..., ...])
    // so the handler doesn't return until the cascade settles.
    const hasDirectAwait = /await\s+cascadeStopSessionTree\(/.test(src);
    const hasRaceAwait = /await\s+Promise\.race\(\s*\[\s*cascadeStopSessionTree\(/.test(src);
    expect(hasDirectAwait || hasRaceAwait).toBe(true);
  });
});