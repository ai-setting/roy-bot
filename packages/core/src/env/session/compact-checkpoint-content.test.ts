/**
 * @fileoverview C 方案：SessionCheckpoint 去结构化 — 纯函数单元测试
 *
 * 用户决策（飞书群 oc_4afcc8f93c811e5371dd00674d16a6b1）：
 *   「不是说不用结构化吗，要求章节的markdown应该也是结构化…有的话不符合预期哈」
 *   → checkpoint 不再有五栏位，正文是一整段自然语言 `content`。
 *
 * 覆盖：
 *   1. normalizeCheckpointContent — 降级哨兵/空文本拒绝
 *   2. buildCheckpointFromText — 整段自然语言 → { title, content }
 *   3. adaptLegacyCheckpoint — 旧格式（五栏位）→ 新格式（content）读时适配
 *   4. createCheckpointContent — checkpoint 消息正文渲染（无小节标题）
 */

import { describe, it, expect } from "bun:test";
import {
  normalizeCheckpointContent,
  buildCheckpointFromText,
  adaptLegacyCheckpoint,
  createCheckpointContent,
} from "./compact-checkpoint-content";
import type { SessionCheckpoint } from "./types";

describe("normalizeCheckpointContent — 守护：只判有没有实质文本", () => {
  it("接受正常自然语言正文", () => {
    const text = "本次会话完成了压缩机制改造，两阶段压缩已切换到自然语言输出。";
    expect(normalizeCheckpointContent(text)).toBe(text.trim());
  });

  it("拒绝空字符串与纯空白", () => {
    expect(normalizeCheckpointContent("")).toBeUndefined();
    expect(normalizeCheckpointContent("   \n\t  ")).toBeUndefined();
    expect(normalizeCheckpointContent(undefined)).toBeUndefined();
    expect(normalizeCheckpointContent(null)).toBeUndefined();
  });

  it("拒绝已知降级哨兵（不区分大小写）", () => {
    expect(normalizeCheckpointContent("[Hint extraction failed]")).toBeUndefined();
    expect(normalizeCheckpointContent("[hint extraction failed]")).toBeUndefined();
    expect(normalizeCheckpointContent("maximum iterations reached")).toBeUndefined();
    expect(normalizeCheckpointContent("Maximum Iterations Reached")).toBeUndefined();
    expect(normalizeCheckpointContent("No usable checkpoint output")).toBeUndefined();
  });

  it("拒绝长度低于阈值的占位文本（< 20 字符）", () => {
    expect(normalizeCheckpointContent("ok")).toBeUndefined();
    expect(normalizeCheckpointContent("done")).toBeUndefined();
  });

  it("接受恰好达到阈值的短正文", () => {
    const text = "压缩完成，本次共归档 12 条消息，上下文已保留。"; // > 20 chars
    expect(normalizeCheckpointContent(text)).toBeDefined();
  });
});

describe("buildCheckpointFromText — 整段自然语言 → checkpoint", () => {
  it("标题取首个 markdown 标题行", () => {
    const text = [
      "# lark-cli 多 profile 部署",
      "",
      "已完成 profile 选型与凭据写入，当前卡在用户身份 reply 的权限确认。",
      "下一步需要用户点授权链接。",
    ].join("\n");
    const cp = buildCheckpointFromText(text);
    expect(cp).toBeDefined();
    expect(cp!.title).toBe("lark-cli 多 profile 部署");
    expect(cp!.content).toContain("已完成 profile 选型与凭据写入");
    expect(cp!.content).toContain("下一步需要用户点授权链接");
  });

  it("无标题时取首个非空行作为标题", () => {
    const text = "会话围绕压缩机制展开：已完成 C 方案重写，待验证 resume。";
    const cp = buildCheckpointFromText(text);
    expect(cp).toBeDefined();
    expect(cp!.title.length).toBeGreaterThan(0);
    expect(cp!.content).toContain("C 方案重写");
  });

  it("标题超长时截断到 80 字符", () => {
    const longTitle = "超长标题" + "很长的内容".repeat(30);
    const cp = buildCheckpointFromText(`# ${longTitle}\n\n正文内容足够长，超过二十个字符的阈值。`);
    expect(cp!.title.length).toBeLessThanOrEqual(80);
  });

  it("content 保留整段原文（含列表、代码块等自由形式）", () => {
    const text = [
      "# 压缩机制改造",
      "",
      "关键决策：",
      "1. 去掉 JSON 工具调用",
      "2. checkpoint 退化为整段自然语言",
      "",
      "```bash",
      "bun test --parallel 4",
      "```",
      "",
      "当前状态：全部测试通过。",
    ].join("\n");
    const cp = buildCheckpointFromText(text);
    expect(cp!.content).toContain("```bash");
    expect(cp!.content).toContain("bun test --parallel 4");
    expect(cp!.content).toContain("1. 去掉 JSON 工具调用");
  });

  it("空文本 / 降级哨兵返回 undefined（不产出 checkpoint）", () => {
    expect(buildCheckpointFromText("")).toBeUndefined();
    expect(buildCheckpointFromText("[Hint extraction failed]")).toBeUndefined();
    expect(buildCheckpointFromText(undefined)).toBeUndefined();
  });
});

describe("adaptLegacyCheckpoint — 旧格式读时适配（不写回数据库）", () => {
  it("旧格式（五栏位）合成整段 content，语义完整保留", () => {
    const legacy: SessionCheckpoint = {
      id: "cp_old_1",
      messageIndex: 0,
      title: "TDD修复Resume响应传递问题",
      createdAt: 1777773105083,
      type: "compact",
      summary: "Process: resume 已验证\nState: 正在执行修复",
      processKeyPoints: [
        "Workflow resume功能已验证可用",
        "发现设计问题：用户响应未传递",
      ],
      currentState: "正在执行TDD规范的修复流程。",
      nextSteps: ["在resumeNode中读取消息", "编写测试用例验证"],
      userIntents: ["修复workflow resume功能"],
      messageCountBefore: 273,
    } as unknown as SessionCheckpoint;

    const adapted = adaptLegacyCheckpoint(legacy);

    // 新形态：content 是整段自然语言
    expect(adapted.content).toBeDefined();
    expect(typeof adapted.content).toBe("string");
    expect(adapted.content).toContain("Workflow resume功能已验证可用");
    expect(adapted.content).toContain("用户响应未传递");
    expect(adapted.content).toContain("正在执行TDD规范的修复流程");
    expect(adapted.content).toContain("在resumeNode中读取消息");
    expect(adapted.content).toContain("修复workflow resume功能");
    expect(adapted.content.length).toBeGreaterThan(20);

    // 元数据保留
    expect(adapted.id).toBe("cp_old_1");
    expect(adapted.title).toBe("TDD修复Resume响应传递问题");
    expect(adapted.messageCountBefore).toBe(273);
    expect(adapted.createdAt).toBe(1777773105083);
    expect(adapted.type).toBe("compact");
    expect(adapted.messageIndex).toBe(0);
  });

  it("旧格式部分栏位缺失时也能合成（空栏位跳过）", () => {
    const legacy = {
      id: "cp_old_2",
      messageIndex: 5,
      title: "部分填充",
      createdAt: 123,
      type: "compact",
      summary: "",
      processKeyPoints: ["只有这一个要点，内容要足够长以通过守护阈值检查"],
      currentState: "",
      nextSteps: [],
      userIntents: [],
      messageCountBefore: 10,
    } as unknown as SessionCheckpoint;

    const adapted = adaptLegacyCheckpoint(legacy);
    expect(adapted.content).toContain("只有这一个要点");
    expect(adapted.title).toBe("部分填充");
  });

  it("新格式（已有 content）原样返回，不做二次加工", () => {
    const modern: SessionCheckpoint = {
      id: "cp_new_1",
      messageIndex: 0,
      title: "新格式",
      content: "这是新格式的整段正文，包含全部语义信息，长度超过阈值。",
      createdAt: 123,
      type: "compact",
      messageCountBefore: 5,
    };

    const adapted = adaptLegacyCheckpoint(modern);
    expect(adapted).toBe(modern); // 原对象返回（引用相等）
  });

  it("旧格式对象不被原地修改（适配是纯函数）", () => {
    const legacy: any = {
      id: "cp_old_3",
      messageIndex: 0,
      title: "不可变检查",
      createdAt: 1,
      type: "compact",
      summary: "Process: X\nState: Y",
      processKeyPoints: ["要点甲，内容足够长以通过守护阈值检查"],
      currentState: "状态",
      nextSteps: ["步骤一"],
      userIntents: [],
      messageCountBefore: 3,
    };
    const snapshot = JSON.stringify(legacy);
    adaptLegacyCheckpoint(legacy);
    expect(JSON.stringify(legacy)).toBe(snapshot);
    expect((legacy as any).content).toBeUndefined(); // 原对象没有 content
  });
});

describe("createCheckpointContent — checkpoint 消息正文渲染", () => {
  it("新格式：# Checkpoint 标题 + 整段 content + 归档统计，无伪造小节", () => {
    const cp: SessionCheckpoint = {
      id: "cp_r_1",
      messageIndex: 0,
      title: "压缩验证",
      content: "完成了两阶段压缩改造。\n\n关键点：\n- 去结构化\n- 读时适配旧格式",
      createdAt: 1700000000000,
      type: "compact",
      messageCountBefore: 42,
    };

    const content = createCheckpointContent(cp);
    expect(content).toContain("# Checkpoint: 压缩验证");
    expect(content).toContain("完成了两阶段压缩改造。");
    expect(content).toContain("- 去结构化");
    expect(content).toContain("42 messages compacted");
    // 不应伪造五小节标题
    expect(content).not.toContain("## Process Key Points");
    expect(content).not.toContain("## Current State");
    expect(content).not.toContain("## Next Steps");
    expect(content).not.toContain("## User Intents");
    expect(content).not.toContain("## Summary");
  });

  it("旧格式经适配后渲染：content 来自合成正文", () => {
    const legacy = {
      id: "cp_r_2",
      messageIndex: 0,
      title: "旧格式渲染",
      createdAt: 1700000000001,
      type: "compact",
      summary: "Process: A\nState: B",
      processKeyPoints: ["要点一，内容足够长以通过守护阈值检查"],
      currentState: "当前状态描述",
      nextSteps: [],
      userIntents: [],
      messageCountBefore: 7,
    } as unknown as SessionCheckpoint;
    const adapted = adaptLegacyCheckpoint(legacy);
    const content = createCheckpointContent(adapted);
    expect(content).toContain("# Checkpoint: 旧格式渲染");
    expect(content).toContain("要点一");
    expect(content).toContain("7 messages compacted");
    expect(content).not.toContain("## Process Key Points");
  });
});
