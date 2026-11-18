/**
 * @fileoverview Task #4983 R4 MINOR-2 — environment.ts 的 ContextError 启发式
 * 不得把 __ASK_USER_ERROR__ 载荷误判成 ContextError
 *
 * ## 背景（R3 DS review MINOR-2）
 *
 * environment.ts 的 handle_query 对 `result.error` 做
 * `includes("context"|"threshold"|"token")` 子串判断来识别上下文超限。
 * 而 #4983 之后 AskUserError 会编码成
 * `__ASK_USER_ERROR__:{"query":"<问题正文>",...}` —— **query 正文
 * 来自用户提问**。用户问句含 "context" / "token" / "阈值" 等词时，
 * 该错误会被错误地包装成 ContextError 抛出 ⇒
 *   - isAskUserError 不命中 ⇒ CLI 兜底投递不执行
 *   - ContextHandlerService 进入 compact 重试死循环（对 ask_user 毫无意义）
 *   - error-reply 当作「上下文超出限制」发失败回执（语义错）
 *
 * ## 修复契约
 *
 * `result.error` 以 `__ASK_USER_ERROR__:` 前缀开头 ⇒ **原样抛出**
 * （plain Error，与 environment.ts:551 其他错误的形态一致），
 * 跳过 ContextError 启发式。CLI 层 query-executor.parseAskUserErrorPayload
 * 仍能从 message 前缀识别出 ask_user ⇒ 兜底投递链路不断。
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { BaseEnvironment } from "./environment";
import { AgentComponent } from "./agent/agent-component";
import { ConfigComponent } from "../config/config-component";

/** 构造一个 run 结果带 __ASK_USER_ERROR__ 的 mock AgentComponent */
function makeEnvWithAskUserError(query: string): {
  env: BaseEnvironment;
  agentComponent: AgentComponent;
  runMock: ReturnType<typeof vi.fn>;
} {
  const env = new BaseEnvironment({ name: "test-env" });
  const configComponent = new ConfigComponent();
  const agentComponent = new AgentComponent();

  const payload = JSON.stringify({
    query,
    sessionId: "session_sub",
    nodeId: "node_1",
    nodeType: "agent",
    agentSessionId: undefined,
    delivered: true,
  });
  const runMock = vi.fn().mockResolvedValue({
    finalText: undefined,
    error: `__ASK_USER_ERROR__:${payload}`,
    originalError: undefined,
  });

  env.registerComponent(configComponent);
  // 用 mock 对象替换 run 行为（避免真实 LLM 调用）
  const mockAgentComponent = {
    name: "agent",
    version: "1.0.0",
    getStatus: () => "created" as const,
    stop: vi.fn(),
    getRegistry: () => ({
      get: vi.fn().mockReturnValue({ name: "default", type: "primary" }),
    }),
    getAgent: vi.fn().mockReturnValue({ name: "default", type: "primary" }),
    registerAgent: vi.fn().mockReturnValue({ name: "default", type: "primary", config: {} }),
    run: runMock,
  };
  // AgentComponent not found 检查走 getComponent("agent")
  env.registerComponent(mockAgentComponent as any);

  return { env, agentComponent, runMock };
}

describe("#4983 R4 MINOR-2 — __ASK_USER_ERROR__ 不被误判成 ContextError", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  // ------------------------------------------------------------------
  // M2-1：query 含 "context" / "token" / "threshold" 字样
  //       ⇒ 抛出的错误**不是** ContextError（原样透传）
  // ------------------------------------------------------------------
  test('M2-1: query 含 "context" 时抛出的错误不是 ContextError', async () => {
    const { env } = makeEnvWithAskUserError(
      "请总结一下 context window 的 token 计算方式，threshold 是多少？",
    );

    const err = await env
      .handle_query("anything", { sessionId: "s1" } as any)
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // 核心断言：**不能**是 ContextError（旧实现会误判）
    expect((err as any).code).not.toBe("CTX_001");
    expect(err.constructor.name).not.toBe("ContextError");
    // 且正文原样保留（CLI parseAskUserErrorPayload 还依赖前缀）
    expect(String((err as Error).message)).toContain("__ASK_USER_ERROR__:");
    expect(String((err as Error).message)).toContain("context window");
  });

  // ------------------------------------------------------------------
  // M2-2：对照——真实的 Context 超限错误**仍要**被识别成 ContextError
  //       （回归保护：分流只对 ask_user 前缀生效）
  // ------------------------------------------------------------------
  test("M2-2: 真实 Context threshold exceeded 错误仍被包装成 ContextError", async () => {
    const env = new BaseEnvironment({ name: "test-env-2" });
    const configComponent = new ConfigComponent();
    const runMock = vi.fn().mockResolvedValue({
      finalText: undefined,
      error: "Context threshold exceeded: 1230/10000 (12.3%)",
      originalError: undefined,
    });
    const mockAgentComponent = {
      name: "agent",
      version: "1.0.0",
      getStatus: () => "created" as const,
      stop: vi.fn(),
      getRegistry: () => ({
        get: vi.fn().mockReturnValue({ name: "default", type: "primary" }),
      }),
      getAgent: vi.fn().mockReturnValue({ name: "default", type: "primary" }),
      registerAgent: vi.fn().mockReturnValue({ name: "default", type: "primary", config: {} }),
      run: runMock,
    };
    env.registerComponent(configComponent);
    env.registerComponent(mockAgentComponent as any);

    const err = await env
      .handle_query("anything", { sessionId: "s2" } as any)
      .then(() => null)
      .catch((e) => e);

    // 旧有行为保持：识别成 ContextError（CTX_001）
    expect((err as any).code).toBe("CTX_001");
  });
});
