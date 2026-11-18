/**
 * @fileoverview Tests for compact built-in agent (Task #4933 — C 方案)
 *
 * The compact agent is a sub-agent used by SessionComponent.compact()
 * to generate a **natural-language checkpoint** from session history.
 *
 * ★ C 方案（Task #4933 重写）语义变更：
 *   - 旧方案：调用 `workflow_submit_output` 工具提交结构化 JSON
 *     （summary / processKeyPoints / currentState / nextSteps / userIntents 五栏位）
 *   - 新方案：**无工具**、纯自然语言直出整段 checkpoint 正文（content 字段）
 *
 * 因此本测试的断言方向整体反转：
 *   - 不再断言 prompt「包含」workflow_submit_output / 五栏位字段名
 *   - 反而断言 prompt「不含」这些被用户否定的结构化契约痕迹
 */

import { describe, it, expect, beforeEach } from "vitest";
import { builtInPrompts, getBuiltInPrompt } from "../prompt/prompts-index";
import { AgentRegistry } from "./agent-registry";

describe("compact built-in agent (C 方案)", () => {
  describe("prompts-index.ts", () => {
    it('should export "compact" prompt', () => {
      expect(builtInPrompts["compact"]).toBeDefined();
      expect(typeof builtInPrompts["compact"]).toBe("string");
    });

    it("should NOT require workflow_submit_output tool (C 方案：纯自然语言直出)", () => {
      const prompt = builtInPrompts["compact"];
      expect(prompt).not.toContain("workflow_submit_output");
    });

    it("should NOT require the five legacy structured fields (C 方案：去结构化)", () => {
      const prompt = builtInPrompts["compact"];
      expect(prompt).not.toContain("processKeyPoints");
      expect(prompt).not.toContain("currentState");
      expect(prompt).not.toContain("nextSteps");
      expect(prompt).not.toContain("userIntents");
    });

    it("should NOT impose a fixed section-heading template (C 方案：无章节契约)", () => {
      const prompt = builtInPrompts["compact"];
      // 不应出现被用户否定的固定小节标题
      expect(prompt).not.toContain("## Summary");
      expect(prompt).not.toContain("## Process Key Points");
      expect(prompt).not.toContain("## Current State");
      expect(prompt).not.toContain("## Next Steps");
      expect(prompt).not.toContain("## User Intents");
    });

    it("should instruct about scenario hint", () => {
      const prompt = builtInPrompts["compact"];
      expect(prompt).toContain("scenario");
    });

    it("should tell the model to output the checkpoint body directly", () => {
      const prompt = builtInPrompts["compact"];
      expect(prompt).toContain("直接输出");
      // 明确不要 JSON / 代码围栏
      expect(prompt).toContain("JSON");
    });

    it('should be accessible via getBuiltInPrompt("compact")', () => {
      const prompt = getBuiltInPrompt("compact");
      expect(prompt).toBeDefined();
      expect(prompt).toBe(builtInPrompts["compact"]);
    });
  });

  describe("compact-hint prompt (C 方案)", () => {
    it('should export "compact-hint" prompt', () => {
      expect(builtInPrompts["compact-hint"]).toBeDefined();
    });

    it("should NOT require workflow_submit_output tool", () => {
      expect(builtInPrompts["compact-hint"]).not.toContain("workflow_submit_output");
    });

    it("should instruct direct plain-text reply", () => {
      const prompt = builtInPrompts["compact-hint"];
      expect(prompt).toContain("直接回复");
      expect(prompt).not.toContain("guidance_prompt");
    });
  });

  describe("registerCompactAgent()", () => {
    let registry: AgentRegistry;

    beforeEach(() => {
      registry = new AgentRegistry({ configComponent: null });
    });

    it('should register "compact" agent with correct configuration', () => {
      registry.registerCompactAgent();

      const agent = registry.get("compact");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("compact");
      expect(agent?.type).toBe("sub");
      expect(agent?.systemPromptRef).toBe("compact");
      // ★ C 方案：无工具 —— 纯自然语言直出 checkpoint 正文
      expect(agent?.allowedTools).toEqual([]);
      // ★ 2026-10-16：原为 1（首轮没调对 tool 即终局 → 空 checkpoint + 丢上下文）。
      //   3 是「留一次真正重试」的最小值：max-iter-reminder 在
      //   iteration === maxIterations-1 注入「别再调工具」提醒，值为 2 会在 iteration 1
      //   就把唯一的重试机会掐死。详见 registerCompactAgent() 的注释。
      //   断言用精确值（独立 review P2-4）：这是配置契约，改动应当让测试失败以强制复核，
      //   写成 >=3 会让 100 也蒙混过关。
      expect(agent?.maxIterations).toBe(3);
      expect(agent?.filterHistory).toBe(false);
    });

    it('should register "compact-hint" agent with NO tools (C 方案)', () => {
      registry.registerCompactHintAgent();

      const agent = registry.get("compact-hint");
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("compact-hint");
      expect(agent?.type).toBe("sub");
      expect(agent?.systemPromptRef).toBe("compact-hint");
      expect(agent?.allowedTools).toEqual([]);
      expect(agent?.maxIterations).toBe(3);
      expect(agent?.filterHistory).toBe(false);
    });

    it("should be idempotent (no-op on double registration)", () => {
      registry.registerCompactAgent();
      registry.registerCompactAgent();

      const agents = registry.list();
      const compactAgents = agents.filter((a) => a.name === "compact");
      expect(compactAgents).toHaveLength(1);
    });

    it("should resolve systemPrompt from builtInPrompts", () => {
      registry.registerCompactAgent();

      const builtIn = getBuiltInPrompt("compact");
      expect(builtIn).toBeDefined();

      const agent = registry.get("compact");
      expect(agent?.systemPromptRef).toBe("compact");
    });
  });
});
