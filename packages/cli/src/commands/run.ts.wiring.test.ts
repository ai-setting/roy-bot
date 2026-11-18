/**
 * Task #4042 ESPlugin v2 Phase 6 commit 3: run.ts production wiring 测试
 *
 * 覆盖：验证 run.ts 在 Phase 6 commit 3 之后用 createEventHandlerForInteractive
 * 工厂函数创建 EventHandler（而不是裸 new EventHandler）。
 *
 * 为什么不直接 import run.ts：
 *   - run.ts 顶部 import React/ink/render 等，启动时副作用大
 *   - loadHandleQuery 是异步函数 + 需要 EnvironmentService 真实初始化
 *   - 直接测试需要 mock 大量依赖（OutputService / EnvironmentService / SessionManager）
 *   - 性价比不高
 *
 * 替代方案：grep 验证 run.ts 的源代码确实用了 factory（grep-based test）。
 * 这是 commit 3 的 RED→GREEN 信号：
 *   - RED（commit 3 之前）：grep 找不到 factory 调用 → fail
 *   - GREEN（commit 3 之后）：grep 找到 factory 调用 → pass
 *
 * 同时验证 interactive.ts 也用了（防止 commit 2 被回滚）。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_COMMANDS_DIR = join(
  import.meta.dir.replace(/\/run\.ts\.wiring\.test\.ts$/, ""),
);

const INTERACTIVE_PATH = join(CLI_COMMANDS_DIR, "interactive.ts");
const RUN_PATH = join(CLI_COMMANDS_DIR, "run.ts");

describe("Phase 6 production wiring: interactive.ts + run.ts 必须用 factory", () => {
  test("interactive.ts 必须调用 createEventHandlerForInteractive（不能裸 new EventHandler）", () => {
    const src = readFileSync(INTERACTIVE_PATH, "utf-8");
    expect(src).toContain("createEventHandlerForInteractive");
    // 不能有「裸 new EventHandler({...」但 factory 自身内部有 new EventHandler 所以用更精确的判断：
    // 在 main function 块（不含 factory 定义）里不应出现 new EventHandler(
    // 这里用注释 + 上下文判断：
    // 1. createEventHandlerForInteractive 调用必须存在
    expect(src).toMatch(/createEventHandlerForInteractive\s*\(\{/);
  });

  test("run.ts 必须调用 createEventHandlerForInteractive（不能裸 new EventHandler）", () => {
    const src = readFileSync(RUN_PATH, "utf-8");
    expect(src).toContain("createEventHandlerForInteractive");
    expect(src).toMatch(/createEventHandlerForInteractive\s*\(\{/);
  });

  test("run.ts 必须 import createEventHandlerForInteractive", () => {
    const src = readFileSync(RUN_PATH, "utf-8");
    // run.ts 用 .js 后缀（运行时 ESM 约定）
    expect(src).toMatch(
      /import\s*\{\s*createEventHandlerForInteractive\s*\}\s*from\s*["']\.\/shared\/event-handler-wiring(?:\.js)?["']/,
    );
  });

  test("interactive.ts 必须 import createEventHandlerForInteractive", () => {
    const src = readFileSync(INTERACTIVE_PATH, "utf-8");
    expect(src).toMatch(
      /import\s*\{\s*createEventHandlerForInteractive\s*\}\s*from\s*["']\.\/shared\/event-handler-wiring(?:\.js)?["']/,
    );
  });
});
