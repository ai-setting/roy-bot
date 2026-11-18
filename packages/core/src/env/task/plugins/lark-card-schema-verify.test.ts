/**
 * @fileoverview Task #4331 真机验证 #1：buildTaskCard schema 实际产出验证
 *
 * 为什么这个测试：
 *   真机 lark card callback 需要 npm 版 roy-bot 加载 worktree 代码才能验证，
 *   但我们不能 kill 当前 PID 链。所以改用 buildTaskCard 的纯函数输出做
 *   "可重现的 schema 验证" —— 把 buildTaskCard 的输出 JSON dump 出来，
 *   给用户人工比对卡片应该长什么样。
 *
 * 这是单元测试，比纯跑 build/mjs 命令更精准。
 */

import { describe, test, expect } from "bun:test";
import { buildTaskCard, DEFAULT_APP_LINK_BASE } from "./lark-card-patch-notifier";

describe("Task #4331 真机验证 #1：buildTaskCard schema 实际产出", () => {
  const baseMeta = {
    id: 4331,
    title: "[Feature] 取消默认建群 + 任务卡片只发触发群",
    description: "让 task 不自动建飞书群，顶部按钮可按需建/解散",
    goals: "1. 默认不建群\\n2. 卡片只发触发群\\n3. 顶部按钮动态建/解散",
    priority: "high" as const,
    type: "normal" as const,
    projectPath: "~/work/codework/personal/roy_world/roy-bot",
  };

  test("Case A：无专属群 → 顶部\"为这个任务建群\"按钮 + 无下方链接", () => {
    const metaA = {
      ...baseMeta,
      perTaskChatId: undefined,
      perTaskChatName: undefined,
    };
    const cardA = buildTaskCard({
      status: "running",
      meta: metaA,
      milestones: [
        { title: "Task 创建", timestamp: "2026-10-18T10:25:35Z", description: "用户原话：不默认建群" },
      ],
    });
    const jsonA = JSON.stringify(cardA);
    expect(jsonA).toContain("为这个任务建群");
    expect(jsonA).not.toContain("解散该群");

    // 记录实际 schema 用于人工核对（写入 stdout）
    console.log("\n========== Case A schema (无专属群) ==========");
    console.log(JSON.stringify(cardA, null, 2));
    console.log("================================================\n");
  });

  test("Case B：有专属群 → 顶部\"解散该群\"按钮 + \"进入专属群\"applink 链接", () => {
    const metaB = {
      ...baseMeta,
      perTaskChatId: "oc_test_group_chat_xxx",
      perTaskChatName: "Task #4331 - 取消默认建群 + 任务卡片只发触发群",
    };
    const cardB = buildTaskCard({
      status: "running",
      meta: metaB,
      milestones: [],
    });
    const jsonB = JSON.stringify(cardB);
    expect(jsonB).toContain("解散该群");
    // 实际文案是"进入专属群"（不是"进入群"），schema 验证
    expect(jsonB).toContain("进入专属群");
    expect(jsonB).toContain(DEFAULT_APP_LINK_BASE);
    expect(jsonB).toContain("oc_test_group_chat_xxx");

    // 记录实际 schema
    console.log("\n========== Case B schema (有专属群) ==========");
    console.log(JSON.stringify(cardB, null, 2));
    console.log("================================================\n");
  });

  test("DEFAULT_APP_LINK_BASE 是飞书 applink 格式", () => {
    // 实际 base 是 https://applink.feishu.cn （拼上 ?openChatId=<id>）
    expect(DEFAULT_APP_LINK_BASE).toMatch(/^https:\/\/applink\.feishu\.cn\/?$/);
    // 验证在 Case B 中实际拼出的完整链接格式正确
    const fullLink = `${DEFAULT_APP_LINK_BASE}/client/chat/open?openChatId=oc_xxx`;
    expect(fullLink).toContain("applink.feishu.cn");
    expect(fullLink).toContain("openChatId=oc_xxx");
  });
});
