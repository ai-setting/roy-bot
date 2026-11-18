/**
 * Task #2164 (Phase 4 TDD, RED phase) — `builtInPrompts['workflow-runner']`
 * structured-placeholder template.
 *
 * 核心 divergence vs reference #2146:
 * - reference 用 narrative 的 ~215 行 prompt 让 LLM 通过 pattern examples 解析 workflow 名
 * - beta 用结构化 `<workflow_name>NAME</workflow_name>` 占位符 + 140 行紧凑模板,
 *   确保 workflow 名解析 100% 确定性 (closes L2 brittle parsing from #2151)
 *
 * 同时需要:
 * - 给出具体的 session-resume copy-paste 示例 (closes L3 missing example from #2151)
 * - 描述自己为 sub-agent (NOT primary mediator)
 * - 列出 5 个 workflow_* 工具
 * - 移除旧 "workflow-agent" 模板
 */
import { describe, expect, test } from "vitest";
import { builtInPrompts, getBuiltInPrompt } from "./prompts-index";

describe("builtInPrompts['workflow-runner'] (Task #2164)", () => {
  test("exists and is non-empty", () => {
    expect(builtInPrompts["workflow-runner"]).toBeDefined();
    expect(typeof builtInPrompts["workflow-runner"]).toBe("string");
    expect(builtInPrompts["workflow-runner"].length).toBeGreaterThan(100);
  });

  test("describes itself as a sub-agent (NOT primary mediator)", () => {
    const p = builtInPrompts["workflow-runner"];
    expect(p).toMatch(/sub-agent|subagent|子代理|子智能体/);
    expect(p).not.toMatch(/调度中介|dispatch mediator/i);
  });

  test("contains <workflow_name> placeholder for deterministic parsing", () => {
    const p = builtInPrompts["workflow-runner"];
    expect(p).toContain("<workflow_name>");
    expect(p).toContain("</workflow_name>");
  });

  test("contains concrete session-resume copy-paste example (Task #2151 L3)", () => {
    const p = builtInPrompts["workflow-runner"];
    // Must have a concrete `roy-bot workflow run X -s workflow_run_xxx_1_abc` example
    expect(p).toMatch(/roy-bot\s+workflow\s+run\s+\S+\s+-s\s+workflow_run_[\w_]+/);
    // Must explain runId == sessionId
    expect(p).toMatch(/runId.*sessionId|session.*ID.*run|runsession|run[^a-zA-Z].*session/i);
  });

  test("lists workflow_* tools (Task #2164 original 5 + Task #2486 added workflow_search + workflow_tag_list)", () => {
    const p = builtInPrompts["workflow-runner"];
    // Task #2164 原始 5 个工具
    for (const tool of [
      "workflow_get",
      "workflow_list",
      "workflow_run",
      "workflow_run_status",
      "workflow_run_stop",
    ]) {
      expect(p).toContain(tool);
    }
    // Task #2486 新增: search-first 流程所需工具
    expect(p).toContain("workflow_search");
    expect(p).toContain("workflow_tag_list");
  });

  test("does NOT reference legacy workflow-agent", () => {
    const p = builtInPrompts["workflow-runner"];
    expect(p).not.toContain("workflow-agent");
  });

  test("builtInPrompts['workflow-agent'] is REMOVED", () => {
    expect(builtInPrompts["workflow-agent"]).toBeUndefined();
  });

  test("getBuiltInPrompt('workflow-runner') returns the same content", () => {
    const direct = builtInPrompts["workflow-runner"];
    const viaGetter = getBuiltInPrompt("workflow-runner");
    expect(viaGetter).toBe(direct);
  });

  test("getBuiltInPrompt('workflow-agent') returns undefined or empty", () => {
    const legacy = getBuiltInPrompt("workflow-agent");
    // Either undefined (deleted) or empty string (placeholder removed)
    expect(legacy == null || legacy === "").toBe(true);
  });
});

describe("builtInPrompts['workflow-runner'] search-first 兜底契约 (Task #2486)", () => {
  const p = builtInPrompts["workflow-runner"]!;

  test("必须含 'workflow_name 处理规则' 章节 (Task #2486)", () => {
    // 段标题不强制完全一致 (LLM 提示)，但必须含关键短语
    expect(p).toMatch(
      /##\s+⚠️.*workflow_name.*处理规则|workflow_name.*处理规则|workflow\s*name.*处理规则/
    );
  });

  test("缺名时第一步必须调 workflow_search / workflow_list / workflow_tag_list", () => {
    // 任意一个即可，但必须配合"第一步/首先/优先/必须先"
    const hasFirstStep =
      /(第一步|首先|优先|必须先).*(workflow_search|workflow list|workflow tag list|搜索)/i.test(p);
    expect(hasFirstStep).toBe(true);
  });

  test("必须禁止盲猜 / 绕过 workflow / 跳过 schema 验证", () => {
    expect(p).toMatch(/禁止.*盲猜|不得.*猜测|禁止.*绕过|不得.*绕过/);
    expect(p).toMatch(/跳过.*schema|schema.*验证/);
  });

  test("search-first 流程强制至少 2 个工具组合", () => {
    // 验证 search-first 流程中至少提到 2 个工具 (workflow_tag_list + workflow_search)
    expect(p).toContain("workflow_tag_list");
    expect(p).toContain("workflow_search");
  });

  test("选定 workflow 后必须 workflow_get 确认 input schema", () => {
    // 既有的 "默认 workflow-run 模式" 段已经要求 workflow_get(name)
    expect(p).toMatch(/workflow_get\(name\)/);
  });
});
