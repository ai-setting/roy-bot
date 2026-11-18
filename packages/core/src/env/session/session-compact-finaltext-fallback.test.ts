/**
 * @fileoverview compact 守护 + 降级链（C 方案 Task #4933 重写）
 *
 * 历史背景（2026-10-16 生产事故 traceId=83eadac2316d5be7529ca42ce7057d63）：
 *   compact 子 agent 首轮没有产出可用 checkpoint，旧代码会写出一个全空
 *   checkpoint（"Untitled Checkpoint"）**然后照样归档几百条消息**
 *   （生产实测 9 次 / 累计吞掉 4731 条 / 单次最多 2710 条）→ 上下文永久丢失。
 *
 * C 方案（Task #4933）保留并强化该守护：
 *   1. compact agent 现在直接输出**整段自然语言** checkpoint（无工具、无 schema）
 *   2. 降级链：finalText → scenarioHint（phase1 hint）
 *   3. 都没有 → **拒绝归档并抛错**（守护不可回归）
 *   4. 降级哨兵（[Hint extraction failed] / maximum iterations reached /
 *      no usable checkpoint output）一律视为不可用
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

import { SessionComponent } from "./session-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";

function createTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `test-compact-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

async function cleanupTempDb(dbPath: string): Promise<void> {
  try { await fsSync.promises.unlink(dbPath); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-wal`); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-shm`); } catch {}
}

/**
 * Mock AgentComponent：compact agent 直接返回整段自然语言 finalText。
 *
 * ★ C 方案：无 workflow_submit_output 工具调用 —— 纯文本直出。
 */
function createTextAgentComponent(finalText: string | undefined) {
  return {
    name: "agent",
    version: "1.0.0",
    run: async (agentName: string, _query: string, _opts: any) => {
      if (agentName === "compact") {
        return { iterations: 1, toolCalls: [], finalText };
      }
      return { iterations: 1, toolCalls: [] };
    },
  };
}

async function setupSession(
  component: SessionComponent,
  configComponent: ConfigComponent,
  mockEnv: Environment,
  tempDbPath: string
) {
  await component.init({
    env: mockEnv,
    options: {
      configComponent,
      config: { storage: { type: "sqlite", dbPath: tempDbPath } },
    },
  });

  const session = await component.create({ title: "fallback test" });
  for (let i = 0; i < 12; i++) {
    await component.addMessage(session.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message_${i}`,
    });
  }
  return session;
}

describe("SessionComponent.compact — C 方案：自然语言 checkpoint + 守护", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let tempDbPath: string;

  beforeEach(() => {
    component = new SessionComponent();
    configComponent = new ConfigComponent();
    tempDbPath = createTempDbPath();
  });

  afterEach(async () => {
    if (component.getStatus() !== "stopped") {
      try { await component.stop(); } catch {}
    }
    await cleanupTempDb(tempDbPath);
    vi.restoreAllMocks();
  });

  function makeEnv(agentComponent: any): Environment {
    return {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "agent") return agentComponent;
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "agent" || name === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  }

  it("默认路径：整段自然语言 finalText → checkpoint.content（不解析任何小节）", async () => {
    const finalText = [
      "# lark-cli profile 配置（beitongyuan）",
      "",
      "本次会话完成了 lark-cli profile 配置：profile 名确认为 beitongyuan，region=cn，凭据已写入。",
      "lark-cli 已可正常调用（whoami 返回正确用户）。",
      "",
      "当前卡在：用 user 身份 reply 时权限报错 230002，需要用户点授权链接。",
      "",
      "后续：拿到授权后重试 reply，然后回归测试多 profile 场景。",
    ].join("\n");

    const mockAgent = createTextAgentComponent(finalText);
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    const result = await component.compact(session.id);

    // 1. 标题从首行 markdown 标题提取
    expect(result.checkpoint.title).toBe("lark-cli profile 配置（beitongyuan）");

    // 2. 正文 = 整段原文（一个字都不丢）
    expect(result.checkpoint.content).toBe(finalText.trim());

    // 3. 消息被归档
    expect(result.deletedMessageCount).toBe(12);
  });

  it("C 方案：checkpoint 不含五栏位，正文保持整段（无小节解析）", async () => {
    // 故意用「看起来像小节标题」的文本 —— C 方案下它们只是普通正文，
    // 不应被任何解析器拆成 processKeyPoints / currentState 等字段。
    const finalText = [
      "# 压缩机制改造",
      "",
      "## Summary",
      "这段文本里的 markdown 标题只是正文的一部分，不是结构化契约。",
      "",
      "## Current State",
      "当前正在验证 resume 行为，测试已全部通过。",
    ].join("\n");

    const mockAgent = createTextAgentComponent(finalText);
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    const result = await component.compact(session.id);
    const cp = result.checkpoint as unknown as Record<string, unknown>;

    // 正文完整保留（含"小节标题"字样）
    expect(result.checkpoint.content).toContain("## Summary");
    expect(result.checkpoint.content).toContain("## Current State");

    // 五栏位字段不存在（C 方案彻底去结构化）
    expect(cp.summary).toBeUndefined();
    expect(cp.processKeyPoints).toBeUndefined();
    expect(cp.currentState).toBeUndefined();
    expect(cp.nextSteps).toBeUndefined();
    expect(cp.userIntents).toBeUndefined();
  });

  it("finalText 为空：拒绝归档并抛错（守护不可回归）", async () => {
    const mockAgent = createTextAgentComponent(undefined);
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    await expect(
      component.compact(session.id)
    ).rejects.toThrow(/no usable checkpoint output/i);

    // 关键：归档没有发生，历史完好
    const after = await component.get(session.id);
    expect(after!.messageCount).toBe(12);
    const checkpoints = await component.getCheckpoints(session.id);
    expect(checkpoints.length).toBe(0);
  });

  it("finalText 为降级哨兵 'maximum iterations reached'：同样拒绝归档", async () => {
    const mockAgent = createTextAgentComponent("Maximum iterations reached");
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    await expect(
      component.compact(session.id)
    ).rejects.toThrow(/no usable checkpoint output/i);

    const after = await component.get(session.id);
    expect(after!.messageCount).toBe(12);
  });

  it("finalText 为过短占位文本（< 20 字符）：拒绝归档", async () => {
    const mockAgent = createTextAgentComponent("ok");
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    await expect(
      component.compact(session.id)
    ).rejects.toThrow(/no usable checkpoint output/i);
  });

  it("finalText 为空但 scenarioHint 可用：用 hint 兜底，不抛错也不丢上下文", async () => {
    const mockAgent = createTextAgentComponent(undefined);
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    const scenarioHint =
      "会话围绕「opencode 插件如何触发」展开：已核实 plugin 加载为 active，" +
      "下一步需要用 lark-cli 回复使用指南。";

    const result = await component.compact(session.id, { scenarioHint });

    expect(result.checkpoint.content).toContain("opencode 插件如何触发");
    expect(result.checkpoint.content).toContain("lark-cli");
    expect(result.deletedMessageCount).toBe(12);
  });

  it("scenarioHint 是降级哨兵时也必须拒绝归档", async () => {
    const mockAgent = createTextAgentComponent(undefined);
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    await expect(
      component.compact(session.id, { scenarioHint: "[Hint extraction failed]" })
    ).rejects.toThrow(/no usable checkpoint output/i);

    const after = await component.get(session.id);
    expect(after!.messageCount).toBe(12);
    const checkpoints = await component.getCheckpoints(session.id);
    expect(checkpoints.length).toBe(0);
  });

  it("agentic 会话（assistant 消息都带 tool parts）也必须保住 recentMessages", async () => {
    const mockAgent = createTextAgentComponent(
      "本次会话完成了上下文保留测试：跑了两轮工具调用，结果都符合预期。"
    );
    await component.init({
      env: makeEnv(mockAgent),
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    const session = await component.create({ title: "agentic" });
    for (let i = 0; i < 6; i++) {
      await component.addMessage(session.id, {
        role: "user",
        content: `user_turn_${i}`,
      });
      await component.addMessage(session.id, {
        role: "assistant",
        content: "",
        parts: [
          { type: "tool-call", toolCallId: `c${i}`, toolName: "bash", input: { command: "ls" } },
        ],
      } as any);
      await component.addMessage(session.id, {
        role: "tool",
        content: `tool_result_${i}`,
        parts: [
          { type: "tool-result", toolCallId: `c${i}`, toolName: "bash", output: `out${i}` },
        ],
      } as any);
    }

    const result = await component.compact(session.id);

    const recent = result.checkpoint.recentMessages ?? [];
    expect(recent.length).toBeGreaterThan(0);
    const joined = recent.map((m: any) => m.content).join("\n");
    expect(joined).toMatch(/user_turn_5|tool_result_5/);
  });

  it("hint 注入：scenarioHint 出现在 compact agent 收到的 query 里", async () => {
    let capturedQuery = "";
    const mockAgent = {
      name: "agent",
      version: "1.0.0",
      run: async (agentName: string, query: string) => {
        if (agentName === "compact") {
          capturedQuery = query;
          return {
            iterations: 1,
            toolCalls: [],
            finalText: "本次会话完成了 hint 注入验证，query 里能看到 phase1 的关注点提示。",
          };
        }
        return { iterations: 1, toolCalls: [] };
      },
    };
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    await component.compact(session.id, {
      scenarioHint: "重点保留：profile 的 region 与凭据路径",
    });

    expect(capturedQuery).toContain("重点保留：profile 的 region 与凭据路径");
  });

  it("hint 为空时不阻塞：query 仍正常发出，checkpoint 由 finalText 产生", async () => {
    let capturedQuery = "";
    const mockAgent = {
      name: "agent",
      version: "1.0.0",
      run: async (agentName: string, query: string) => {
        if (agentName === "compact") {
          capturedQuery = query;
          return {
            iterations: 1,
            toolCalls: [],
            finalText: "hint 为空时压缩依然正常工作，checkpoint 正文由 finalText 提供。",
          };
        }
        return { iterations: 1, toolCalls: [] };
      },
    };
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    const result = await component.compact(session.id, { scenarioHint: "" });

    expect(capturedQuery).toBeTruthy();
    expect(result.checkpoint.content).toContain("hint 为空时压缩依然正常工作");
    expect(result.deletedMessageCount).toBe(12);
  });

  it("compact agent 抛错时：拒绝归档，消息不动", async () => {
    const mockAgent = {
      name: "agent",
      version: "1.0.0",
      run: async () => {
        throw new Error("LLM gateway 503");
      },
    };
    const session = await setupSession(component, configComponent, makeEnv(mockAgent), tempDbPath);

    await expect(
      component.compact(session.id)
    ).rejects.toThrow(/Session compaction failed/i);

    const after = await component.get(session.id);
    expect(after!.messageCount).toBe(12);
  });
});

/**
 * ★ Review MINOR-1（Task #4933 收尾修复）：`session.compactModel` 必须有
 * 自动化测试保障「配置值真的传到了 agentComponent.run 的 run option」。
 *
 * 缺陷现场：验收 D 只靠人工实测（用真实 config.jsonc 读值），一旦将来某次
 * 重构把 `model: this.getCompactModel()` 删掉/改错，回退成 agent yaml 的模型
 * （历史真正踩过的坑：compact-hint 无 model 字段 → 落 GLM 链 → 慢尾 118s+），
 * 没有任何测试会红。
 */
describe("session.compactModel 配置生效（两阶段都注入 run option）", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let tempDbPath: string;

  beforeEach(() => {
    component = new SessionComponent();
    configComponent = new ConfigComponent();
    tempDbPath = createTempDbPath();
  });

  afterEach(async () => {
    if (component.getStatus() !== "stopped") {
      try { await component.stop(); } catch {}
    }
    await cleanupTempDb(tempDbPath);
    vi.restoreAllMocks();
  });

  /** 捕获每次 run() 的 (agentName, opts) */
  function createCapturingAgent(finalText: string) {
    const calls: Array<{ agent: string; opts: any }> = [];
    const mock = {
      name: "agent",
      version: "1.0.0",
      calls,
      run: async (agentName: string, _query: string, opts: any) => {
        calls.push({ agent: agentName, opts });
        if (agentName === "compact") {
          return { iterations: 1, toolCalls: [], finalText };
        }
        if (agentName === "compact-hint") {
          return { iterations: 1, toolCalls: [], finalText: "hint: 聚焦 resume 验证与模型配置" };
        }
        return { iterations: 1, toolCalls: [] };
      },
    };
    return mock;
  }

  function envWith(agentComponent: any): Environment {
    return {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((n: string) => {
        if (n === "agent") return agentComponent;
        if (n === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((n: string) => n === "agent" || n === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  }

  it("配置了 session.compactModel → phase1 hint 与 phase2 compact 都收到该 model", async () => {
    const finalText = "# 压缩结果\n\n本次会话完成了压缩模型配置验证，内容足够长以通过守护阈值。";
    const mockAgent = createCapturingAgent(finalText);

    await component.init({
      env: envWith(mockAgent),
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    // 模拟用户在 ~/.roy-bot/config.jsonc 里配置
    configComponent.set("session.compactModel", "minimax/MiniMax-M3.1-Flash");

    const session = await component.create({ title: "compactModel test" });
    for (let i = 0; i < 8; i++) {
      await component.addMessage(session.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg_${i}`,
      });
    }

    // 两阶段真实调用顺序（与 context-handler.compactSessionWithTwoPhases 一致）：
    //   phase1: generateCompactHint()  → phase2: compact({ scenarioHint })
    const hint = await component.generateCompactHint(session.id);
    await component.compact(session.id, { scenarioHint: hint } as any);

    const hintCall = mockAgent.calls.find((c) => c.agent === "compact-hint");
    const compactCall = mockAgent.calls.find((c) => c.agent === "compact");

    expect(hintCall).toBeDefined();
    expect(compactCall).toBeDefined();

    // ★ 核心断言：两阶段 run option 都带上配置的模型
    expect(hintCall!.opts.model).toBe("minimax/MiniMax-M3.1-Flash");
    expect(compactCall!.opts.model).toBe("minimax/MiniMax-M3.1-Flash");
  });

  it("未配置 session.compactModel → model 为 undefined（不覆盖 agent yaml，保持原行为）", async () => {
    const finalText = "# 默认模型\n\n未配置 compactModel 时应回落到 agent 自身 model，内容足够长以通过守护。";
    const mockAgent = createCapturingAgent(finalText);

    await component.init({
      env: envWith(mockAgent),
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    const session = await component.create({ title: "no compactModel" });
    for (let i = 0; i < 8; i++) {
      await component.addMessage(session.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg_${i}`,
      });
    }

    const hint = await component.generateCompactHint(session.id);
    await component.compact(session.id, { scenarioHint: hint } as any);

    const compactCall = mockAgent.calls.find((c) => c.agent === "compact");
    expect(compactCall).toBeDefined();
    // undefined → agent-component.ts:1518 会走 `?? agent.config.model`
    expect(compactCall!.opts.model).toBeUndefined();
  });
});
