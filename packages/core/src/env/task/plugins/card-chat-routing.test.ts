/**
 * @fileoverview card-chat-routing 测试（Task #4394 简化版）
 *
 * ## 现行规则（用户 2026-10-20 明令）
 *
 * > 去掉专属群卡片逻辑，只保留触发群的进度卡片（可用户点击建群）
 *
 * 1. **有触发群 → 就用触发群**（无条件，不再判定"是不是别的 task 的专属群"）
 * 2. 没有触发群 → 用本 task（或祖先）已有的专属群兜底
 * 3. 都没有 → none
 *
 * ## Task #4394 删除的历史逻辑
 *
 * - `ChatOwnership` / `mergeChatOwnership` / `analyzeContextOwnership`
 *   （「这个群是不是某个 task 的专属群」的归属判定）
 * - `CardChatDecision.reroutedFrom`（改投记录）
 * - `new-group` / `fallback-to-trigger` 两种 source（不再自动建群）
 * - `buildRedirectCard` / `sendRedirectNotice`（「已改投专属群」指路卡）
 *
 * ## 保留
 *
 * - `extractPerTaskChatId` / `extractPerTaskChatProfile` / `extractPerTaskChatName`
 *   （卡片要显示"进入专属群"链接，仍需要读 task.context 的群字段）
 * - `extractRecordedChatNames`（卡片"专属群名"栏位渲染）
 * - `GROUP_NAME_TASK_ID_RE`（群名 → task id 解析，buildTaskMeta 用）
 */

import { describe, it, expect } from "bun:test";
import {
  decideCardChatTarget,
  extractPerTaskChatId,
  extractPerTaskChatName,
  extractPerTaskChatProfile,
  extractRecordedChatNames,
  GROUP_NAME_TASK_ID_RE,
} from "./card-chat-routing";

const TRIGGER = "oc_8947d9e26125514e1ae34cf69c499380"; // 用户截图里的触发群
const OWN_GROUP = "oc_own4394group0000000000000000";
const ANCESTOR_GROUP = "oc_ancestor43890000000000000000";

// ========================================================================
// context 解析 helper（保留能力）
// ========================================================================

describe("card-chat-routing / context 解析", () => {
  it("extractPerTaskChatId 解析 larkPerTaskChatId", () => {
    expect(extractPerTaskChatId(JSON.stringify({ larkPerTaskChatId: OWN_GROUP }))).toBe(
      OWN_GROUP
    );
    expect(extractPerTaskChatId("bad-json")).toBeUndefined();
    expect(extractPerTaskChatId(undefined)).toBeUndefined();
    expect(extractPerTaskChatId(JSON.stringify({ larkPerTaskChatId: "" }))).toBeUndefined();
  });

  it("extractPerTaskChatName / Profile 解析", () => {
    const ctx = JSON.stringify({
      larkPerTaskChatName: "Task 4394 - x",
      larkPerTaskChatProfile: "tongzhuli",
    });
    expect(extractPerTaskChatName(ctx)).toBe("Task 4394 - x");
    expect(extractPerTaskChatProfile(ctx)).toBe("tongzhuli");
    expect(extractPerTaskChatName("bad-json")).toBeUndefined();
    expect(extractPerTaskChatProfile("bad-json")).toBeUndefined();
  });

  it("extractRecordedChatNames 收集所有 *chat_name 字段", () => {
    const ctx = JSON.stringify({
      feishu_followup_chat_name: "#3999 X",
      larkPerTaskChatName: "Task 4394 - y",
      not_a_name: "忽略",
    });
    const names = extractRecordedChatNames(ctx);
    expect(names).toContain("#3999 X");
    expect(names).toContain("Task 4394 - y");
    expect(names).not.toContain("忽略");
    expect(extractRecordedChatNames("bad-json")).toEqual([]);
  });

  it("GROUP_NAME_TASK_ID_RE 从群名提取 task id", () => {
    expect("Task 3999 - 多模态ontology提取跟进".match(GROUP_NAME_TASK_ID_RE)?.[1]).toBe("3999");
    expect("#3999 TMO 提取跟进".match(GROUP_NAME_TASK_ID_RE)?.[1]).toBe("3999");
    expect("Task #4226".match(GROUP_NAME_TASK_ID_RE)?.[1]).toBe("4226");
    expect("laya-mlx".match(GROUP_NAME_TASK_ID_RE)).toBeNull();
    // 纯数字（无 Task/# 前缀）不应误判（避免把 "0715 周会" 当成 task 715）
    expect("0715 周会".match(GROUP_NAME_TASK_ID_RE)).toBeNull();
  });
});

// ========================================================================
// 决策：触发群永远优先（Task #4394 核心行为）
// ========================================================================

describe("card-chat-routing / 路由决策（Task #4394）", () => {
  it("★ 有触发群 → 永远用触发群，即使本 task 已有自己的群", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: OWN_GROUP, profile: "tongzhuli", isSelf: true },
      triggerChatId: TRIGGER,
      triggerProfile: "tongzhuli",
    });
    expect(d.source).toBe("trigger-chat");
    expect(d.chatId).toBe(TRIGGER);
    expect(d.profile).toBe("tongzhuli");
  });

  it("★ 有触发群 + 只有祖先有群 → 仍用触发群（不改投祖先群）", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: ANCESTOR_GROUP, profile: "p", isSelf: false },
      triggerChatId: TRIGGER,
    });
    expect(d.source).toBe("trigger-chat");
    expect(d.chatId).toBe(TRIGGER);
  });

  it("★ 触发群是普通会话群 → 触发群（happy path 不回归）", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393],
      triggerChatId: TRIGGER,
    });
    expect(d.source).toBe("trigger-chat");
    expect(d.chatId).toBe(TRIGGER);
  });

  it("★ 没有触发群 → 用本 task 自己的群兜底", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393],
      lineageChat: { chatId: OWN_GROUP, profile: "tongzhuli", isSelf: true },
    });
    expect(d.source).toBe("own-group");
    expect(d.chatId).toBe(OWN_GROUP);
  });

  it("★ 没有触发群 → 用最近祖先的群兜底", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: ANCESTOR_GROUP, profile: "p", isSelf: false },
    });
    expect(d.source).toBe("ancestor-group");
    expect(d.chatId).toBe(ANCESTOR_GROUP);
  });

  it("★ 触发群和 lineage 群都没有 → none（caller 静默 skip）", () => {
    const d = decideCardChatTarget({ taskId: 4393, lineageIds: [4393] });
    expect(d.source).toBe("none");
    expect(d.chatId).toBeUndefined();
  });

  it("★ 决策结果里不再有 reroutedFrom 字段", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: OWN_GROUP, profile: "p", isSelf: true },
      triggerChatId: TRIGGER,
    });
    expect((d as unknown as Record<string, unknown>)["reroutedFrom"]).toBeUndefined();
  });

  it("★ 即使调用方硬塞旧字段（ownership / allowNewGroup）也不改变决策", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: OWN_GROUP, profile: "p", isSelf: true },
      triggerChatId: TRIGGER,
      // 旧 API 字段（已删除），用 any 透传验证不影响
      ...({
        triggerOwnership: {
          chatId: TRIGGER,
          ownerTaskIds: [4377],
          sources: ["chat-name"],
          dedicated: true,
        },
        allowNewGroup: true,
      } as any),
    } as any);
    expect(d.source).toBe("trigger-chat");
    expect(d.chatId).toBe(TRIGGER);
  });

  it("★ reason 文案说明不做改投，不含真正的改投描述", () => {
    const d = decideCardChatTarget({
      taskId: 4393,
      lineageIds: [4393, 4389],
      lineageChat: { chatId: OWN_GROUP, profile: "p", isSelf: true },
      triggerChatId: TRIGGER,
    });
    // 允许出现"不改投"这类否定说明，但不允许出现真正的改投描述
    expect(d.reason).not.toContain("改投 lineage 群");
    expect(d.reason).not.toContain("是 task 4377 的专属群");
    expect(d.reason).toContain("触发群");
  });
});
