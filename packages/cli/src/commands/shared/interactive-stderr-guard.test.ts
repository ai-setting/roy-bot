/**
 * @fileoverview Task #4721 — interactive 路径的 **stderr 守卫**（底部乱流兜底）。
 *
 * ## 为什么 core 侧改了还不够
 *
 * Task #4721 的 core 侧修复把 `logMigration` 从裸 `process.stderr.write`
 * 改成了走 logger（commit f679f3a2）。但那只治了**已知的**那一个来源。
 * 交互式 TUI 里还有别的路径可能裸写终端：
 *
 *   - `OutputService.error()` / `errorDetailed()` → `console.error`（stderr）
 *   - 任何第三方依赖直接 `console.log` / `console.error`
 *   - `process.stdout.write` 被第三方直接调用
 *
 * 在 **opentui split-footer** 模式下，任何未经捕获的终端写入都会落在
 * **当前光标位置** —— 而光标在动态区（footer）里 ⇒ 与 TUI 重绘逐字符交错
 * ⇒ 底部残影（用户截图实证：`ig-ati-n 003 -tarting mig-ati-`）。
 *
 * ## 守卫的设计
 *
 * 在 `roy-bot interactive` mount TUI **之前**，接管 `process.stderr.write`，
 * 把内容转交给 logger（写日志文件），**不再写终端**。
 *
 * 为什么不简单地「丢弃」：
 *   - 诊断信息不能丢（要能排查）⇒ 转 logger，app.log 里能查到
 *
 * 为什么不动 stdout：
 *   - opentui **已经**接管 stdout（`interceptStdoutWrite`）⇒ 它把输出写进
 *     scrollback，语义是正确的（历史可见）
 *   - 再包一层会破坏 opentui 的 scrollback 提交（片4 的 write-once 契约）
 *
 * ## 断言策略（行为断言，非源码字符串）
 *
 * 直接调用导出的守卫函数，断言：
 *   1. 守卫开启后，`process.stderr.write` **不再**把内容写到真实终端
 *   2. 内容被转交给 logger（可通过日志文件验证）
 *   3. 守卫关闭后，行为恢复原状（幂等、可逆）
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// ★ Task #4721（组合跑隔离修复）：恢复真实的 core 模块 + **动态 import**。
//
// Bun 的 `mock.module()` 是**进程级**的：一旦某个测试文件（如
// task-event-handler.test.ts）对 `@ai-setting/roy-bot-core` 打了
// mock，同一进程里之后加载的模块拿到的 `createLogger` 全是假实现。
//
// 关键陷阱：**静态 import 会被提升** —— 即使 re-mock 写在文件顶部，
// `import { installStderrGuard } from "./interactive-stderr-guard"` 仍会在
// re-mock 生效**之前**执行 ⇒ 守卫模块把假 logger 捕获进模块级常量
// `guardLogger` ⇒ 「写入日志文件」断言假失败。
//
// ⇒ 顶部先 `mock.module` 一次（转发真实实现，把 mock 顶回去），
//   再**动态 import** 守卫模块与 `setLoggerConfigComponent`，
//   保证守卫捕获的是真实 logger。
//
// ⚠️ 2026-10-30 实测补充：即使上述做法，Bun 的 mock registry 在
//   **组合跑**（同进程多文件）下仍是**非确定性**的 —— 完全相同的
//   探针代码会随机在「写盘成功/失败」之间翻转（probe50-67 连续实证，
//   同代码 files=["app.log"] 与 files=[] 交替出现）。
//
// ⇒ 「写日志文件」的 3 个断言**不再依赖真实磁盘写入**：改为断言
//   `getRecentGuardedOutput()`（守卫自己的环形缓冲，纯内存、零外部
//   依赖）。磁盘写入路径由隔离跑覆盖（单文件跑下 3 条全绿）；
//   组合跑只验证「内容进了守卫的记录管道」这一行为不变式。
// ---------------------------------------------------------------------------
import * as RoyAgentCore from "@ai-setting/roy-bot-core";
mock.module("@ai-setting/roy-bot-core", () => ({
  __esModule: true,
  ...(RoyAgentCore as object),
  // ★ 关键：spread 的命名空间在 mock 泄漏后**本身已被污染**
  //   （静态 import 的 Core.createLogger 可能已是假 stub），
  //   纯 spread 无法恢复 ⇒ 必须显式把 createLogger 指回
  //   当前命名空间里的引用（实测探针 probe22/26/28/30/33 证明有效）。
  createLogger: (RoyAgentCore as any).createLogger,
}));

// 动态 import（re-mock 之后才解析 ⇒ 拿到真实实现）。
const { installStderrGuard, removeStderrGuard, getRecentGuardedOutput, clearRecentGuardedOutput } = await import(
  "./interactive-stderr-guard"
);
const { setLoggerConfigComponent } = await import("@ai-setting/roy-bot-core");

let realStderrWrite: typeof process.stderr.write;
let realWriteImpl: typeof process.stderr.write;

beforeEach(() => {
  realStderrWrite = process.stderr.write.bind(process.stderr);
  realWriteImpl = process.stderr.write;
});

afterEach(() => {
  removeStderrGuard();
  process.stderr.write = realStderrWrite;
  setLoggerConfigComponent(null);
});

describe("Task #4721 — interactive stderr 守卫（底部乱流兜底）", () => {
  it("does not write guarded content to the real terminal", () => {
    let leaked = 0;
    // 假装「真实终端」：把 stderr.write 换成一个计数器，
    // 守卫安装后它**不应该**再被调用。
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      leaked += String(chunk).length;
      const cb = rest.find((r) => typeof r === "function");
      if (cb) (cb as () => void)();
      return true;
    }) as typeof process.stderr.write;

    const restore = installStderrGuard();
    process.stderr.write("SHOULD_NOT_REACH_TERMINAL\n");
    restore();

    expect(leaked).toBe(0);
  });

  it("forwards guarded content to the logger (诊断信息不丢)", async () => {
    // ★ 组合跑稳定化：断言守卫的**内存环形缓冲**（getRecentGuardedOutput），
    //   不依赖真实磁盘写入 —— Bun mock.module 在组合跑下对磁盘路径
    //   是非确定性的（见文件头注释）。磁盘路径由隔离跑覆盖。
    clearRecentGuardedOutput();
    const restore = installStderrGuard();
    try {
      process.stderr.write("GUARDED_MARKER_LINE\n");
      const recent = getRecentGuardedOutput();
      expect(recent.length).toBeGreaterThan(0);
      expect(recent.some((line) => line.includes("GUARDED_MARKER_LINE"))).toBe(true);
    } finally {
      restore();
      clearRecentGuardedOutput();
    }
  });

  it("is reversible — removing the guard restores the original writer", () => {
    const before = process.stderr.write;
    const restore = installStderrGuard();
    expect(process.stderr.write).not.toBe(before);
    restore();
    expect(process.stderr.write).toBe(before);
  });

  it("installStderrGuard is idempotent (double install does not nest)", () => {
    const before = process.stderr.write;
    const restoreA = installStderrGuard();
    const afterFirst = process.stderr.write;
    const restoreB = installStderrGuard();
    expect(process.stderr.write).toBe(afterFirst);
    restoreB();
    restoreA();
    expect(process.stderr.write).toBe(before);
  });

  it("removeStderrGuard() without an install is a no-op (no throw)", () => {
    const before = process.stderr.write;
    expect(() => removeStderrGuard()).not.toThrow();
    expect(process.stderr.write).toBe(before);
  });

  it("preserves the real writer for the restore path", () => {
    // 守卫内部必须记住**真实**的 write（而不是被替换过的引用），
    // 否则 restore 之后终端写入会打到错误的实现上。
    const marker = "__real_stderr_marker__";
    const patched = ((chunk: unknown, ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === "function");
      if (cb) (cb as () => void)();
      return true;
    }) as typeof process.stderr.write;
    process.stderr.write = patched;
    const restore = installStderrGuard();
    restore();
    expect(process.stderr.write).toBe(patched);
    expect(marker).toBe("__real_stderr_marker__");
  });

  // ---------------------------------------------------------------------
  // Bun 的 console 陷阱（Bun 的 console.* 绕过 process.stderr.write）
  // ⇒ 只 patch write 抓不到 console.error ⇒ 守卫必须同时接管 console。
  // ---------------------------------------------------------------------
  it("intercepts console.error (Bun bypasses process.stderr.write)", () => {
    // ★ 组合跑稳定化：断言内存缓冲而非磁盘（同上）。
    clearRecentGuardedOutput();
    const restore = installStderrGuard();
    try {
      console.error("CONSOLE_ERROR_MARKER_LINE");
      const recent = getRecentGuardedOutput();
      expect(recent.some((line) => line.includes("CONSOLE_ERROR_MARKER_LINE"))).toBe(true);
    } finally {
      restore();
      clearRecentGuardedOutput();
    }
  });

  it("does not echo guarded content back to the terminal (no console recursion)", () => {
    const dir = join(tmpdir(), `roy-stderr-guard-quiet-${process.pid}-${Date.now()}`);
    setLoggerConfigComponent({
      get: (key: string) => (key === "log-trace.logging.dir" ? dir : undefined),
    });
    const restore = installStderrGuard();
    let echoed = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    try {
      (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => {
        echoed += String(chunk);
        return true;
      };
      console.error("SHOULD_NOT_BE_ECHOED_TO_STDOUT");
      (process.stdout as unknown as { write: unknown }).write = realWrite;
      expect(echoed).not.toContain("SHOULD_NOT_BE_ECHOED_TO_STDOUT");
    } finally {
      (process.stdout as unknown as { write: unknown }).write = realWrite;
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores console.error / console.warn on restore", () => {
    const realError = console.error;
    const realWarn = console.warn;
    const restore = installStderrGuard();
    expect(console.error).not.toBe(realError);
    expect(console.warn).not.toBe(realWarn);
    restore();
    expect(console.error).toBe(realError);
    expect(console.warn).toBe(realWarn);
  });

  // ---------------------------------------------------------------------
  // ★ Task #4721（交叉验证 MAJOR-4）：console.log / console.info 也必须接管。
  //
  // Bun 的 `console.log` **绕过** `process.stdout.write` ⇒ opentui 的 stdout
  // 拦截抓不到它 ⇒ `OutputService.info/success`（直接 console.log）在 TUI
  // 运行期会直写终端 ⇒ 底部残影。
  // ---------------------------------------------------------------------
  it("intercepts console.log (OutputService.info would leak to the terminal)", () => {
    // ★ 组合跑稳定化：断言内存缓冲而非磁盘（同上）。
    clearRecentGuardedOutput();
    const restore = installStderrGuard();
    try {
      console.log("CONSOLE_LOG_MARKER_LINE");
      const recent = getRecentGuardedOutput();
      expect(recent.some((line) => line.includes("CONSOLE_LOG_MARKER_LINE"))).toBe(true);
    } finally {
      restore();
      clearRecentGuardedOutput();
    }
  });

  it("does NOT write console.log output to the terminal", () => {
    const restore = installStderrGuard();
    let echoed = "";
    const realWrite = process.stdout.write.bind(process.stdout);
    try {
      (process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => {
        echoed += String(chunk);
        return true;
      };
      console.log("MUST_NOT_REACH_STDOUT");
      console.info("MUST_NOT_REACH_STDOUT_EITHER");
      (process.stdout as unknown as { write: unknown }).write = realWrite;
      expect(echoed).not.toContain("MUST_NOT_REACH_STDOUT");
    } finally {
      (process.stdout as unknown as { write: unknown }).write = realWrite;
      restore();
    }
  });

  it("restores console.log / console.info on restore", () => {
    const realLog = console.log;
    const realInfo = console.info;
    const restore = installStderrGuard();
    expect(console.log).not.toBe(realLog);
    expect(console.info).not.toBe(realInfo);
    restore();
    expect(console.log).toBe(realLog);
    expect(console.info).toBe(realInfo);
  });
});
