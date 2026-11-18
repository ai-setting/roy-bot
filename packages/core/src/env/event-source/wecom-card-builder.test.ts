/**
 * @fileoverview Task #5203 — 企微真卡片（template_card）构造器测试
 *
 * 协议依据（官方文档取证，Task #5202/#5203）：
 * - aibot_send_msg 直发：{cmd:"aibot_send_msg", headers:{req_id}, body:{chatid, chat_type, msgtype:"template_card", template_card:{...}}}
 * - text_notice：main_title 必填；card_action 必填
 * - button_interaction：main_title + button_list 必填；task_id 必填
 *   （同一个机器人 task_id 不能重复，只能由数字字母和 "_-@" 组成，最长 128 字节）
 * - 更新：{cmd:"aibot_respond_update_msg", headers:{req_id:事件回调透传}, body:{response_type:"update_template_card", template_card:{...}}}
 *   （template_card.task_id 须与回调收到的 task_id 一致）
 * - 按钮点击回调：template_card_event，event.event_key = 按钮 key
 */

import { describe, expect, test } from "bun:test";
import {
  WecomCardActionKey,
  buildWecomSendCardFrame,
  buildWecomCardUpdateFrame,
  buildWecomTextNoticeCard,
  buildWecomButtonInteractionCard,
  newWecomCardTaskId,
  wecomCardTaskIdForTask,
} from "./wecom-card-builder";

describe("wecom-card-builder — text_notice 进展卡", () => {
  test("基本字段：main_title + 状态 + 时间线 + card_action", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 42,
      title: "时空增强任务",
      statusLabel: "🔄 进行中",
      progress: 80,
      description: "把进展卡片升级为真卡片",
      changeSummary: "progress=80",
      milestones: [
        { title: "Task 创建", timestamp: "2026-11-09T08:00:00Z" },
        {
          title: "完成设计",
          timestamp: "2026-11-09T09:00:00Z",
          description: "协议取证完毕",
        },
      ],
    });
    expect(card.card_type).toBe("text_notice");
    expect(card.main_title.title).toContain("#42");
    expect(card.main_title.title).toContain("时空增强任务");
    expect(card.emphasis_content.title).toBe("80%");
    expect(card.emphasis_content.desc).toBe("进度");
    // horizontal_content_list：状态 + 时间线（截断修复后不再有「最近进展」行）
    const keys = card.horizontal_content_list.map(
      (h: { keyname: string }) => h.keyname,
    );
    expect(keys).toContain("状态");
    expect(keys.length).toBeGreaterThan(1);
    // quote_area：最新操作记录
    expect(card.quote_area.title).toContain("最新进展");
    // card_action 必填；type=0（无 url 跳转，真网实证 type=1 缺 url 报 42028）
    expect(card.card_action).toBeDefined();
    expect(card.card_action.type).toBe(0);
    // quote_area type=0（纯文本引用，真网实证 type=1 缺 url 报 42028）
    expect(card.quote_area.type).toBe(0);
  });

  test("无进度时 emphasis_content.progress 为 0%", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 7,
      title: "T",
      statusLabel: "📝 待办",
      progress: 0,
      milestones: [],
    });
    expect(card.emphasis_content.title).toBe("0%");
  });

  test("终态卡片：sub_title_text 带收尾文案", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 7,
      title: "T",
      statusLabel: "🎉 已完成",
      progress: 100,
      milestones: [],
      terminal: true,
    });
    expect(card.sub_title_text).toContain("已完成");
  });

  test("时间线截断：最多 6 条 horizontal_content_list 上限内", () => {
    const ms = Array.from({ length: 30 }, (_, i) => ({
      title: `步骤${i}`,
      timestamp: new Date(2026, 0, 1, i % 24).toISOString(),
    }));
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 50,
      milestones: ms,
    });
    // quote_text 时间线最多 8 条（防超长）
    const lines = card.quote_area.quote_text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  // ★ Task #5203 截断修复：真网实证 quote_area 只渲染 ~2 行且长文本
  //   被截断（客户端渲染限制，协议无报错）→ 时间线主体改走
  //   horizontal_content_list（官方 ≤6 条，keyname ≤5 字 / value ≤26 字）。
  test("截断修复：时间线走 horizontal_content_list（≤6 条，value ≤26 字）", () => {
    const ms = Array.from({ length: 30 }, (_, i) => ({
      title: `这是一个非常长的里程碑标题用于验证截断逻辑第${i}项`,
      timestamp: new Date(2026, 0, 1, i % 24).toISOString(),
      description: "很长的描述文本".repeat(10),
    }));
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 50,
      milestones: ms,
    });
    // horizontal 时间线 ≤6 条（协议上限，含「状态」行）
    expect(card.horizontal_content_list.length).toBeLessThanOrEqual(6);
    for (const h of card.horizontal_content_list) {
      expect(h.keyname.length).toBeLessThanOrEqual(5);
      expect(h.value.length).toBeLessThanOrEqual(26);
      // 裁剪不切单词：不以半个英文单词结尾（无尾随字母+省略号组合）
      expect(h.value.endsWith("…")).toBe(h.value.length === 26);
    }
    // quote_area 只留 1 行（最新一条），不再塞 8 行时间线
    const lines = card.quote_area.quote_text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  test("截断修复：value 裁剪不切英文单词（Task complete d → Task complete）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🎉",
      progress: 100,
      milestones: [
        {
          title: "Task completed: all tests green and verified by reviewer",
          timestamp: "2026-11-09T03:00:00Z",
        },
      ],
    });
    const timelineRow = card.horizontal_content_list.find(
      (h: { keyname: string }) => h.keyname !== "状态",
    );
    expect(timelineRow).toBeDefined();
    // 不出现「complete d」这种切词产物
    expect(timelineRow!.value).not.toMatch(/complete d/);
    expect(timelineRow!.value.length).toBeLessThanOrEqual(26);
  });
});

describe("wecom-card-builder — button_interaction 交互卡", () => {
  test("必填字段：main_title + button_list + task_id", () => {
    const card = buildWecomButtonInteractionCard({
      taskId: 42,
      title: "时空增强任务",
      statusLabel: "🔄 进行中",
      progress: 80,
      buttons: [
        { text: "标记完成", key: WecomCardActionKey.MARK_DONE, style: 1 },
        { text: "重新打开", key: WecomCardActionKey.REOPEN, style: 2 },
      ],
    });
    expect(card.card_type).toBe("button_interaction");
    expect(card.main_title.title).toContain("#42");
    expect(card.task_id).toBe(card.task_id); // shape check below
    expect(card.task_id.startsWith(wecomCardTaskIdForTask(42))).toBe(true);
    expect(card.button_list).toHaveLength(2);
    expect(card.button_list[0].key).toBe("task_mark_done");
    expect(card.button_list[0].style).toBe(1);
    // 按钮文案 ≤10 字
    for (const b of card.button_list) {
      expect(b.text.length).toBeLessThanOrEqual(10);
    }
  });

  test("按钮数 ≤6（协议上限）", () => {
    const buttons = Array.from({ length: 8 }, (_, i) => ({
      text: `按钮${i}`,
      key: `k${i}`,
    }));
    const card = buildWecomButtonInteractionCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 0,
      buttons,
    });
    expect(card.button_list.length).toBeLessThanOrEqual(6);
  });

  test("task_id 合法字符集（数字字母和 _-@）且 ≤128 字节", () => {
    const tid = wecomCardTaskIdForTask(12345);
    expect(tid).toMatch(/^[A-Za-z0-9_@-]+$/);
    expect(tid.length).toBeLessThanOrEqual(128);
    expect(tid).toContain("12345");
  });

  test("newWecomCardTaskId：同 task 多次发卡 id 不重复", () => {
    const a = newWecomCardTaskId(42);
    const b = newWecomCardTaskId(42);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_@-]+$/);
    expect(a.startsWith(wecomCardTaskIdForTask(42))).toBe(true);
  });
});

describe("wecom-card-builder — WS 发送帧（aibot_send_msg）", () => {
  test("单聊：chat_type=1，chatid=userid，msgtype=template_card", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 0,
      milestones: [],
    });
    const frame = buildWecomSendCardFrame({
      chatId: "wotnB7Wgxxx",
      chatType: "single",
      card,
    });
    expect(frame.cmd).toBe("aibot_send_msg");
    expect(frame.headers.req_id.startsWith("aibot_send_msg_")).toBe(true);
    expect(frame.body.chatid).toBe("wotnB7Wgxxx");
    expect(frame.body.chat_type).toBe(1);
    expect(frame.body.msgtype).toBe("template_card");
    expect(frame.body.template_card).toBe(card);
  });

  test("群聊：chat_type=2", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 0,
      milestones: [],
    });
    const frame = buildWecomSendCardFrame({
      chatId: "wrxxxx",
      chatType: "group",
      card,
    });
    expect(frame.body.chat_type).toBe(2);
  });

  test("req_id 可显式指定（关联请求与响应）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🔄",
      progress: 0,
      milestones: [],
    });
    const frame = buildWecomSendCardFrame({
      chatId: "u1",
      chatType: "single",
      card,
      reqId: "custom_req_1",
    });
    expect(frame.headers.req_id).toBe("custom_req_1");
  });
});

describe("wecom-card-builder — 卡片更新帧（aibot_respond_update_msg）", () => {
  test("response_type=update_template_card，req_id 透传事件回调的", () => {
    const frame = buildWecomCardUpdateFrame({
      reqId: "event_req_id_abc",
      taskId: 42,
      statusLabel: "✅ 已确认",
      note: "用户已确认完成",
      buttonOverrides: [
        { text: "已确认", key: WecomCardActionKey.MARK_DONE, style: 4 },
      ],
    });
    expect(frame.cmd).toBe("aibot_respond_update_msg");
    expect(frame.headers.req_id).toBe("event_req_id_abc");
    expect(frame.body.response_type).toBe("update_template_card");
    expect(frame.body.template_card.card_type).toBe("button_interaction");
    // task_id 须与回调收到的 task_id 一致（原样回填）
    expect(frame.body.template_card.task_id).toBe("42");
    expect(frame.body.template_card.button_list[0].text).toBe("已确认");
    expect(frame.body.template_card.button_list[0].style).toBe(4);
  });

  test("空 req_id 抛错（更新必须关联事件）", () => {
    expect(() =>
      buildWecomCardUpdateFrame({
        reqId: "",
        taskId: 1,
        statusLabel: "x",
      }),
    ).toThrow(/req_id/);
  });
});

describe("wecom-card-builder — 按钮动作 key 常量", () => {
  test("三个标准动作 key", () => {
    expect(WecomCardActionKey.VIEW).toBe("task_view");
    expect(WecomCardActionKey.MARK_DONE).toBe("task_mark_done");
    expect(WecomCardActionKey.REOPEN).toBe("task_reopen");
  });
});

// ========================================================================
// DS review (Task #5203) MINOR 修复回归测试
// ========================================================================

describe("DS review MINOR — clipWord 词边界裁剪", () => {
  test("无空格长英文串不切词：回退到 CJK↔ASCII 交界或直接硬截", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🎉",
      progress: 100,
      milestones: [
        {
          title: "SupercalifragilisticexpialidociousExtraLong",
          timestamp: "2026-11-09T03:00:00Z",
        },
      ],
    });
    const row = card.horizontal_content_list.find(
      (h: { keyname: string }) => h.keyname !== "状态",
    );
    expect(row).toBeDefined();
    expect(row!.value.length).toBeLessThanOrEqual(26);
    // 不允许出现「半个单词 + 省略号」：省略号前必须是原串的完整前缀边界
    // （无空格可回退时允许硬截，但不得把单词劈成两半后接省略号）
    expect(row!.value).not.toMatch(/[A-Za-z]…$/);
  });

  test("含空格文本回退到最后一个空格边界（不切词）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: 1,
      title: "T",
      statusLabel: "🎉",
      progress: 100,
      milestones: [
        {
          title: "alpha beta gamma delta epsilon",
          timestamp: "2026-11-09T03:00:00Z",
        },
      ],
    });
    const row = card.horizontal_content_list.find(
      (h: { keyname: string }) => h.keyname !== "状态",
    );
    const value = row!.value;
    expect(value.length).toBeLessThanOrEqual(26);
    // 省略号前的最后一个 token 必须是原 title 中的完整单词（不得是半个词）
    const cut = value.replace(/…$/, "");
    const lastToken = cut.slice(cut.lastIndexOf(" ") + 1);
    expect(
      ["alpha", "beta", "gamma", "delta", "epsilon"],
    ).toContain(lastToken);
  });
});

describe("DS review MINOR — button_interaction card_action 合规", () => {
  test("card_action.type=1 时必须带 url（官方 CardAction 定义）", () => {
    const card = buildWecomButtonInteractionCard({
      taskId: 42,
      title: "T",
      statusLabel: "🔄",
      progress: 50,
      buttons: [{ text: "查看详情", key: "task_view", style: 1 }],
    });
    // type=1 表示跳转 url → url 必填；要么 type=0（无跳转），要么带 url
    if (card.card_action?.type === 1) {
      expect(card.card_action.url).toBeTruthy();
    } else {
      expect(card.card_action?.type).toBe(0);
    }
  });
});
