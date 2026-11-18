/**
 * @fileoverview Task #4634 — chat 命令的 `--model` / `--fallback-model` 必须
 * 真正到达 `env.handle_query` 的 AgentContext。
 *
 * ## 为什么要这个文件（以及它曾经抓到的真 bug）
 *
 * `chat.ts` 声明了 `--model`，但**只把它传给 `<ChatScreen model={...}>`**——
 * 那是纯 UI 显示。真正跑 agent 的 `env.handle_query(message, context)` 里
 * **根本没有 model 字段** ⇒ `roy-bot chat "..." --model X` 下的 `--model`
 * 实际**不生效**（chat 与 act/interactive/run 语义不一致）。
 *
 * 这个 bug 用 `--help` 或 grep 都发现不了：option 声明在、参数被接收了，
 * 只是没往下游传。只有**捕获下游实际收到的 context** 才能钉住。
 *
 * ## 测试手法
 *
 * 直接调 `loadHandleQuery()`（Task #4634 为此导出），用 `mock.module()`
 * 把 EnvironmentService 换成假 env，其 `handle_query` 把第 2 个参数
 * （AgentContext）记录下来。
 *
 * 为什么不用 `ChatCommand.handler`：handler 会 `render()` 挂 Ink 并
 * `await waitUntilExit()` —— 单测里会**挂住**（实测 bun test 超时）。
 * `loadHandleQuery` 是 handler 的前半段（建 env / session / EventHandler），
 * 里面跑的**全是真实生产代码**，接线逻辑
 * （`buildModelAgentContext(options)` → context）被完整覆盖。
 *
 * ⚠️ 关于 `mock.module` 的作用域（交叉验证 MINOR 3）：
 *   bun 的 `mock.module` 是**进程级**的全局替换，同进程内后续加载该模块的
 *   代码都会拿到替身。本文件只替换 4 个模块，且替换目标都是「本文件自己
 *   会 import 的」——`chat.ts` 是本文件唯一的被测对象。
 *   实测组合跑（chat-model-flags.test.ts + packages/cli/src/services/*）
 *   163 pass / 0 fail，未观察到泄漏。
 *   若将来本文件被拆成多文件共享替身，请改成依赖注入而非全局 mock。
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// 捕获 env.handle_query 收到的 AgentContext
// ---------------------------------------------------------------------------

const capturedContexts: any[] = [];

const fakeEnv: any = {
  handle_query: async (_message: string, context: any) => {
    capturedContexts.push(context);
    return "ok";
  },
  getComponent: (_name: string) => undefined,
  getComponentSafe: (_name: string) => undefined,
};

mock.module("../services/environment.service", () => ({
  EnvironmentService: class {
    constructor(_output: any) {}
    async create(_options?: any) {
      return fakeEnv as any;
    }
    getEnvironment() {
      return fakeEnv as any;
    }
    getSession() {
      return undefined;
    }
    getLLM() {
      return undefined;
    }
    async dispose() {}
  },
}));

// ---------------------------------------------------------------------------
// 替掉 session 创建（真实 session 会写用户的 session store）
// ---------------------------------------------------------------------------

mock.module("./shared/chat-session.js", () => ({
  createChatSession: async () => ({
    sessionId: "session_task4634",
    title: "Task4634",
  }),
  waitForBackgroundTasks: async () => undefined,
  probeUnfinishedTasks: async () => ({ hasAnyTask: false, unfinished: false }),
  DEFAULT_CHAT_WAIT_TIMEOUT_MS: 1000,
}));

mock.module("./shared/chat-event-handler.js", () => ({
  createChatEventHandlers: () => ({
    stop: async () => undefined,
    isBusy: () => false,
  }),
}));

mock.module("./shared/cli-trigger-event.js", () => ({
  emitCliTriggerEvent: async () => null,
  toCliEnvEvent: () => undefined,
  formatTriggerEcho: () => "",
  writeTriggerEcho: () => undefined,
}));

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

async function runChatOnce(options: Record<string, any>) {
  capturedContexts.length = 0;
  const { loadHandleQuery } = await import("./chat.js");
  const { handleQuery } = await loadHandleQuery({
    message: "hello",
    markdown: true,
    maxLines: "500",
    ...options,
  } as any);
  await handleQuery("hello");
  return capturedContexts[capturedContexts.length - 1];
}

describe("Task #4634 — chat 的 --model / --fallback-model 到达 AgentContext", () => {
  test("两个 flag 都给 → handle_query 的 context 里两个都有", async () => {
    const ctx = await runChatOnce({
      model: "opencodego/primary",
      fallbackModel: "opencodego/backup",
    });
    expect(ctx.model).toBe("opencodego/primary");
    expect(ctx.fallbackModel).toBe("opencodego/backup");
  });

  test("只给 --model → fallbackModel 不出现在 context 里", async () => {
    const ctx = await runChatOnce({ model: "opencodego/primary" });
    expect(ctx.model).toBe("opencodego/primary");
    expect("fallbackModel" in ctx).toBe(false);
  });

  test("只给 --fallback-model → model 不出现在 context 里", async () => {
    const ctx = await runChatOnce({ fallbackModel: "opencodego/backup" });
    expect(ctx.fallbackModel).toBe("opencodego/backup");
    expect("model" in ctx).toBe(false);
  });

  test("都不给 → context 里两个 key 都不存在", async () => {
    const ctx = await runChatOnce({});
    expect("model" in ctx).toBe(false);
    expect("fallbackModel" in ctx).toBe(false);
  });
});
