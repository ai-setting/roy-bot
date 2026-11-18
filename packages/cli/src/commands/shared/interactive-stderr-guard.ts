/**
 * @fileoverview Task #4721 — `roy-bot interactive` 的 **stderr 守卫**。
 *
 * ## 为什么 core 侧改了还不够
 *
 * Task #4721 的 core 侧修复（commit f679f3a2）把 `logMigration` 从裸
 * `process.stderr.write` 改成了走 logger。但那只治了**已知的**那一个来源。
 * 交互式 TUI 里还有别的路径可能往 stderr 写：
 *
 *   - `OutputService.error()` / `errorDetailed()` → `console.error`
 *   - 任何第三方依赖直接 `console.error` / `process.stderr.write`
 *
 * 在 **opentui split-footer** 模式下，任何未经捕获的终端写入都会落在
 * **当前光标位置** —— 而光标在动态区（footer）里 ⇒ 与 TUI 重绘逐字符交错
 * ⇒ 底部残影（用户截图实证：`ig-ati-n 003 -tarting mig-ati-`）。
 *
 * ## 守卫做什么
 *
 * 在 `roy-bot interactive` mount TUI **之前**接管 stderr 通道：
 *   - `process.stderr.write` → 转 logger（写日志文件），**不再写终端**
 *   - `console.error` / `console.warn` → 同样转 logger
 *
 * 为什么不简单地「丢弃」：诊断信息不能丢 ⇒ 转 logger，app.log 里能查到。
 *
 * 为什么不动 stdout：opentui **已经**接管 stdout（`interceptStdoutWrite`）⇒
 * 它把输出写进 scrollback，语义是正确的（历史可见）；再包一层会破坏片4 的
 * write-once 契约。
 *
 * ## Bun 的 console 陷阱（实测，Task #4721）
 *
 * Bun 的 `console.log` / `console.error` **绕过** `process.stdout.write` /
 * `process.stderr.write`（Node 不会）。⇒ 只 patch `process.stderr.write`
 * **抓不到** `console.error`。所以守卫必须**同时**替换 console 方法。
 *
 * ## 为什么转发时临时关掉 quiet
 *
 * core 的 `Logger.log()` 在「非 quiet」模式下会把日志**再打到 console**。
 * 若守卫转发的内容又从 console 打回终端 ⇒ 乱流没修好还多了一层。
 * `Logger` 的写盘是**同步**的（`appendFileSync`）⇒ 临时改 quiet 标志的
 * 窗口在单线程事件循环里是零（中间没有 await）。
 *
 * @see packages/cli/src/commands/shared/interactive-stderr-guard.test.ts
 */

import { createLogger, isQuietMode, setQuietMode } from "@ai-setting/roy-bot-core";

const guardLogger = createLogger("interactive:stderr");

/** 单条记录的最大长度 —— 防止一次巨大的 stderr 写爆日志文件。 */
const MAX_RECORD_LENGTH = 4000;

/**
 * ★ Task #4721（交叉验证 MINOR-1）：**最近的若干条**被拦截的输出（内存环形缓冲）。
 *
 * ## 为什么需要
 *
 * 守卫把**整个会话**的 stderr/console 输出都吞进日志文件 ⇒ 用户在终端里
 * **看不到任何诊断信息** ⇒ 出了问题时无从排查。
 *
 * ⇒ 保留最近 N 条在内存里，退出时（或被调用时）可以取出来打到终端。
 *
 * 之所以是**内存**而不是文件：文件已经有了（logger 写 app.log）⇒
 * 内存那份的价值是「**能按需回放**」。
 */
const RECENT_BUFFER_SIZE = 50;

/** 最近的被拦截输出（环形缓冲，最新的在最后）。 */
const recentRecords: string[] = [];

/**
 * 取回最近的被拦截输出（用于退出时回放到终端 / 排查）。
 *
 * @param limit 最多返回几条（默认全部）
 */
export function getRecentGuardedOutput(limit?: number): string[] {
  if (limit === undefined) return [...recentRecords];
  return recentRecords.slice(-limit);
}

/** 清空最近输出缓冲（测试用）。 */
export function clearRecentGuardedOutput(): void {
  recentRecords.length = 0;
}

/**
 * 当前已安装守卫的 restore 函数（非空 = 已安装）。
 * 用来保证「重复 install 不会套娃」。
 */
let activeRestore: (() => void) | null = null;

/**
 * 把一段文本转交给 logger（**只落盘**，不回终端）。
 *
 * @param level 日志级别（error / warn）
 * @param channel 来源标记（stderr / console.error / …）
 * @param text 内容
 */
function forwardToLog(level: "error" | "warn" | "info", channel: string, text: string): void {
  const body = text.length > MAX_RECORD_LENGTH ? `${text.slice(0, MAX_RECORD_LENGTH)}…[TRUNCATED]` : text;
  // ★ Task #4721（MINOR-1）：留一份在内存里（环形缓冲），
  //   供退出时回放 / 排查（守卫本身不往终端写）。
  recentRecords.push(`[${channel}] ${body}`);
  if (recentRecords.length > RECENT_BUFFER_SIZE) recentRecords.shift();
  const wasQuiet = isQuietMode();
  // 写盘期间禁止 logger 回写 console —— 否则守卫内容会再次打到终端。
  if (!wasQuiet) setQuietMode(true);
  try {
    guardLogger[level](`[${channel}] ${body}`);
  } catch {
    /* 守卫绝不能因为日志失败而抛 */
  } finally {
    if (!wasQuiet) setQuietMode(wasQuiet);
  }
}

/**
 * 安装 stderr 守卫。
 *
 * @returns restore 函数 —— 调用它把 `process.stderr.write` / console 方法
 *          恢复成安装**前**的样子。可重复调用（幂等）。
 */
export function installStderrGuard(): () => void {
  // 幂等：已安装时直接返回同一个 restore，不再套娃。
  if (activeRestore) return activeRestore;

  const realWrite = process.stderr.write;
  const realConsoleError = console.error;
  const realConsoleWarn = console.warn;
  const realConsoleLog = console.log;
  const realConsoleInfo = console.info;

  // 重入保护：logger 写盘失败时它自己会用 console.error 报错，
  // 那个 console.error 又被守卫接管 ⇒ 若无此标志会无限递归。
  let inGuard = false;

  const forward = (level: "error" | "warn" | "info", channel: string, text: string): void => {
    if (inGuard) return;
    inGuard = true;
    try {
      forwardToLog(level, channel, text);
    } finally {
      inGuard = false;
    }
  };

  const guardedWrite = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    forward("error", "stderr", String(chunk));
    const cb = typeof encoding === "function" ? encoding : callback;
    if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as typeof process.stderr.write;

  process.stderr.write = guardedWrite;
  console.error = (...args: unknown[]) => {
    forward("error", "console.error", args.map((a) => String(a)).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    forward("warn", "console.warn", args.map((a) => String(a)).join(" "));
  };
  // ★ Task #4721（交叉验证 MAJOR-4）：**也接管 console.log / console.info**。
  //
  // 为什么必须接管：Bun 的 `console.log` **绕过** `process.stdout.write`
  // （Node 不会）⇒ opentui 的 stdout 拦截（`interceptStdoutWrite`）**抓不到**
  // 它 ⇒ `OutputService.info/success`（`packages/cli/src/services/output.service.ts:57,65,73`
  // 直接 `console.log`）在 TUI 运行期会**直写终端** ⇒ 底部残影。
  //
  // ⚠️ 这两条走 stdout 语义（本来应该进 scrollback = 历史可见）。
  //   但在 TUI 里，「历史可见」不是用户要的 —— 用户要的是**底部不乱**。
  //   ⇒ 统一转 logger（只落盘），保证终端一个字节都不受污染。
  console.log = (...args: unknown[]) => {
    forward("info", "console.log", args.map((a) => String(a)).join(" "));
  };
  console.info = (...args: unknown[]) => {
    forward("info", "console.info", args.map((a) => String(a)).join(" "));
  };

  const restore = (): void => {
    if (activeRestore !== restore) return;
    activeRestore = null;
    process.stderr.write = realWrite;
    console.error = realConsoleError;
    console.warn = realConsoleWarn;
    console.log = realConsoleLog;
    console.info = realConsoleInfo;
  };

  activeRestore = restore;
  return restore;
}

/**
 * 移除已安装的 stderr 守卫（没装过 = 空操作，不抛）。
 */
export function removeStderrGuard(): void {
  activeRestore?.();
}
