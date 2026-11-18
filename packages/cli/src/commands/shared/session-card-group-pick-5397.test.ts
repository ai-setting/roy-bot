/**
 * Task #5397（CV 5397 M1）— session 卡首渲的「群 chatId」取值裁决
 *
 * ## 为什么需要这条测试
 *
 * CV 指出：改造后 session 卡首渲**同时**可能带上两个来源的群地址 ——
 * task 路径（`task.context.larkPerTaskChatId` → notifier state）和
 * session 路径（`findGroupChatForSession` → alias 反查）。
 *
 * 双真相源的实际危害：一个 session 既有 task（task 建过群 A），又被
 * session-only 建过群 B ⇒ 卡片显示 B，用户点「解散该群」散掉 B 而 task
 * 的群 A 还在；或相反 —— 都是错的信息。
 *
 * 因此 `pickGroupChatIdForSessionCard` 必须保证：**有 task 时一律不传
 * alias 反查结果**（交给 task 路径），无 task 才用 alias。
 */
import { describe, test, expect } from "bun:test";
import { pickGroupChatIdForSessionCard } from "./event-handler-wiring";

describe("Task #5397 M1 / 群 chatId 取值裁决", () => {
  test("有 task ⇒ 忽略 alias 反查结果（交给 task 路径，避免双真相源）", () => {
    const r = pickGroupChatIdForSessionCard({
      hasTask: true,
      fromAlias: "oc_from_alias",
    });
    expect(r).toBeUndefined();
  });

  test("无 task ⇒ 用 alias 反查结果", () => {
    const r = pickGroupChatIdForSessionCard({
      hasTask: false,
      fromAlias: "oc_session_only_group",
    });
    expect(r).toBe("oc_session_only_group");
  });

  test("无 task 且反查为空 ⇒ undefined（渲染「为本会话建群」）", () => {
    expect(pickGroupChatIdForSessionCard({ hasTask: false })).toBeUndefined();
    expect(
      pickGroupChatIdForSessionCard({ hasTask: false, fromAlias: "   " }),
    ).toBeUndefined();
  });
});
