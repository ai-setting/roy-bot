/**
 * Task #5050 (TDD, RED phase) — `compact_session` 唤醒机制补进 default agent prompt.
 *
 * 背景:
 * - `compact_session` 工具已存在并注册 (Task #4982, merge d898a6ab),
 *   allowedAgentTypes: ["default"], 入参 `session_id`。
 * - 但 `builtInPrompts['default']` 里 `compact_session` 出现 0 次:
 *   工具表没有它, 「子代理通知自主处理规则」里也没有 context 超限场景。
 * - 结果: sub-agent 报「Context threshold exceeded」时 default agent
 *   不知道该压缩, 静默失败 (实测 Task #5036 / #5041)。
 *
 * 验收要点:
 * - default prompt 的工具表必须含 `compact_session`
 * - default prompt 必须有「上下文超限」处置小节, 小节内同时出现
 *   `compact_session` 与 `sub_session_id` 两个关键词
 * - `roy` prompt 必须 **不含** `compact_session` (合规铁律: roy prompt 0 改动)
 */
import { describe, expect, test } from "vitest";
import { builtInPrompts } from "./prompts-index";

const defaultPrompt = builtInPrompts["default"];
const royPrompt = builtInPrompts["roy"];

/**
 * 抽取「## 你的工具」工具表区块（从行首标题到下一个二级标题为止）。
 * ⚠️ 必须用行首锚定的正则：`indexOf("## 你的工具")` 会命中「重要澄清」段里
 * 那句行内引用 `严格以下方"## 你的工具"区块中的工具表为准`，切错区块。
 */
function toolTableSection(prompt: string): string {
  const m = /^## 你的工具\n[\s\S]*?(?=\n## )/m.exec(prompt);
  expect(m, "必须有行首「## 你的工具」区块").not.toBeNull();
  return m![0];
}

/** 抽取「子代理通知自主处理规则」区块 */
function notificationSection(prompt: string): string {
  const start = prompt.indexOf("## 子代理通知自主处理规则");
  expect(start).toBeGreaterThan(-1);
  const rest = prompt.slice(start + "## 子代理通知自主处理规则".length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * 抽取新增的「4b 上下文超限通知」小节本身 (从 `### 4b` 到下一个 `###`/`##`)。
 * 只用整块 notificationSection 断言会误命中既有 4a 的 `sub_session_id` / ❌，
 * 所以顺序 / 格式 / 反模式 / 前置条件这几条一律锚定 4b 小节。
 */
function section4b(prompt: string): string {
  const m = /###\s*4b[^\n]*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/.exec(prompt);
  expect(m).not.toBeNull();
  return m![0];
}

describe("default prompt 工具表含 compact_session (Task #5050)", () => {
  test("工具表区块列出 compact_session 工具", () => {
    const table = toolTableSection(defaultPrompt);
    expect(table).toContain("compact_session");
  });

  test("工具表里 compact_session 出现在表格行中 (带反引号)", () => {
    const table = toolTableSection(defaultPrompt);
    expect(table).toMatch(/\|[^\n]*`compact_session`[^\n]*\|/);
  });

  test("工具表描述点明它用于压缩 sub-session 上下文", () => {
    const table = toolTableSection(defaultPrompt);
    expect(table).toMatch(/compact_session[\s\S]{0,400}压缩/);
  });

  test("工具表点明 compact_session 仅 default agent 可见", () => {
    const table = toolTableSection(defaultPrompt);
    expect(table).toMatch(/compact_session[\s\S]{0,400}(仅\s*default agent 可见|仅 default agent)/);
  });
});

describe("default prompt 含 compact_session 用法说明 (Task #5050)", () => {
  test("「执行工具使用规则」段解释 compact_session 何时使用", () => {
    const start = defaultPrompt.indexOf("### 执行工具使用规则");
    expect(start).toBeGreaterThan(-1);
    const rest = defaultPrompt.slice(start);
    const end = rest.search(/\n## /);
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section).toContain("compact_session");
    expect(section).toMatch(/compact_session[\s\S]{0,600}(context|上下文|超限)/i);
  });

  test("用法说明写明不能压缩当前会话自己", () => {
    const start = defaultPrompt.indexOf("### 执行工具使用规则");
    const rest = defaultPrompt.slice(start);
    const end = rest.search(/\n## /);
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section).toMatch(/不能.{0,20}(压缩|compact).{0,30}(自己|自身|current session)/);
  });

  test("用法说明写明 running/pending 后台任务不能压缩 (需先 stop_task)", () => {
    const start = defaultPrompt.indexOf("### 执行工具使用规则");
    const rest = defaultPrompt.slice(start);
    const end = rest.search(/\n## /);
    const section = end === -1 ? rest : rest.slice(0, end);
    expect(section).toMatch(/running|pending|运行中/);
    expect(section).toMatch(/stop_task/);
  });
});

describe("default prompt 含「上下文超限通知」处置小节 (Task #5050)", () => {
  const notifications = notificationSection(defaultPrompt);

  test("存在 4b 小节标题", () => {
    expect(notifications).toContain("4b");
    expect(notifications).toMatch(/上下文超限|context threshold/i);
  });

  test("小节内出现 compact_session 关键词", () => {
    expect(notifications).toContain("compact_session");
  });

  test("小节内出现 sub_session_id 关键词", () => {
    expect(notifications).toContain("sub_session_id");
  });

  test("小节给出识别形态 Context threshold exceeded: <used>/<limit> (<pct>%)", () => {
    expect(notifications).toMatch(/Context threshold exceeded/);
    expect(notifications).toMatch(/<\s*used\s*>|used/);
    expect(notifications).toMatch(/limit/);
    expect(notifications).toMatch(/%\)/);
  });

  test("小节规定处置顺序: 先压缩 → 再带 sub_session_id 续跑", () => {
    const s = section4b(defaultPrompt);
    const idxCompact = s.indexOf("compact_session");
    const idxResume = s.indexOf("sub_session_id");
    expect(idxCompact).toBeGreaterThan(-1);
    expect(idxResume).toBeGreaterThan(-1);
    expect(idxCompact).toBeLessThan(idxResume);
  });

  test("小节给出兜底: 压缩失败则开新 session 并列出已完成项/断点/小目标", () => {
    const s = section4b(defaultPrompt);
    expect(s).toMatch(/已完成项/);
    expect(s).toMatch(/断点/);
    expect(s).toMatch(/小目标/);
  });

  test("小节包含反模式警示 (从头重委托 / 反复用同一 session 续跑 / 压自己)", () => {
    const s = section4b(defaultPrompt);
    expect(s).toMatch(/❌/);
    expect(s).toMatch(/不要.{0,30}(从头|重新委托)/);
  });

  test("小节写明前置条件: query_background_process 确认 alive === false", () => {
    const s = section4b(defaultPrompt);
    expect(s).toContain("query_background_process");
    expect(s).toMatch(/alive\s*===\s*false|alive/);
  });
});

/**
 * Task #5050 追加要求 —— 用户决策「方案 3（不改代码，只改 prompt）」。
 *
 * 背景:
 * - 压缩前必须**先评估 session 大小**：session 太大时 compact_session 内部要跑两次
 *   全量 history 的 LLM 调用，可能撞 120s 工具超时 → 大 session 不要死磕，直接开新 session。
 * - 压缩撞 120s 工具超时 **≠ 压缩失败**：外层只是不再等了，底下仍在后台跑并可能成功。
 * - 开新 session 必须显式带「已完成项 / 断点 / 收窄后的小目标」，不能裸 delegate_task。
 */
describe("default prompt 含「压缩前先评估 session 规模」的决策流程 (Task #5050 追加)", () => {
  const s = section4b(defaultPrompt);

  test("出现「消息数」作为规模判断依据", () => {
    expect(s).toContain("消息数");
  });

  test("出现 session 规模分档 (大 / 小 或等价大小判断)", () => {
    expect(s).toMatch(/大/);
    expect(s).toMatch(/小/);
  });

  test("分档处置: 小 → compact_session 压缩续跑; 大 → 开新 session", () => {
    expect(s).toMatch(/小[\s\S]{0,300}compact_session/);
    expect(s).toMatch(/大[\s\S]{0,400}(开新|新 session|新会话)/);
  });

  test("写明成本主因是消息条数 (history 全量喂 LLM)", () => {
    expect(s).toMatch(/消息(条数|数)/);
    expect(s).toMatch(/主因|成本|全量/);
  });
});

describe("default prompt 含「压缩可能超时但实际成功」的处置说明 (Task #5050 追加)", () => {
  const s = section4b(defaultPrompt);

  test("出现「超时」+「实际成功」的等价表述", () => {
    expect(s).toMatch(/超时/);
    expect(s).toMatch(/实际成功|其实成功|后台.{0,20}(继续|完成)/);
  });

  test("说明超时后先别急着开新 session (要先复查)", () => {
    expect(s).toMatch(/别急|不要.{0,20}(直接|急着).{0,20}(开新|新 session)/);
    expect(s).toMatch(/复查|再检查|检查一次/);
  });

  test("给出复查手段: checkpointId / 消息数 / archived", () => {
    expect(s).toMatch(/checkpointId|checkpoint/);
    expect(s).toMatch(/消息数|archived/);
  });
});

describe("default prompt 的「开新 session」路径要求显式三要素 (Task #5050 追加)", () => {
  const s = section4b(defaultPrompt);

  test("要求显式带上 已完成项 / 断点 / 小目标", () => {
    expect(s).toMatch(/已完成项/);
    expect(s).toMatch(/断点/);
    expect(s).toMatch(/小目标/);
  });

  test("要求带上文件路径 / 已知结论", () => {
    expect(s).toMatch(/文件路径|文件/);
    expect(s).toMatch(/已知结论|结论/);
  });

  test("反模式: 裸 delegate_task 一句话「继续做 X」等于从零开始", () => {
    expect(s).toMatch(/❌/);
    expect(s).toMatch(/裸\s*`?delegate_task|裸\s*delegate_task|一句话/);
    expect(s).toMatch(/从零开始|等于从零/);
  });
});

describe("roy prompt 不受影响 (Task #5050 合规铁律)", () => {
  test("roy prompt 不含 compact_session", () => {
    expect(royPrompt).not.toContain("compact_session");
  });

  test("roy prompt 不含上下文超限处置小节", () => {
    expect(royPrompt).not.toMatch(/Context threshold exceeded/);
    expect(royPrompt).not.toContain("sub_session_id");
  });

  test("roy prompt 非空且保持原有长度量级", () => {
    expect(royPrompt).toBeDefined();
    expect(royPrompt.length).toBeGreaterThan(1000);
  });
});

/**
 * Task #5462 (TDD, RED phase) — 「4b. 上下文超限通知」优先级调整。
 *
 * 背景 (Task #5456 排查结论 RC-1):
 * - 8354ce86 (2026-11-05) 引入的措辞把「开新 session」写成了默认动作：
 *   代码示例 `// 不传 sub_session_id —— 开新 session`、
 *   判定表「大 → 直接开新 session」、
 *   反模式警示「不传 sub_session_id 直接 delegate_task」语气偏弱。
 * - 实证：该群 6 次新建 sub session 的 prompt 全部命中这套话术。
 *
 * 要求：
 * - 代码示例默认写出 sub_session_id（兜底注释说明何时才省略）
 * - 「开新 session」从默认动作降级为兜底路径
 * - 反模式警示里「不传 sub_session_id」上调为「最后手段」
 * - 判定表 / 压缩流程原有能力保留
 */
describe("4b 章节：sub_session_id 优先级调整 (Task #5462)", () => {
  const s = section4b(defaultPrompt);

  test("代码示例默认写出 sub_session_id", () => {
    // 兜底路径的代码示例里必须出现 sub_session_id 参数
    expect(s).toMatch(/delegate_task\(\{[\s\S]*?sub_session_id[\s\S]*?\}\)/);
  });

  test("代码示例含兜底注释（仅在 compact_session 也无效时才省略）", () => {
    expect(s).toMatch(/兜底路径：仅在\s*compact_session\s*也无效时才省略/);
  });

  test("「开新 session」降级为兜底路径（不再作为默认动作）", () => {
    // 兜底章节必须仍存在（保留原能力），但措辞强调它是兜底
    expect(s).toMatch(/兜底/);
    // 旧示例注释「不传 sub_session_id —— 开新 session」必须移除
    expect(s).not.toMatch(/不传\s*sub_session_id\s*——\s*开新\s*session/);
  });

  test("反模式警示把「不传 sub_session_id」上调为「最后手段」", () => {
    expect(s).toMatch(/不传\s*`?sub_session_id`?[\s\S]{0,80}最后手段|最后手段[\s\S]{0,80}不传\s*`?sub_session_id`?/);
  });

  test("判定表 / 压缩流程原有能力保留", () => {
    expect(s).toContain("compact_session");
    expect(s).toContain("query_background_process");
    expect(s).toMatch(/已完成项/);
    expect(s).toMatch(/断点/);
    expect(s).toMatch(/小目标/);
  });
});
