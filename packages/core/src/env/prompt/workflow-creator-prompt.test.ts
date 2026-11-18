/**
 * Task #2194 — `builtInPrompts['workflow-creator']` 交互式 workflow 构建 sub-agent prompt。
 *
 * 关键差异 vs workflow-extract (one-shot 从 task history 自动提取):
 * - workflow-creator 是多轮对话式 — 用户主动参与澄清需求
 * - 用户输入可以是 task 描述 / 日志 / trace / session 信息
 * - 6 个工具 (vs workflow-extract 的 4 个): 加 workflow_search + workflow_tag_list
 *
 * 必须包含:
 * - 6 个工具名
 * - agentNode 注意事项段落 (agent_type, allowedTools, deniedTools, timeout)
 * - 至少 3 种节点类型 (tool/skill/agent/workflow/condition/askUser/pythonCall)
 * - iterative validate 流程描述
 * - tag 选择原则 (复用已有 tag 避免膨胀)
 */
import { describe, expect, test } from "vitest";
import { builtInPrompts, getBuiltInPrompt } from "./prompts-index";

describe("builtInPrompts['workflow-creator'] (Task #2194)", () => {
  test("exists and is non-empty", () => {
    expect(builtInPrompts["workflow-creator"]).toBeDefined();
    expect(typeof builtInPrompts["workflow-creator"]).toBe("string");
    expect(builtInPrompts["workflow-creator"].length).toBeGreaterThan(100);
  });

  test("describes itself as a sub-agent (NOT primary mediator)", () => {
    const p = builtInPrompts["workflow-creator"];
    // 必须是 sub-agent，与 roy/explore/workflow-runner/workflow-extract 同层
    expect(p).toMatch(/sub-agent|subagent|子代理|子智能体/);
    // 不应是 primary mediator
    expect(p).not.toMatch(/调度中介|dispatch mediator|primary agent/i);
  });

  test("contains all 6 workflow_* tool names (strict whitelist)", () => {
    const p = builtInPrompts["workflow-creator"];
    for (const tool of [
      "workflow_list",
      "workflow_get",
      "workflow_search",
      "workflow_tag_list",
      "workflow_validate",
      "workflow_add",
    ]) {
      expect(p).toContain(tool);
    }
  });

  test("contains agentNode 注意事项段落 (agent_type, allowedTools, deniedTools, timeout)", () => {
    const p = builtInPrompts["workflow-creator"];
    // agentNode 节点配置核心字段都必须在 prompt 中提到
    expect(p).toContain("agent_type");
    expect(p).toContain("allowedTools");
    expect(p).toContain("deniedTools");
    expect(p).toContain("timeout");
  });

  test("mentions at least 3 node types (tool/skill/agent/workflow/condition/askUser/pythonCall)", () => {
    const p = builtInPrompts["workflow-creator"];
    // 至少覆盖 3 种节点类型 — 实际预期至少 5 种
    const nodeTypeKeywords = [
      "agent",
      "tool",
      "skill",
      "workflow",
      "condition",
      "askUser",
      "pythonCall",
    ];
    let matchedCount = 0;
    for (const keyword of nodeTypeKeywords) {
      if (p.toLowerCase().includes(keyword.toLowerCase())) {
        matchedCount++;
      }
    }
    expect(matchedCount).toBeGreaterThanOrEqual(3);
  });

  test("mentions iterative validate flow (validate → 修正 → re-validate)", () => {
    const p = builtInPrompts["workflow-creator"];
    // 必须有 validate 关键字
    expect(p).toContain("workflow_validate");
    // 必须有迭代/修正的关键字描述
    expect(p).toMatch(/迭代|iterative|修正|fix|retry/);
  });

  test("mentions tag selection principle (复用已有 tag / 避免膨胀)", () => {
    const p = builtInPrompts["workflow-creator"];
    // 必须提到 tag 选择
    expect(p).toMatch(/tag/i);
    // 必须提到复用已有 tag 避免膨胀
    expect(p).toMatch(/复用|reuse|避免.*膨胀|avoid.*proliferation/i);
  });

  test("does NOT contain hardcoded large text warning — should reference inputs", () => {
    const p = builtInPrompts["workflow-creator"];
    // prompt 中应有关于"避免硬编码大段 text，应引用输入"的提示
    // 这是 prompt 设计的关键经验（详见 task description D.agentNode 段）
    expect(p).toMatch(/硬编码|hardcode|引用.*输入|reference.*input/i);
  });

  test("does NOT delegate_task recursively (deniedTools guidance)", () => {
    const p = builtInPrompts["workflow-creator"];
    // 必须有"禁止嵌套委托"的约束
    expect(p).toMatch(/delegate_task|嵌套|递归|recurs/i);
    expect(p).toMatch(/禁止|禁止|avoid|don't|do not/i);
  });

  test("getBuiltInPrompt('workflow-creator') returns the same content", () => {
    const direct = builtInPrompts["workflow-creator"];
    const viaGetter = getBuiltInPrompt("workflow-creator");
    expect(viaGetter).toBe(direct);
  });

  test("workflow-creator is distinct from workflow-extract (different name)", () => {
    // workflow-creator 和 workflow-extract 是不同 agent，名字不能相同
    expect(builtInPrompts["workflow-creator"]).toBeDefined();
    expect(builtInPrompts["workflow-extract"]).toBeDefined();
    // 字符串内容应该明显不同（不是同一份）
    expect(builtInPrompts["workflow-creator"]).not.toBe(
      builtInPrompts["workflow-extract"],
    );
  });
});

// ============================================================================
// Task #4298 — template-reference contract guidance in the creator prompt
// ============================================================================
describe("builtInPrompts['workflow-creator'] — reference contracts (Task #4298)", () => {
  test("has a 阶段 4.6 (Reference Contracts First) section", () => {
    const p = builtInPrompts["workflow-creator"];
    expect(p).toContain("阶段 4.6");
    expect(p).toMatch(/引用契约|Reference Contracts/i);
  });

  test("contains the node output contract table (source-type → field)", () => {
    const p = builtInPrompts["workflow-creator"];
    // the decisive rule: agent → .result ; data nodes → .output
    expect(p).toMatch(/agent[^\n]*\.result/);
    expect(p).toMatch(/tool[^\n]*\.output/);
    // and it must name the concrete failure mode
    expect(p).toContain("{{nodes.run-validation-tests.result}}");
    expect(p).toMatch(/空字符串|empty string/);
  });

  test("instructs the creator to fix EVERY validate error and to use suggested fixes", () => {
    const p = builtInPrompts["workflow-creator"];
    expect(p).toContain("errorCount === 0");
    expect(p).toMatch(/逐条修复/);
    expect(p).toMatch(/Did you mean/);
    expect(p).toMatch(/template-contract/);
  });

  test("instructs the creator to EVALUATE warnings (fix or justify)", () => {
    const p = builtInPrompts["workflow-creator"];
    expect(p).toMatch(/逐条评估/);
    expect(p).toMatch(/写明理由/);
  });

  test("requires grepping for unresolved-template warnings during smoke run", () => {
    const p = builtInPrompts["workflow-creator"];
    expect(p).toContain("has unresolved templates");
  });

  test("keeps the smoke-run hard gate wording (validate OK != usable)", () => {
    const p = builtInPrompts["workflow-creator"];
    expect(p).toMatch(/通过 ≠ workflow 可用/);
    expect(p).toMatch(/仍然不校验/);
  });

  test("forbids .result on data nodes and deep paths into tool nodes", () => {
    const p = builtInPrompts["workflow-creator"];
    expect(p).toMatch(/禁止[^\n]*\.result/);
    expect(p).toMatch(/深层(属性)?路径/);
  });
});

/**
 * Task #4392 P0-5 — three process rules distilled from Task #4385.
 *
 * Each one exists because a real build failed without it. They are asserted as
 * *distinct* requirements so a future prompt rewrite cannot silently drop one
 * while keeping the others.
 */
describe("builtInPrompts['workflow-creator'] — P0-5 process rules (Task #4392)", () => {
  test("P0-5.1 requires per-node standalone smoke BEFORE assembling the workflow", () => {
    const p = builtInPrompts["workflow-creator"];
    // The rule: prove each node's command works on its own (exit code /
    // artifact dir / non-empty output) before wiring them into a DAG.
    // Rationale: Task #4385 §3.4 — builds failed on individual node commands
    // that had never been run in isolation; the first real execution happened
    // inside the whole workflow, so one bad node burned a full run.
    expect(p).toMatch(/单节点冒烟/);
    expect(p).toMatch(/逐个/);
    expect(p).toMatch(/exit code|退出码/);
    // It must say WHERE this happens relative to building the YAML.
    expect(p).toMatch(/组装|拼成|写成 workflow|写 YAML 之前|再写成/);
  });

  test("P0-5.2 forbids counting manual re-runs as workflow verification", () => {
    const p = builtInPrompts["workflow-creator"];
    // Task #4385 §3.5 — a node was "verified" by re-running its command by hand
    // after the workflow run failed, then reported as passing. Manual runs do
    // not exercise templating, dependency ordering, or the engine's timeout.
    expect(p).toMatch(/手动补跑/);
    expect(p).toMatch(/不算|不得计入|不计入/);
    // Must require an explicit disclaimer instead of a silent PASS.
    expect(p).toMatch(/未经 workflow run 验证|未经真跑验证/);
  });

  test("P0-5.3 requires distinguishing 'timeout' from another node's fail-fast", () => {
    const p = builtInPrompts["workflow-creator"];
    // Task #4385 §5 / #4361 / #4366 — two rounds were spent "fixing" a node
    // that looked like it hung, while a *different* node had failed first and
    // fail-fast had torn the run down.
    expect(p).toMatch(/超时/);
    expect(p).toMatch(/fail-fast|fail fast/i);
    // The burden of proof must be explicit, not advisory.
    expect(p).toMatch(/先证明|必须先确认|先排除/);
  });

  test("P0-5 cites the analysis it is derived from", () => {
    const p = builtInPrompts["workflow-creator"];
    // Traceability: the rules must point at their evidence, so a future editor
    // can re-derive them rather than treating them as folklore.
    expect(p).toMatch(/#4385/);
    expect(p).toMatch(/§3\.4|§3\.5|§5/);
  });
});
