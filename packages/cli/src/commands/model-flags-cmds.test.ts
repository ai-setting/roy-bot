/**
 * @fileoverview Task #4634 — `--model` / `--fallback-model` 在 interactive / run / chat
 * 三个命令下必须真正到达 agent。
 *
 * ## 用户需求（飞书群聊 2026-10-29 14:06，原话）
 *
 * > 对了，`--model`，`--fallback-model` 参数在 **interactive 和 run 命令下也要生效**哈
 *
 * ## ⚠️ 命名陷阱（本文件最大的坑）
 *
 * 本仓库的文件名与注册的命令名现已**一致**（Task #4674 对调后）：
 *
 * | 文件 | 注册的命令名 | aliases | UI 实现 |
 * |---|---|---|---|
 * | `packages/cli/src/commands/interactive.ts` | **`interactive`** | — | opentui/Solid |
 * | `packages/cli/src/commands/run.ts` | **`run`** | `i` / `repl` | Ink (`ChatTui`) |
 *
 * 所以：
 * - 用户敲 `roy-bot interactive` → 执行 **`interactive.ts`**（opentui TUI）
 * - 用户敲 `roy-bot run`（或 `i` / `repl`）→ 执行 **`run.ts`**（Ink REPL）
 *
 * > Task #4674 之前文件名是反的（`run.ts` 注册 `interactive`、
 * > `interactive.ts` 注册 `run`）。本表已随对调更新；若再看到「命令名是反的」
 * > 的旧描述，说明对调被回退了。
 *
 * ## 本文件覆盖什么
 *
 * 三层断言，从「声明」到「到达 agent」：
 *
 * 1. **option 声明层**：三个命令的 yargs builder 都声明了 `--fallback-model`
 *    （yargs 会自动把 `fallback-model` 映射成 `argv.fallbackModel`）
 * 2. **接线层（行为断言）**：命令真正把 `model` / `fallbackModel` 放进
 *    AgentContext —— 通过捕获下游收到的 context 对象来断言，
 *    而不是 grep 源码（grep 无法区分「声明了」和「真的传下去了」）
 * 3. **传递链**：`interactive`（注册名 interactive）走 `createStreamHandleQuery` →
 *    `queryExecutor.execute(..., mergedContext)`；`run`（注册名 run）
 *    走 `mergedContext` → `exec.execute(..., mergedContext)`；
 *    `chat` 走 `env.handle_query(message, context)`
 *
 * ## 为什么用「捕获下游 context」而不是 mock 整个 handler
 *
 * `run.ts` / `interactive.ts` / `chat.ts` 的 handler 都会起真实 env（EnvironmentService
 * / EnvironmentService.create）并挂 Ink，测试里跑不动。真正稳定的接缝是：
 *
 * - `createStreamHandleQuery(queryExecutor, sessionId, options, agentContext, prompt)`
 *   —— 纯函数，传入一个 stub executor 就能捕获它最终传给 `execute()` 的第 5 个参数
 * - `chat.ts` 的 `env.handle_query` —— 通过 mock.module 替换 EnvironmentService
 *
 * 这两处都是**真实生产代码路径**，不是复制品。
 */

import { describe, expect, test } from "bun:test";

import { createStreamHandleQuery, type RunOptions } from "./interactive";

// ---------------------------------------------------------------------------
// 断言 1：option 声明层
// ---------------------------------------------------------------------------

/**
 * 捕获 yargs builder 声明的所有 option 名。
 *
 * 注意：yargs 运行时会给**未声明**的 flag 也填上 key（`argv.fallbackModel` 可能
 * 来自 camel-case 展开），所以**不能**只断言 `argv.fallbackModel` 有值 —— 那样
 * 会假绿。这里断言的是 builder **显式声明**的 option 名集合。
 */
function captureDeclaredOptions(builder: any): Set<string> {
  const names = new Set<string>();
  const yargs = {
    option(name: string, _config: any) {
      names.add(name);
      return yargs;
    },
    // chat.ts 的 builder 先调 .positional() 再 .option()
    positional(name: string, _config: any) {
      names.add(name);
      return yargs;
    },
    // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)
    //   （校验非法的 --fallback-model 取值）。这里只需要桩 —— 本文件
    //   只关心 option 名集合，不关心校验行为。
    check(_fn: any) {
      return yargs;
    },
  };
  builder(yargs);
  return names;
}

describe("Task #4634 — option 声明层", () => {
  test("run.ts（注册名 run）声明 --model 与 --fallback-model", async () => {
    // Task #4674: `InteractiveCommand` 住在 `commands/run.ts`
    const { InteractiveCommand } = await import("./run.js");
    const names = captureDeclaredOptions(InteractiveCommand.builder);
    expect(names.has("model")).toBe(true);
    expect(names.has("fallback-model")).toBe(true);
  });

  test("interactive.ts（注册名 interactive）声明 --model 与 --fallback-model", async () => {
    // Task #4674: `RunCommand` 住在 `commands/interactive.ts`
    const { RunCommand } = await import("./interactive.js");
    const names = captureDeclaredOptions(RunCommand.builder);
    expect(names.has("model")).toBe(true);
    expect(names.has("fallback-model")).toBe(true);
  });

  test("chat.ts 声明 --model 与 --fallback-model", async () => {
    const { ChatCommand } = await import("./chat.js");
    const names = captureDeclaredOptions(ChatCommand.builder);
    expect(names.has("model")).toBe(true);
    expect(names.has("fallback-model")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 断言 2：接线层 —— interactive.ts（注册名 interactive）
// ---------------------------------------------------------------------------

/**
 * 最小 QueryExecutor stub：只实现 createStreamHandleQuery 用到的那几个方法，
 * 并把 `execute()` 收到的第 5 个参数（agentContext）记录下来。
 */
function makeContextCapturingExecutor() {
  const captured: { context: any } = { context: undefined };
  return {
    captured,
    setChunkCallback() {},
    async execute(
      _message: string,
      _sessionId: string,
      _opts: any,
      _traceId: any,
      agentContext: any,
    ) {
      captured.context = agentContext;
      return "reply";
    },
  };
}

describe("Task #4634 — interactive.ts（注册名 interactive）接线层", () => {
  test("createStreamHandleQuery 把 model 与 fallbackModel 放进 AgentContext", async () => {
    const exec = makeContextCapturingExecutor();
    const options = {
      model: "opencodego/primary-model",
      fallbackModel: "opencodego/backup-model",
      reasoning: false,
      // ★ 避免测试往用户真实 event-store.db 写脏行
      //   （Task #4588 引入的测试注入口；生产不设）
      triggerEventDbPath: "/tmp/task4634-event-store-test.db",
    } as unknown as RunOptions;

    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      options,
      undefined,
      undefined,
    );
    await query("hi", () => {});

    // AgentContext.model —— 主模型
    expect(exec.captured.context?.model).toBe("opencodego/primary-model");
    // AgentContext.fallbackModel —— 兜底模型（Task #4634 核心诉求）
    expect(exec.captured.context?.fallbackModel).toBe("opencodego/backup-model");
  });

  test("未指定 fallbackModel 时不注入该字段（保持 undefined）", async () => {
    const exec = makeContextCapturingExecutor();
    const options = {
      model: "opencodego/only",
      reasoning: false,
      triggerEventDbPath: "/tmp/task4634-event-store-test.db",
    } as unknown as RunOptions;

    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      options,
      undefined,
      undefined,
    );
    await query("hi", () => {});

    expect(exec.captured.context?.model).toBe("opencodego/only");
    expect(exec.captured.context?.fallbackModel).toBeUndefined();
  });
});
