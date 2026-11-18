/**
 * @fileoverview AgentComponent — compact_session 豁免外层 120s 工具硬超时（Task #5053）
 *
 * 背景：
 *   `compact_session` 工具内部会跑**两次完整 LLM 调用**
 *   （`generateCompactHint()` 起 compact-hint agent + `compact()` 起 compact agent），
 *   两次都要把全量 history 喂给 LLM。因此耗时随 **session 消息条数** 线性增长，
 *   本质上无法在 120s 内保证完成。
 *
 *   实测（Task #5053 调研）：
 *     - #5041：97k tokens / 69 条消息 → 几秒内完成 ✅
 *     - #5036：215k tokens / 388 条消息 → 撞 120s ❌
 *       （但 6 分钟后 archived_at 显示 387 条消息全部 archived —— 压缩其实成功了，
 *        只是外层 `withTimeout(..., 120000, ...)` 抢先 reject，把「成功」报成「超时」）
 *
 *   即：工具本身零超时逻辑（compact-session-tool.ts 里 timeout/AbortController/signal 命中数为 0），
 *   问题出在 AgentComponent 外层那一层统一 120s 硬超时。
 *
 * 修复：
 *   把 `compact_session` 加入 `isLongRunningTool` 白名单（与 delegate_task / bash /
 *   workflow_run 同性质 —— 都是内部再起 agent/LLM 调用的复合操作），
 *   让它不再被 120s 超时包裹。
 *
 * 本文件用两层断言保护这个护栏：
 *   1. 源码结构断言：字面量 `toolName === "compact_session"` 必须绑定在
 *      `const isLongRunningTool = ...` 那一行的表达式里（不是裸 grep 关键词）
 *   2. 行为断言：执行名为 compact_session 的工具时**不得**注册 120000ms 的定时器；
 *      执行普通工具时**必须**注册（对照组，防止断言空洞恒真）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentComponent } from "./agent-component";
import type { Tool } from "../tool/types";
import { setToolConfigComponent } from "../tool/tool-component";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

const AGENT_COMPONENT_FILE = resolve(__dirname, "agent-component.ts");

/** 外层硬超时的毫秒数（与 agent-component.ts 里的 120000 保持一致） */
const OUTER_TIMEOUT_MS = 120000;

/**
 * 取出 `const isLongRunningTool = ...` 声明所在的那一行源码。
 * 找不到就抛错 —— 说明 agent-component.ts 结构变了，测试需要同步更新。
 */
function readIsLongRunningToolDeclarationLine(): string {
  const src = readFileSync(AGENT_COMPONENT_FILE, "utf8");
  const lines = src.split("\n");
  const idx = lines.findIndex((line) => /const\s+isLongRunningTool\s*=/.test(line));
  if (idx === -1) {
    throw new Error("isLongRunningTool declaration not found in agent-component.ts");
  }
  return lines[idx];
}

describe("Task #5053: compact_session 加入长任务工具白名单（源码结构断言）", () => {
  it("isLongRunningTool 声明行包含 toolName === \"compact_session\"", () => {
    const declLine = readIsLongRunningToolDeclarationLine();
    expect(declLine).toContain('toolName === "compact_session"');
  });

  it("toolName === \"compact_session\" 在整个文件里只出现一次（只允许白名单绑定）", () => {
    const src = readFileSync(AGENT_COMPONENT_FILE, "utf8");
    const occurrences = src.split('toolName === "compact_session"').length - 1;
    expect(occurrences).toBe(1);
  });

  it("白名单行仍然保留既有的 5 个长任务工具（不误删）", () => {
    const declLine = readIsLongRunningToolDeclarationLine();
    for (const name of [
      "delegate_task",
      "stop_task",
      "bash",
      "workflow_run",
      "run-workflow",
    ]) {
      expect(declLine).toContain(`toolName === "${name}"`);
    }
  });

  it("白名单声明上方有 ★ 注释说明 compact_session 豁免的理由", () => {
    const src = readFileSync(AGENT_COMPONENT_FILE, "utf8");
    const lines = src.split("\n");
    const idx = lines.findIndex((line) => /const\s+isLongRunningTool\s*=/.test(line));
    const commentWindow = lines.slice(Math.max(0, idx - 8), idx).join("\n");
    expect(commentWindow).toContain("compact_session");
    expect(commentWindow).toContain("LLM");
  });
});

/**
 * 行为断言：观察 `withTimeout` 内部用的 setTimeout 定时器。
 *
 * withTimeout(promise, 120000, msg) 会注册一个 120000ms 的定时器；
 * 长任务工具路径直接 `await toolPromise`，**不注册**该定时器。
 * 因此「是否注册了 120000ms 定时器」就是外层超时是否生效的可观测信号。
 */
describe("Task #5053: compact_session 不被外层 120s 超时包裹（行为断言）", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let tempDir: string;
  let emptyAgentsDir: string;

  /** 记录所有 setTimeout 的 delay（ms） */
  let observedDelays: number[];
  let realSetTimeout: typeof globalThis.setTimeout;

  beforeEach(async () => {
    vi.clearAllMocks();
    setToolConfigComponent(null);
    observedDelays = [];

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-compact-timeout-test-"));
    emptyAgentsDir = path.join(tempDir, "empty-agents");
    fsSync.mkdirSync(emptyAgentsDir, { recursive: true });
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", emptyAgentsDir);

    const mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
      registerComponent: vi.fn(),
      unregisterComponent: vi.fn(),
      getComponent: vi.fn((name: string) => (name === "config" ? configComponent : undefined)),
      hasComponent: vi.fn((name: string) => name === "config"),
      listComponents: vi.fn(() => []),
      handle_query: vi.fn(),
      handle_action: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeTo: vi.fn(() => () => {}),
      subscribeAll: vi.fn(() => () => {}),
      pushEnvEvent: vi.fn(),
    };

    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env: mockEnv as any,
      options: { configComponent } as any,
    } as any);

    // 拦截 setTimeout，记录 delay —— withTimeout 的 120000ms 定时器会被捕获
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: any, delay?: number, ...args: any[]) => {
      if (typeof delay === "number") observedDelays.push(delay);
      return realSetTimeout(handler, delay, ...args);
    }) as any;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    setToolConfigComponent(null);
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup failures
    }
  });

  function buildCtx(toolName: string, tool: Tool) {
    return {
      currentToolCall: {
        id: "tc-1",
        name: toolName,
        function: { name: toolName, arguments: {} },
      },
      tools: [tool],
      context: {
        sessionId: "test-session",
        messageId: "test-msg",
        abort: new AbortController().signal,
        metadata: {},
      },
    };
  }

  const noParamsSchema = z.object({});

  it("执行 compact_session 时不注册 120000ms 超时定时器", async () => {
    const tool: Tool = {
      name: "compact_session",
      description: "fake compact_session tool for timeout guard test",
      parameters: noParamsSchema,
      execute: vi.fn(async () => ({ success: true, output: "compacted" })),
    };
    agentComponent.setDefaultTools([tool]);
    (agentComponent as any).toolComponent = null;

    const result = await (agentComponent as any).executeTool(buildCtx("compact_session", tool));

    expect(result.success).toBe(true);
    expect(observedDelays).not.toContain(OUTER_TIMEOUT_MS);
  });

  it("对照组：执行普通工具时仍然注册 120000ms 超时定时器（防止断言恒真）", async () => {
    const tool: Tool = {
      name: "read_file",
      description: "fake regular tool for timeout guard test",
      parameters: noParamsSchema,
      execute: vi.fn(async () => ({ success: true, output: "ok" })),
    };
    agentComponent.setDefaultTools([tool]);
    (agentComponent as any).toolComponent = null;

    const result = await (agentComponent as any).executeTool(buildCtx("read_file", tool));

    expect(result.success).toBe(true);
    expect(observedDelays).toContain(OUTER_TIMEOUT_MS);
  });
});
