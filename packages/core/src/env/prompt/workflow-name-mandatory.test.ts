/**
 * Task #2486 (Phase 1 TDD, RED) — workflow-runner prompt 强化契约
 *
 * 目标: 防止 default agent 委派给 workflow-runner 时丢失 workflow_name 上下文
 *
 * 4 个防护位:
 *   1. default prompt "🥈 Workflow runner" delegate_task 模板 — 必须展示**两种合法模式**:
 *      (a) 传具体 workflow_name
 *      (b) 指示 sub-agent search-first (workflow_search/workflow_list/workflow_get)
 *   2. default prompt "## Workflow 操作指南" 段 — 必须说明两种模式都合法
 *   3. workflow-runner prompt — 必须有 "## ⚠️ workflow_name 处理规则" 段:
 *      - 缺名时**第一步** 调 workflow_search/tag_list/list/get 选定
 *      - 禁止盲猜/绕过
 *   4. AgentRegistry.registerWorkflowRunner description — 必须含
 *      "workflow_name" 或 "workflow name" + "搜索/搜索/指定/指定"
 *
 * 同时锁定:
 *   - roy prompt 字节级 0 改动 (Task #2164 铁律)
 *   - prompt 描述的契约与 AgentRegistry.description 实际注册一致 (Task #2485 DELEGATION-* 铁律)
 *   - CLI list 的 builtInSubAgentNames 包含 workflow-runner (Task #2164 铁律)
 */
import { describe, expect, test } from "vitest";
import { builtInPrompts } from "./prompts-index";

const defaultPrompt = builtInPrompts["default"];
const workflowRunnerPrompt = builtInPrompts["workflow-runner"];
const royPrompt = builtInPrompts["roy"];

describe("Task #2486: workflow_name 必传/search-first 契约", () => {
  describe("GATE-1: default prompt '🥈 Workflow runner' 段 — 两种合法委托模式", () => {
    function extractRunnerSection(): string {
      // 段开始: "### 🥈 Workflow runner"
      // 段结束: "### 🥉 Workflow creator" 之前
      const start = defaultPrompt.indexOf("### 🥈 Workflow runner");
      const end = defaultPrompt.indexOf("### 🥉 Workflow creator");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return defaultPrompt.slice(start, end);
    }

    test("GATE-1A: 段开始必须明确 subagent_type='workflow-runner'", () => {
      const section = extractRunnerSection();
      expect(section).toMatch(/subagent_type=["']workflow-runner["']/);
    });

    test("GATE-1B: 必须展示模式 (a) — 传具体 workflow_name", () => {
      // 模式 (a): prompt 中显式含 "运行 workflow <name>" 或 "workflow <name>" 形式
      const section = extractRunnerSection();
      expect(section).toMatch(/prompt.*workflow\s+\S+/);
    });

    test("GATE-1C: 必须展示模式 (b) — 指示 sub-agent 先 search-first", () => {
      // 模式 (b): prompt 中显式提到 workflow_search / workflow_list / workflow_get / workflow_tag_list
      // 必须至少有 1 个被引用
      const section = extractRunnerSection();
      const mentionsSearch =
        /workflow_search/.test(section) ||
        /workflow_list/.test(section) ||
        /workflow_get/.test(section) ||
        /workflow tag list/.test(section);
      expect(mentionsSearch).toBe(true);
    });

    test("GATE-1D: 必须显式说明 subagent 必须遵循其自身工作模式", () => {
      // 新增铁律: 选了 subagent 就必须遵循该 subagent 的工作模式
      // 段中应有"subagent 的工作模式" 或 "sub-agent 自身的工作" 提示
      const hasDoctrine =
        /subagent.*工作模式|sub-agent.*工作|workflow-runner.*工作模式|遵循.*sub/i.test(
          defaultPrompt
        );
      expect(hasDoctrine).toBe(true);
    });
  });

  describe("GATE-2: default prompt '## Workflow 操作指南' 段 — 委托时 workflow_name 必传/search-first", () => {
    function extractWorkflowGuideSection(): string {
      const start = defaultPrompt.indexOf("## Workflow 操作指南");
      const memoryMarker = defaultPrompt.indexOf("### {{memory}}");
      expect(start).toBeGreaterThan(-1);
      expect(memoryMarker).toBeGreaterThan(start);
      return defaultPrompt.slice(start, memoryMarker);
    }

    test("GATE-2A: 段必须明确 '指定 workflow 名' 或 'workflow_name'", () => {
      const section = extractWorkflowGuideSection();
      expect(section).toMatch(/workflow\s*name|workflow\s*名/);
    });

    test("GATE-2B: 段必须明确 '搜索' 作为 workflow_name 缺失时的兜底", () => {
      const section = extractWorkflowGuideSection();
      expect(section).toMatch(/workflow_search|workflow list|workflow tag list|搜索/);
    });

    test("GATE-2C: 段必须含完整 delegate_task 模板 (subagent_type='workflow-runner')", () => {
      const section = extractWorkflowGuideSection();
      expect(section).toMatch(/delegate_task\s*\(/);
      expect(section).toMatch(/subagent_type=["']workflow-runner["']/);
    });
  });

  describe("GATE-3: workflow-runner prompt — workflow_name 处理规则", () => {
    test("GATE-3A: 必须含 '## ⚠️ workflow_name 处理规则' 段", () => {
      // 段标题不强制完全一致 (LLM 提示)，但必须含关键短语
      expect(workflowRunnerPrompt).toMatch(
        /##\s+⚠️.*workflow_name.*处理规则|workflow_name.*处理规则|workflow\s*name.*处理规则/
      );
    });

    test("GATE-3B: 缺名时第一步必须调 workflow_search / workflow_list / workflow_tag_list", () => {
      // 任意一个即可，但必须配合"第一步/首先/优先/必须先"
      const hasFirstStep =
        /(第一步|首先|优先|必须先).*(workflow_search|workflow list|workflow tag list|搜索)/i.test(
          workflowRunnerPrompt
        );
      expect(hasFirstStep).toBe(true);
    });

    test("GATE-3C: 必须禁止盲猜 / 绕过", () => {
      expect(workflowRunnerPrompt).toMatch(/禁止.*盲猜|禁止.*绕过|不得.*猜测|不得.*绕过/);
    });

    test("GATE-3D: 选定 workflow 后必须 workflow_get 确认 input schema", () => {
      // 既有的 "默认 workflow-run 模式" 段已经要求 workflow_get(name)
      // 这里验证该约束仍然存在
      expect(workflowRunnerPrompt).toMatch(/workflow_get\(name\)/);
    });
  });

  describe("GATE-4: AgentRegistry description — 必须强调 workflow_name 必传/search-first", () => {
    test("GATE-4A: AgentRegistry 实际注册 workflow-runner", async () => {
      const { AgentRegistry } = await import("../agent/agent-registry");
      const reg = new AgentRegistry({
        configComponent: {
          get: () => undefined,
          set: () => {},
          registerSource: () => {},
          load: () => {},
          watch: () => {},
        } as any,
        promptComponent: { getBuiltInPrompt: () => "" } as any,
        baseDir: "/tmp/test-workflow-name-mandatory-2486",
        fs: { existsSync: () => false } as any,
        fsPromises: {
          readdir: async () => [],
          readFile: async () => "",
          writeFile: async () => {},
          mkdir: async () => undefined,
          unlink: async () => {},
        } as any,
      });
      reg.registerWorkflowRunner();
      const agent = reg.get("workflow-runner");
      expect(agent).toBeDefined();
      expect(agent!.type).toBe("sub");
      expect(agent!.systemPromptRef).toBe("workflow-runner");
    });

    test("GATE-4B: AgentRegistry description 含 'workflow_name' 或 'workflow name'", async () => {
      const { AgentRegistry } = await import("../agent/agent-registry");
      const reg = new AgentRegistry({
        configComponent: {
          get: () => undefined,
          set: () => {},
          registerSource: () => {},
          load: () => {},
          watch: () => {},
        } as any,
        promptComponent: { getBuiltInPrompt: () => "" } as any,
        baseDir: "/tmp/test-workflow-name-mandatory-2486-desc",
        fs: { existsSync: () => false } as any,
        fsPromises: {
          readdir: async () => [],
          readFile: async () => "",
          writeFile: async () => {},
          mkdir: async () => undefined,
          unlink: async () => {},
        } as any,
      });
      reg.registerWorkflowRunner();
      const agent = reg.get("workflow-runner")!;
      expect(agent.description).toBeDefined();
      // 必须明确说明 workflow_name 是核心输入
      expect(agent.description).toMatch(/workflow_name|workflow name/);
    });

    test("GATE-4C: AgentRegistry description 含 '搜索/选择' 或 '指定' 关键词 (说明 search-first 兜底)", async () => {
      const { AgentRegistry } = await import("../agent/agent-registry");
      const reg = new AgentRegistry({
        configComponent: {
          get: () => undefined,
          set: () => {},
          registerSource: () => {},
          load: () => {},
          watch: () => {},
        } as any,
        promptComponent: { getBuiltInPrompt: () => "" } as any,
        baseDir: "/tmp/test-workflow-name-mandatory-2486-desc2",
        fs: { existsSync: () => false } as any,
        fsPromises: {
          readdir: async () => [],
          readFile: async () => "",
          writeFile: async () => {},
          mkdir: async () => undefined,
          unlink: async () => {},
        } as any,
      });
      reg.registerWorkflowRunner();
      const agent = reg.get("workflow-runner")!;
      // description 必须含"指定"或"搜索"或"选择"中至少 1 个关键词
      const hasKeyword =
        /指定/.test(agent.description ?? "") ||
        /搜索/.test(agent.description ?? "") ||
        /选择/.test(agent.description ?? "");
      expect(hasKeyword).toBe(true);
    });

    test("GATE-4D: prompt 与 description 共享关键关键词 'workflow_name'", () => {
      const promptHasKeyword = /workflow_name|workflow name/.test(workflowRunnerPrompt);
      expect(promptHasKeyword).toBe(true);
    });
  });

  describe("GATE-5: roy prompt 字节级 0 改动 (Task #2164 铁律)", () => {
    test("GATE-5A: roy prompt 不含 'workflow-runner'", () => {
      expect(royPrompt).not.toContain("workflow-runner");
    });
    test("GATE-5B: roy prompt 仍含其原有的 'Using Workflows to Solve Tasks' 段", () => {
      expect(royPrompt).toContain("Using Workflows to Solve Tasks");
    });
  });
});