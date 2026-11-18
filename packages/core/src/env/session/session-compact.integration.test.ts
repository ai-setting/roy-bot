/**
 * Session Compaction Integration Test
 *
 * 两阶段 compact agent 注册 + session 消息 + previewCompact
 * 完整 LLM 调用端到端测试通过 CLI 脚本完成。
 */

import { describe, it, expect, beforeAll } from "vitest";
import { SessionComponent } from "../session/session-component";
import { AgentRegistry } from "../agent/agent-registry";
import { ConfigComponent } from "../../config/config-component";
import { builtInPrompts } from "../prompt/prompts-index";

describe("Session compaction: agent registration & prompt resolution", () => {
  let sessionComponent: SessionComponent;
  let registry: AgentRegistry;
  let sessionId: string;

  beforeAll(async () => {
    const configComponent = new ConfigComponent();
    await configComponent.init({ name: "config", version: "1.0", enabled: true });
    configComponent.set("session.storage.type", "memory");

    sessionComponent = new SessionComponent();
    await sessionComponent.init({
      name: "session", version: "1.0", enabled: true,
      options: { configComponent },
    } as any);

    registry = new AgentRegistry({ configComponent: null as any });
    registry.registerCompactAgent();
    registry.registerCompactHintAgent();
  });

  // ==========================================================
  // Agent registration
  // ==========================================================
  it("compact agent registered（C 方案：无工具）", () => {
    const a = registry.get("compact");
    expect(a).toBeDefined();
    expect(a!.name).toBe("compact");
    expect(a!.type).toBe("sub");
    expect(a!.maxIterations).toBe(3);
    expect(a!.filterHistory).toBe(false);
    // ★ Task #4933（C 方案）：去掉 workflow_submit_output，纯自然语言直出
    expect(a!.allowedTools).toEqual([]);
  });

  it("compact-hint agent registered（C 方案：无工具）", () => {
    const a = registry.get("compact-hint");
    expect(a).toBeDefined();
    expect(a!.name).toBe("compact-hint");
    expect(a!.type).toBe("sub");
    expect(a!.maxIterations).toBe(3);
    expect(a!.filterHistory).toBe(false);
    expect(a!.allowedTools).toEqual([]);
  });

  // ==========================================================
  // Prompt content —— C 方案：自然语言，无结构化契约
  // ==========================================================
  it("compact prompt 要求自然语言输出，且不要求固定小节", () => {
    const p = builtInPrompts["compact"];
    expect(p).toBeDefined();
    expect(p).toContain("checkpoint");
    // 明确要求自然语言
    expect(p).toContain("自然语言");
    // 明确禁止固定小节标题模板
    expect(p).toContain("不要");
    expect(p).toContain("小节标题");
  });

  it("compact prompt 不再包含结构化五栏位契约", () => {
    // 用户决策：五栏位是结构化产物，C 方案彻底删除
    const p = builtInPrompts["compact"];
    expect(p).not.toContain("processKeyPoints");
    expect(p).not.toContain("currentState");
    expect(p).not.toContain("nextSteps");
    expect(p).not.toContain("userIntents");
    expect(p).not.toContain("workflow_submit_output");
    // 不再有「## Summary / ## Current State」这类固定模板
    expect(p).not.toContain("## Summary");
    expect(p).not.toContain("## Process Key Points");
  });

  it("compact-hint prompt 要求纯文本 hint 直出（无工具、无 JSON）", () => {
    const p = builtInPrompts["compact-hint"];
    expect(p).toBeDefined();
    expect(p).toContain("Compact Hint Generator");
    expect(p).toContain("提示正文");
    // 明确禁止工具调用与 JSON
    expect(p).toContain("不要 JSON");
    expect(p).not.toContain("guidance_prompt");
    expect(p).not.toContain("workflow_submit_output");
  });

  // ==========================================================
  // Session with messages → previewCompact
  // ==========================================================
  it("adds messages and previews compact", async () => {
    const session = await sessionComponent.create({
      title: "Compact Test",
      metadata: { test: true },
    });
    sessionId = session.id;

    const msgs = [
      ["user", "你好"],
      ["assistant", "你好！有什么可以帮你的？"],
      ["user", "帮我查一下 bug"],
      ["assistant", "好的，让我看看。"],
      ["tool", ("RESULT: ".repeat(100))],  // large tool output
      ["user", "继续"],
      ["assistant", "找到问题了。"],
      ["tool", ("PASS: ".repeat(100))],
      ["user", "修复它"],
      ["assistant", "已修复！"],
    ];

    for (const [role, content] of msgs) {
      await (sessionComponent as any).store.addMessage(sessionId, {
        role,
        content,
        parts: [],
      });
    }

    // Verify messages stored
    const fetched = await sessionComponent.get(sessionId);
    expect(fetched).toBeDefined();
    expect(fetched!.messageCount).toBeGreaterThanOrEqual(10);

    // previewCompact
    const preview = await sessionComponent.previewCompact(sessionId);
    expect(preview.messageCountToCompact).toBeGreaterThan(0);
    expect(typeof preview.wouldTrigger).toBe("boolean");
  });
});
