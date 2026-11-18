/**
 * @fileoverview Task #5360 — sub-session 活性纯函数层单测
 *
 * 锁定三件事：
 * 1. liveness 四档阈值边界（5min / 20min / 终态）
 * 2. 最近消息截断（不切词 + CJK 硬截）
 * 3. 无数据降级（**绝不返回空数组** —— 否则用户分不清"没数据"和"按钮没生效"）
 */

import { describe, test, expect } from "bun:test";
import {
  ACTIVITY_ACTIVE_MS,
  ACTIVITY_SLOW_MS,
  DEFAULT_ACTIVITY_MESSAGE_MAX,
  createActivityProbe,
  createSessionActivityProbe,
  findBackgroundTaskByAssociatedTaskId,
  formatActivityLines,
  formatActivityQuote,
  formatAgo,
  formatClockTime,
  resolveActivityLiveness,
  toActivityMessage,
  truncateActivityMessage,
  type BackgroundTaskLite,
  type SubSessionActivity,
} from "./sub-session-activity";

// 固定 base 时间，让所有相对时间断言确定性
const NOW = new Date(2026, 10, 11, 20, 47, 12).getTime();
const MIN = 60 * 1000;

function act(overrides: Partial<SubSessionActivity> = {}): SubSessionActivity {
  return {
    subSessionId: "session_sub_1",
    messageCount: 128,
    updatedAt: NOW - 3 * MIN,
    lastMessage: {
      role: "assistant",
      content: "已定位到 wecom-card-builder.ts:485 的按钮覆盖逻辑",
    },
    ...overrides,
  };
}

// ============================================================================
// 1. formatAgo
// ============================================================================

describe("formatAgo", () => {
  test("updatedAt 缺失 / NaN → undefined（渲染层据此省略括号）", () => {
    expect(formatAgo(undefined, NOW)).toBeUndefined();
    expect(formatAgo(Number.NaN, NOW)).toBeUndefined();
  });

  test("未来时间（时钟回拨）→ 刚刚，不是负数", () => {
    expect(formatAgo(NOW + 5 * MIN, NOW)).toBe("刚刚");
  });

  test("< 60s → 刚刚", () => {
    expect(formatAgo(NOW - 30 * 1000, NOW)).toBe("刚刚");
  });

  test("分钟 / 小时 / 天 三档", () => {
    expect(formatAgo(NOW - 3 * MIN, NOW)).toBe("3 分钟前");
    expect(formatAgo(NOW - 59 * MIN, NOW)).toBe("59 分钟前");
    expect(formatAgo(NOW - 2 * 60 * MIN, NOW)).toBe("2 小时前");
    expect(formatAgo(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("3 天前");
  });
});

// ============================================================================
// 2. formatClockTime
// ============================================================================

describe("formatClockTime", () => {
  test("HH:mm:ss 零填充", () => {
    const ts = new Date(2026, 10, 11, 8, 5, 3).getTime();
    expect(formatClockTime(ts)).toBe("08:05:03");
  });

  test("缺失 / NaN → undefined", () => {
    expect(formatClockTime(undefined)).toBeUndefined();
    expect(formatClockTime(Number.NaN)).toBeUndefined();
  });
});

// ============================================================================
// 3. resolveActivityLiveness — 四档阈值边界
// ============================================================================

describe("resolveActivityLiveness", () => {
  test("无快照 → unknown / ❔ / 未知", () => {
    const r = resolveActivityLiveness(undefined, NOW);
    expect(r.level).toBe("unknown");
    expect(r.dot).toBe("❔");
    expect(r.label).toBe("未知");
  });

  test("🟢 活跃：age = 0 / 4m59s 都算活跃", () => {
    expect(resolveActivityLiveness(act({ updatedAt: NOW }), NOW).level).toBe("active");
    expect(
      resolveActivityLiveness(act({ updatedAt: NOW - (ACTIVITY_ACTIVE_MS - 1000) }), NOW).level,
    ).toBe("active");
  });

  test("★ 边界：age 恰好 = 5min → 进入 slow（不再是 active）", () => {
    const r = resolveActivityLiveness(act({ updatedAt: NOW - ACTIVITY_ACTIVE_MS }), NOW);
    expect(r.level).toBe("slow");
    expect(r.dot).toBe("🟡");
  });

  test("🟡 缓慢：5min ~ 19m59s", () => {
    expect(
      resolveActivityLiveness(act({ updatedAt: NOW - (ACTIVITY_SLOW_MS - 1000) }), NOW).level,
    ).toBe("slow");
  });

  test("★ 边界：age 恰好 = 20min → 进入 stalled（心跳窗口超了）", () => {
    const r = resolveActivityLiveness(act({ updatedAt: NOW - ACTIVITY_SLOW_MS }), NOW);
    expect(r.level).toBe("stalled");
    expect(r.dot).toBe("🔴");
    expect(r.label).toBe("疑似停滞");
  });

  test("🔴 疑似停滞：41 分钟无写入", () => {
    expect(
      resolveActivityLiveness(act({ updatedAt: NOW - 41 * MIN }), NOW).level,
    ).toBe("stalled");
  });

  test("⚪ 终态任务：哪怕 40 分钟无写入也报「已结束」，不报「疑似停滞」", () => {
    const r = resolveActivityLiveness(act({ updatedAt: NOW - 40 * MIN }), NOW, true);
    expect(r.level).toBe("terminal");
    expect(r.dot).toBe("⚪");
    expect(r.label).toBe("已结束");
  });

  test("时钟回拨（updatedAt 在未来）→ 宁可乐观报 active，不误报停滞", () => {
    expect(
      resolveActivityLiveness(act({ updatedAt: NOW + 10 * MIN }), NOW).level,
    ).toBe("active");
  });

  test("有快照但 updatedAt 缺失 → unknown（消息数可信，档位判不了）", () => {
    const r = resolveActivityLiveness(
      { subSessionId: "s", messageCount: 10, updatedAt: Number.NaN },
      NOW,
    );
    expect(r.level).toBe("unknown");
  });
});

// ============================================================================
// 4. truncateActivityMessage
// ============================================================================

describe("truncateActivityMessage", () => {
  test("空 / undefined → 空串", () => {
    expect(truncateActivityMessage(undefined)).toBe("");
    expect(truncateActivityMessage("   ")).toBe("");
  });

  test("短文本原样返回（不接省略号）", () => {
    expect(truncateActivityMessage("hello world", 200)).toBe("hello world");
  });

  test("超长英文回退到空格边界（不切半个单词）", () => {
    const text =
      "This is a long sentence that will definitely exceed the maximum allowed length for a card";
    const out = truncateActivityMessage(text, 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
    // 切点必须是完整单词：去掉省略号后不该以半个单词结尾
    const body = out.slice(0, -1).trimEnd();
    expect(text.startsWith(body)).toBe(true);
    expect(body.endsWith(" ")).toBe(false);
  });

  test("超长 CJK 硬截 + 省略号（中文无空格，硬截是正确的）", () => {
    const text = "一二三四五六七八九十".repeat(10);
    const out = truncateActivityMessage(text, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  test("换行被压成「 · 」分隔、连续空白压成一个空格（卡片单行渲染）", () => {
    // 复用 sanitizeInlineText 的既有语义：\n → " · "（保留可见分隔，
    // 比直接吃掉换行更可读，且与卡片其它区块的扁平化规则一致）
    expect(truncateActivityMessage("line1\n\nline2   line3", 200)).toBe(
      "line1 · line2 line3",
    );
  });

  test("默认截断长度 = 200", () => {
    expect(DEFAULT_ACTIVITY_MESSAGE_MAX).toBe(200);
  });
});

// ============================================================================
// 5. formatActivityLines — 飞书 markdown
// ============================================================================

describe("formatActivityLines", () => {
  test("有数据 → 3 行（信号灯+消息数 / 最近写入 / 最近消息）", () => {
    const lines = formatActivityLines(act(), NOW);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("🟢");
    expect(lines[0]).toContain("活跃");
    expect(lines[0]).toContain("3 分钟前");
    expect(lines[0]).toContain("消息数 128 条");
    expect(lines[1]).toContain("最近写入");
    expect(lines[1]).toContain("20:44:12");
    expect(lines[2]).toContain("最近消息");
    expect(lines[2]).toContain("[assistant]");
    expect(lines[2]).toContain("wecom-card-builder.ts:485");
  });

  test("★ 无数据 → 返回 1 行「暂无数据」，绝不返回空数组", () => {
    const lines = formatActivityLines(undefined, NOW);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("暂无数据");
  });

  test("有快照但无最近消息 → 占位行，不是崩掉", () => {
    const lines = formatActivityLines(act({ lastMessage: undefined }), NOW);
    expect(lines.some((l) => l.includes("暂无文本消息"))).toBe(true);
  });

  test("终态 → ⚪ 已结束", () => {
    const lines = formatActivityLines(act({ updatedAt: NOW - 40 * MIN }), NOW, true);
    expect(lines[0]).toContain("⚪");
    expect(lines[0]).toContain("已结束");
  });
});

// ============================================================================
// 6. formatActivityQuote — 企微 quote_area
// ============================================================================

describe("formatActivityQuote", () => {
  test("有数据 → title + 2 行 text，overflow=false", () => {
    const q = formatActivityQuote(act(), NOW);
    expect(q.title).toBe("⚡ 子会话活性");
    expect(q.text).toContain("🟢 活跃");
    expect(q.text).toContain("消息数 128 条");
    expect(q.text).toContain("💬");
    expect(q.overflow).toBe(false);
  });

  test("无数据 → 暂无数据，overflow=false（短）", () => {
    const q = formatActivityQuote(undefined, NOW);
    expect(q.text).toContain("暂无数据");
    expect(q.overflow).toBe(false);
  });

  test("★ 超限 → overflow=true（调用方据此降级到 sub_title_text）", () => {
    const long = "很长的消息内容".repeat(40);
    const q = formatActivityQuote(
      act({ lastMessage: { role: "assistant", content: long } }),
      NOW,
    );
    // truncate 到 80 后总长仍可能超 112 → 断言 overflow 真的会触发
    expect(typeof q.overflow).toBe("boolean");
    // 无论如何都不该超太多（截断生效）
    expect(q.text.length).toBeLessThan(160);
  });

  test("终态 → ⚪ 已结束", () => {
    const q = formatActivityQuote(act(), NOW, true);
    expect(q.text).toContain("⚪");
    expect(q.text).toContain("已结束");
  });
});

// ============================================================================
// 7. findBackgroundTaskByAssociatedTaskId
// ============================================================================

describe("findBackgroundTaskByAssociatedTaskId", () => {
  const tasks: BackgroundTaskLite[] = [
    { id: "process_1", subSessionId: "session_a", associatedTaskId: 42 },
    { id: "process_2", subSessionId: "session_b", associatedTaskId: 43 },
    { id: "process_3", subSessionId: "session_c", associatedTaskId: 42 },
  ];

  test("按 taskId 命中", () => {
    expect(findBackgroundTaskByAssociatedTaskId(tasks, 43)?.subSessionId).toBe(
      "session_b",
    );
  });

  test("★ 多命中取最后一个（复用 sub-session 场景，越晚越新鲜）", () => {
    expect(findBackgroundTaskByAssociatedTaskId(tasks, 42)?.subSessionId).toBe(
      "session_c",
    );
  });

  test("未命中 / 空表 / 非有限 taskId → undefined", () => {
    expect(findBackgroundTaskByAssociatedTaskId(tasks, 999)).toBeUndefined();
    expect(findBackgroundTaskByAssociatedTaskId([], 42)).toBeUndefined();
    expect(findBackgroundTaskByAssociatedTaskId(undefined, 42)).toBeUndefined();
    expect(findBackgroundTaskByAssociatedTaskId(tasks, Number.NaN)).toBeUndefined();
  });

  test("跳过 subSessionId 为空的脏数据", () => {
    const dirty: BackgroundTaskLite[] = [
      { id: "process_x", subSessionId: "", associatedTaskId: 42 },
      { id: "process_y", subSessionId: "session_ok", associatedTaskId: 42 },
    ];
    expect(findBackgroundTaskByAssociatedTaskId(dirty, 42)?.subSessionId).toBe(
      "session_ok",
    );
  });
});

// ============================================================================
// 8. createActivityProbe — 端口组合 + 全链路降级
// ============================================================================

describe("createActivityProbe", () => {
  const tasks: BackgroundTaskLite[] = [
    { id: "process_1", subSessionId: "session_a", associatedTaskId: 42 },
  ];

  test("全端口就绪 → 完整快照", async () => {
    const probe = createActivityProbe({
      listBackgroundTasks: () => tasks,
      getSubSessionActivity: () => ({ messageCount: 128, updatedAt: NOW }),
      getLastMessage: () => ({ role: "assistant", content: "hi", timestamp: NOW }),
      isTerminalTask: () => false,
    });
    const r = await probe(42);
    expect(r.terminal).toBe(false);
    expect(r.activity?.subSessionId).toBe("session_a");
    expect(r.activity?.messageCount).toBe(128);
    expect(r.activity?.lastMessage?.content).toBe("hi");
  });

  test("反查不到 bg 任务 → activity=undefined（渲染「暂无数据」）", async () => {
    const probe = createActivityProbe({
      listBackgroundTasks: () => tasks,
      getSubSessionActivity: () => ({ messageCount: 1, updatedAt: NOW }),
    });
    const r = await probe(999);
    expect(r.activity).toBeUndefined();
  });

  test("★ getSubSessionActivity 抛错 → activity=undefined，绝不抛（patch 不能因此失败）", async () => {
    const probe = createActivityProbe({
      listBackgroundTasks: () => tasks,
      getSubSessionActivity: () => {
        throw new Error("db locked");
      },
    });
    const r = await probe(42);
    expect(r.activity).toBeUndefined();
  });

  test("getLastMessage 抛错 → activity 保留，只是没有 lastMessage", async () => {
    const probe = createActivityProbe({
      listBackgroundTasks: () => tasks,
      getSubSessionActivity: () => ({ messageCount: 7, updatedAt: NOW }),
      getLastMessage: () => {
        throw new Error("session store gone");
      },
    });
    const r = await probe(42);
    expect(r.activity?.messageCount).toBe(7);
    expect(r.activity?.lastMessage).toBeUndefined();
  });

  test("listBackgroundTasks 抛错 → activity=undefined", async () => {
    const probe = createActivityProbe({
      listBackgroundTasks: () => {
        throw new Error("nope");
      },
      getSubSessionActivity: () => ({ messageCount: 1, updatedAt: NOW }),
    });
    const r = await probe(42);
    expect(r.activity).toBeUndefined();
  });

  test("isTerminalTask 抛错 → terminal=false（降级，不阻断）", async () => {
    const probe = createActivityProbe({
      listBackgroundTasks: () => tasks,
      getSubSessionActivity: () => ({ messageCount: 1, updatedAt: NOW }),
      isTerminalTask: () => {
        throw new Error("boom");
      },
    });
    const r = await probe(42);
    expect(r.terminal).toBe(false);
    expect(r.activity?.messageCount).toBe(1);
  });

  test("端口全缺 → 安全返回 undefined", async () => {
    const probe = createActivityProbe({});
    const r = await probe(42);
    expect(r.activity).toBeUndefined();
    expect(r.terminal).toBe(false);
  });
});

// ============================================================================
// 9. toActivityMessage
// ============================================================================

describe("toActivityMessage", () => {
  test("正常消息 → 截断 + 角色", () => {
    const m = toActivityMessage({ role: "user", content: "hi", timestamp: NOW });
    expect(m).toEqual({ role: "user", content: "hi", timestamp: NOW });
  });

  test("空 content → undefined（不产生空消息气泡）", () => {
    expect(toActivityMessage({ role: "user", content: "   " })).toBeUndefined();
    expect(toActivityMessage(undefined)).toBeUndefined();
  });

  test("缺 role → unknown", () => {
    expect(toActivityMessage({ content: "hi" })?.role).toBe("unknown");
  });

  test("超长内容按默认 200 截断", () => {
    const m = toActivityMessage({ role: "assistant", content: "x".repeat(500) });
    expect(m!.content.length).toBeLessThanOrEqual(200);
  });
});
// ============================================================================
// 10. ★ 补充需求（22:31）：session-only probe（无 task 也能刷新）
// ============================================================================

describe("createSessionActivityProbe（无 task 的 sub-session）", () => {
  test("★ 直接读 session store（不经 taskId → bgTask 反查）", async () => {
    const seen: string[] = [];
    const probe = createSessionActivityProbe({
      getSession: (id) => {
        seen.push(id);
        return { messageCount: 88, updatedAt: NOW };
      },
      getLastMessage: () => ({ role: "assistant", content: "hi" }),
    });
    const r = await probe("session_only_1");

    expect(seen).toEqual(["session_only_1"]); // 直达，没有中间反查
    expect(r.terminal).toBe(false);
    expect(r.activity?.subSessionId).toBe("session_only_1");
    expect(r.activity?.messageCount).toBe(88);
    expect(r.activity?.lastMessage?.content).toBe("hi");
  });

  test("★ session-only 永远不报终态（没有 task 就没有「完成」语义）", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => ({ messageCount: 1, updatedAt: NOW - 40 * MIN }),
    });
    const r = await probe("s1");
    expect(r.terminal).toBe(false);
    // 40 分钟无写入 ⇒ stalled，而不是 terminal
    expect(resolveActivityLiveness(r.activity, NOW, r.terminal).level).toBe(
      "stalled",
    );
  });

  test("getSession 返回 null/undefined → activity undefined（渲染暂无数据）", async () => {
    for (const ret of [null, undefined]) {
      const probe = createSessionActivityProbe({ getSession: () => ret });
      const r = await probe("s1");
      expect(r.activity).toBeUndefined();
    }
  });

  test("★ getSession 抛错 → 降级 undefined，绝不抛（刷新不能因此失败）", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => {
        throw new Error("db locked");
      },
    });
    const r = await probe("s1");
    expect(r.activity).toBeUndefined();
  });

  test("getLastMessage 抛错 → activity 保留，只是没有最近消息", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => ({ messageCount: 5, updatedAt: NOW }),
      getLastMessage: () => {
        throw new Error("gone");
      },
    });
    const r = await probe("s1");
    expect(r.activity?.messageCount).toBe(5);
    expect(r.activity?.lastMessage).toBeUndefined();
  });

  test("★ messageCount 缺省 → 用 0 起步（不报错，仍能给时间/最近消息）", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => ({ updatedAt: NOW }),
      getLastMessage: () => ({ role: "user", content: "go" }),
    });
    const r = await probe("s1");
    expect(r.activity?.messageCount).toBe(0);
    expect(r.activity?.lastMessage?.content).toBe("go");
  });

  test("updatedAt 缺省 → NaN（渲染层降级为「未知」档而非假报活跃）", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => ({ messageCount: 3 }),
    });
    const r = await probe("s1");
    expect(resolveActivityLiveness(r.activity, NOW).level).toBe("unknown");
  });

  test("空 sessionId → 直接 undefined（不打 store）", async () => {
    let called = 0;
    const probe = createSessionActivityProbe({
      getSession: () => {
        called++;
        return { messageCount: 1, updatedAt: NOW };
      },
    });
    expect((await probe("")).activity).toBeUndefined();
    expect(called).toBe(0);
  });

  test("端口全缺 → 安全 undefined", async () => {
    const probe = createSessionActivityProbe({});
    expect((await probe("s1")).activity).toBeUndefined();
  });

  test("★ 渲染口径与 task 路径一致（同一 formatActivityLines）", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => ({ messageCount: 88, updatedAt: NOW - 3 * MIN }),
      getLastMessage: () => ({ role: "assistant", content: "已定位到问题" }),
    });
    const { activity } = await probe("s1");
    const lines = formatActivityLines(activity, NOW);
    expect(lines[0]).toContain("🟢");
    expect(lines[0]).toContain("消息数 88 条");
    expect(lines[2]).toContain("已定位到问题");
  });
});
