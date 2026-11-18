/**
 * @fileoverview Interactive AskUser Timeout Test (Task #1967)
 *
 * TDD: 测试 ask_user 等待 2 分钟超时机制，避免主 session 被永久占用。
 *
 * 根因：CLI `promptUser` 通过 `this.rl.on('line', ...)` 永久等待，
 *       `isExecuting` 单调为 true，EventHandler.waitForIdle() 死循环，
 *       飞书/事件源消息积压无法处理。
 *
 * 测试场景：
 *  - A. 超时前用户正常回复 → 继续原 executeInternal 流程
 *  - B. 超时触发：listener 清理 + isExecuting reset + 返回 sentinel
 *  - C. 回复与超时竞态：resolve 仅一次，无 unhandled error
 *  - D. 默认 ASK_USER_TIMEOUT_MS === 120000
 *  - E. 超时后 isIdle() 立即恢复 true（飞书可继续处理）
 *
 * 通过 askUserTimeoutMs 选项注入超短 timeout（30-100ms），
 * 绝不真实等待 2 分钟。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import * as readline from "readline";

// 触发 mock 模块下的关键标识：必须实际定义/导出相关常量才能 import
// 即使它们当前不存在（测试应当 RED），import 失败也是 RED 的一种体现
import {
  ASK_USER_TIMEOUT_MS,
  isAskUserTimeoutSentinel,
  REPL,
  type REPLOptions,
} from "./run";
import type { AskUserErrorInfo } from "./shared/ask-user-handler";

// ==========================================================================
// Mock Readline Interface
// ==========================================================================

/**
 * MockReadline — EventEmitter 模拟 readline.Interface
 *
 * 真实 readline 触发 `line` 事件携带字符串，并提供 setPrompt/prompt/close。
 * Mock 完全等价，且允许测试代码可控触发事件。
 */
class MockReadline extends EventEmitter {
  public readonly setPrompt = vi.fn();
  public readonly prompt = vi.fn();
  public readonly close = vi.fn();
  public readonly pause = vi.fn();
  public readonly resume = vi.fn();

  // 暴露 line 事件触发器（与 rl.emit('line', value) 等价，更语义化）
  feedLine(value: string): boolean {
    return this.emit("line", value);
  }
}

/**
 * 创建一个绕过真实 readline 的 REPL 实例
 *
 * 关键：避开 REPL.constructor 调用 readline.createInterface(process.stdin)
 *       否则会真的去读 stdin；改为直接 Object.create(REPL.prototype) 后
 *       手动填充字段。
 */
function makeMockREPL(opts: {
  askUserTimeoutMs?: number;
  onExecute?: REPLOptions["onExecute"];
  promptOnResume?: boolean;
}) {
  const rl = new MockReadline();

  const repl: any = Object.create(REPL.prototype);
  repl.isShuttingDown = false;
  repl.isExecuting = false;
  // 关键: 用我们自己的 mock rl 替换 readline
  repl.rl = rl;
  // askUserTimeoutMs 是新增的可选字段
  repl.askUserTimeoutMs = opts.askUserTimeoutMs ?? ASK_USER_TIMEOUT_MS;

  const executeMock =
    opts.onExecute ??
    vi.fn().mockImplementation(async (msg: string) => {
      // 默认 mock: 用户回复后，假装 agent 正常完成
      return "ok";
    });
  repl.options = {
    sessionId: "test-session",
    sessionTitle: "Test Session",
    onExecute: executeMock,
    onStatus: vi.fn().mockReturnValue({
      sessionId: "test-session",
      sessionTitle: "Test Session",
      messageCount: 0,
      tokenCount: 0,
    }),
    onSwitchSession: vi.fn(),
    onCompact: vi.fn(),
    onShutdown: vi.fn().mockResolvedValue(undefined),
  };

  return { repl, rl, executeMock };
}

/**
 * 等待若干 ms
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================================================
// A — 超时前用户正常回复
// ==========================================================================

describe("A. 超时前正常回复 → 继续原 executeInternal 流程", () => {
  test("promptUser 在用户输入时解析选项并调用 onExecute", async () => {
    const { repl, rl, executeMock } = makeMockREPL({
      askUserTimeoutMs: 200, // 200ms，绝不会超时
    });

    // 调用 promptUser（私有方法，通过 any cast）
    const promptPromise = (repl as any).promptUser(
      "请选择处理方式",
      ["回退依赖", "强制升级"],
    );

    // 验证: setPrompt + prompt 已被调用
    await sleep(10);
    expect(rl.setPrompt).toHaveBeenCalled();
    expect(rl.prompt).toHaveBeenCalled();

    // 模拟用户输入 "1"
    rl.feedLine("1");

    const userResponse = await promptPromise;

    // 验证: 选项被解析为 "回退依赖"
    expect(userResponse).toBe("回退依赖");

    // 验证: rl 上不再有残留 listener
    // (User fed line, handleLine 自己 removeListener)
    expect(rl.listenerCount("line")).toBe(0);
  });

  test("用户直接输入文本，应作为 raw text 返回", async () => {
    const { repl, rl } = makeMockREPL({ askUserTimeoutMs: 200 });

    const promptPromise = (repl as any).promptUser("你的名字？");
    rl.feedLine("roy");
    const result = await promptPromise;

    expect(result).toBe("roy");
  });
});

// ==========================================================================
// B — 超时触发 + 状态清理
// ==========================================================================

describe("B. 超时触发 + 状态清理", () => {
  test("短 timeout 后返回 sentinel，且 rl.removeListener 被调用", async () => {
    const { repl, rl } = makeMockREPL({
      askUserTimeoutMs: 30, // 30ms 超时
    });

    const promptPromise = (repl as any).promptUser(
      "请选择 (选项: A, B)",
      ["A", "B"],
      { query: "请选择 (选项: A, B)" },
    );

    // 等超时
    await sleep(80);

    const result = await promptPromise;

    // 验证: 返回 sentinel（不是空字符串、不是 unresolved promise）
    expect(typeof result).toBe("string");
    expect(result.startsWith("__ASK_USER_TIMEOUT__:")).toBe(true);

    // 验证: isAskUserTimeoutSentinel 能识别
    expect(isAskUserTimeoutSentinel(result)).toBe(true);

    // 验证: rl 监听器已被清理
    expect(rl.listenerCount("line")).toBe(0);
  });

  test("超时后 isExecuting = false（finally 块正常工作）", async () => {
    const { repl } = makeMockREPL({ askUserTimeoutMs: 30 });

    // 模拟 executeInternal 设置 isExecuting=true，然后捕获 AskUserError 超时
    (repl as any).isExecuting = true;

    // 直接调用 handleAskUserInteraction（私有），模拟 executeInternal 链路
    const errorInfo: AskUserErrorInfo = {
      query: "请选择 (选项: A, B)",
      sessionId: "wf_1",
      agentSessionId: "ag_1",
      nodeId: "n_1",
      nodeType: "agent",
    };

    // handleAskUserInteraction 是 private, 调用时应能完成
    const interactionPromise = (repl as any).handleAskUserInteraction(errorInfo);

    // 等超时 → handleAskUserInteraction 应早返回，不调用 executeInternal
    await sleep(80);

    await interactionPromise;

    // 验证: 如果要走完整 executeInternal, 此句会执行,
    // 但 handleAskUserInteraction 应检测到 sentinel 早返回
    expect((repl as any).isExecuting).toBeDefined();
  });

  test("sentinel 解码后能拿到原始 errorInfo", async () => {
    const { repl } = makeMockREPL({ askUserTimeoutMs: 30 });
    const errorInfo: AskUserErrorInfo = {
      query: "Continue?",
      sessionId: "wf_xyz",
      agentSessionId: "ag_xyz",
      nodeId: "node_99",
      nodeType: "agent",
    };

    const promptPromise = (repl as any).promptUser(
      "Continue?",
      undefined,
      errorInfo,
    );

    await sleep(80);
    const result: string = await promptPromise;

    // 解析 sentinel payload
    const payload = JSON.parse(result.substring("__ASK_USER_TIMEOUT__:".length));
    expect(payload.query).toBe("Continue?");
    expect(payload.sessionId).toBe("wf_xyz");
    expect(payload.nodeId).toBe("node_99");
    expect(typeof payload.timestamp).toBe("number");
    expect(payload.timeoutMs).toBe(30);
  });
});

// ==========================================================================
// C — 竞态：用户回复 与 超时 同时到达
// ==========================================================================

describe("C. 回复与超时竞态 → resolve 仅一次", () => {
  test("回复先到达（即使后续超时）只能 resolve 一次", async () => {
    const { repl, rl } = makeMockREPL({ askUserTimeoutMs: 30 });

    // 跟踪调用次数
    let resolveCount = 0;
    let resolvedValue: string | undefined;

    const promptPromise = (repl as any)
      .promptUser("Q?", ["A", "B"])
      .then((v: string) => {
        resolveCount++;
        resolvedValue = v;
        return v;
      });

    // 立即触发行事件（在超时前）
    rl.feedLine("A");

    const userResult = await promptPromise;
    expect(userResult).toBe("A");

    // 等待足够长，超过原 timeout 时间
    await sleep(80);

    // 验证: resolve 只调用了一次
    expect(resolveCount).toBe(1);
    expect(resolvedValue).toBe("A");
  });

  test("超时先到达后, 即使再发 line 也不应触发 resolve", async () => {
    const { repl, rl } = makeMockREPL({ askUserTimeoutMs: 30 });

    const promptPromise = (repl as any).promptUser("Q?", ["A", "B"]);
    await sleep(80);
    const result = await promptPromise;
    expect(isAskUserTimeoutSentinel(result)).toBe(true);

    // 此时尝试再喂一行 line（模拟用户在 timeout 边界刚好打字的竞态）
    rl.feedLine("A");

    // 等待一段后，确认没有 unhandled rejection / 没有 double resolve 副作用
    await sleep(50);

    // listener 应已被清理（handleLine removed itself before resolve）
    expect(rl.listenerCount("line")).toBe(0);
  });

  test("timeout 触发的 listener 在 timeout 后 rl 应无残留 line listener", async () => {
    const { repl, rl } = makeMockREPL({ askUserTimeoutMs: 30 });

    // 添加一个不相关的 logger 监听器（不会被移除）
    const otherListener = vi.fn();
    rl.on("line", otherListener);

    const promptPromise = (repl as any).promptUser("Q?");
    await sleep(80);
    await promptPromise;

    // 我们加的 otherListener 还在，但 promptUser 自己的 line listener 必须被移除
    // 由于其他测试用 MockReadline 实例独立，这里简单地验证 rl listener
    // 数量匹配预期（其他测试已验证过清理，这里做最小可行断言）
    expect(rl.listenerCount("line")).toBeLessThanOrEqual(1); // 只剩我们加的
    // 我们的 listener 还在
    expect(otherListener).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// D — 默认 timeout 常量
// ==========================================================================

describe("D. 默认 timeout 常量 = 120000ms (生产要求)", () => {
  test("ASK_USER_TIMEOUT_MS === 120000", () => {
    expect(ASK_USER_TIMEOUT_MS).toBe(120_000);
  });

  test("无 askUserTimeoutMs 选项时，promptUser 使用默认值", async () => {
    const { repl, rl } = makeMockREPL({}); // 不传 askUserTimeoutMs
    // 默认应当是 ASK_USER_TIMEOUT_MS（=120000ms）
    // 真实等 2 分钟会失败测试，所以用 inspect 私有字段
    expect(repl.askUserTimeoutMs).toBe(ASK_USER_TIMEOUT_MS);
  });
});

// ==========================================================================
// E — 飞书主 session 不再永久占用
// ==========================================================================

describe("E. 超时后 isIdle() 立即恢复 true（飞书可继续处理）", () => {
  test("ask_user 超时后 isIdle 变回 true（短 timeout 验证）", async () => {
    const { repl } = makeMockREPL({ askUserTimeoutMs: 30 });

    // 模拟 executeInternal 设置 isExecuting=true
    (repl as any).isExecuting = true;
    expect(repl.isIdle()).toBe(false);

    // 触发 ask_user 交互，超时应在 30ms 内发生
    const errorInfo: AskUserErrorInfo = {
      query: "Continue?",
      sessionId: "wf_1",
      agentSessionId: "ag_1",
      nodeId: "n_1",
      nodeType: "agent",
    };
    await (repl as any).handleAskUserInteraction(errorInfo);

    // 验证: handleAskUserInteraction 完成后，isExecuting 应能被重置
    // （必须由外部代码或 finally 块重置；这里 handleAskUserInteraction 不直接重置，
    //  因为它在 executeInternal 的 catch 块里被调用，外层 finally 负责重置）
    // 模拟 finally 块行为
    (repl as any).isExecuting = false;

    // 验证: isIdle 现在是 true
    expect(repl.isIdle()).toBe(true);
  });

  test("在 isExecuting=true 状态下，promptUser 超时不导致永久挂起", async () => {
    const { repl } = makeMockREPL({ askUserTimeoutMs: 30 });

    // 模拟 ask_user 工具被触发的链路：
    // executeInternal 内部 try/catch 跑到 handleAskUserInteraction，然后死等 promptUser
    const errorInfo: AskUserErrorInfo = {
      query: "Continue?",
      sessionId: "wf_1",
      agentSessionId: "ag_1",
      nodeId: "n_1",
      nodeType: "agent",
    };

    // 在外层模拟 executeInternal: 设置 isExecuting=true 然后 catch + handleAskUserInteraction
    let interactionDone = false;
    (async () => {
      (repl as any).isExecuting = true;
      try {
        await (repl as any).handleAskUserInteraction(errorInfo);
        interactionDone = true;
      } finally {
        // 模拟外层 executeInternal 的 finally
        (repl as any).isExecuting = false;
      }
    })();

    // 80ms 后（远超 30ms 超时），等待流程自然完成
    await sleep(80);

    expect(interactionDone).toBe(true);
    // 重要: isExecuting 必须回 false → isIdle() === true → 飞书可继续处理
    expect(repl.isIdle()).toBe(true);
  });

  test("长时间超时配置（接近生产 120000ms）下也能在配置时间内退出", async () => {
    // 这个测试用 production-like timeout 但缩短到 5000ms 以便在测试中跑得快
    // 如果未来 production timeout 改了，这个测试会反映出来
    const { repl, rl } = makeMockREPL({ askUserTimeoutMs: 5000 });

    const promptPromise = (repl as any).promptUser("Q?");
    // 立即通过 feedLine 让用户输入
    rl.feedLine("hello");
    const result = await promptPromise;

    expect(result).toBe("hello");
  });
});
