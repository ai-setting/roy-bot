/**
 * @fileoverview 终态规则回执（completed / timeout）—— 纯函数测试
 *
 * 锁定的不变量：
 *   1. 文案只报事实（Task / 标题 / 耗时 / timeout），**绝不放 result 正文**
 *   2. 字段缺失一律降级，绝不渲染 `undefined` / `NaN` / `Task #undefined`
 *   3. timeout 时长能从 error 文案里解析（payload 无 timeoutMs 时）
 *   4. 幂等键按 (event.id, chatId) 稳定派生，跨 chat 不互相去重
 *   5. 与 telemetry 白名单互斥、语义不混淆
 */

import { describe, expect, test } from "bun:test";
import {
  buildTerminalNoticeText,
  deriveRuleNoticeIdempotencyKey,
  deriveTelemetryIdempotencyKey,
  isRuleNoticeEvent,
  isTelemetryEvent,
  parseTimeoutMsFromError,
} from "./telemetry-notice";

const HOUR = 3600 * 1000;

describe("buildTerminalNoticeText / timeout", () => {
  test("Task #N + 标题 + 跑了多久 + timeout（从 error 解析）", () => {
    const text = buildTerminalNoticeText("task.background.timeout", {
      backgroundTaskId: "process_1793077167757_5rngpu1th",
      description: "修 ontology-gen 4 个根因问题",
      associatedTaskId: 4561,
      executionTimeMs: 2 * HOUR,
      error: "Task execution timeout after 7200000ms",
    });

    expect(text).toContain("⏱️ Task #4561「修 ontology-gen 4 个根因问题」已超时");
    expect(text).toContain("跑了 2h");
    expect(text).toContain("timeout 2h");
    // 必须提示会有后续（否则用户以为这条就是全部）
    expect(text).toContain("助手随后补充");
  });

  test("payload 带 timeoutMs 时优先用它", () => {
    const text = buildTerminalNoticeText("task.background.timeout", {
      description: "x",
      associatedTaskId: 1,
      executionTimeMs: HOUR,
      timeoutMs: 90 * 60 * 1000,
      error: "Task execution timeout after 7200000ms",
    });
    expect(text).toContain("timeout 1h30m");
  });

  test("无 associatedTaskId → 回落到 backgroundTaskId（绝不渲染 Task #undefined）", () => {
    const text = buildTerminalNoticeText("task.background.timeout", {
      backgroundTaskId: "process_1793077167757_5rngpu1th",
      description: "x",
    });
    expect(text).toContain("process_1793077167757_5rngpu1th");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("Task #");
  });

  test("字段全缺 → 中性文案，不崩不渲染 NaN", () => {
    const text = buildTerminalNoticeText("task.background.timeout", undefined);
    expect(text).toContain("后台任务");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });
});

describe("buildTerminalNoticeText / completed", () => {
  test("Task #N + 耗时，且**不包含** result 正文", () => {
    const bigResult = "超长报告".repeat(500); // 3000 字
    const text = buildTerminalNoticeText("task.background.completed", {
      description: "画ontology图并发飞书",
      associatedTaskId: 4449,
      executionTimeMs: 3 * HOUR + 12 * 60 * 1000,
      result: bigResult,
    });

    expect(text).toContain("✅ Task #4449「画ontology图并发飞书」已完成");
    expect(text).toContain("耗时 3h12m");
    expect(text).not.toContain("超长报告");
    // 回执必须短：正文交给 agent 的总结
    expect(text.length).toBeLessThan(200);
  });

  test("缺 executionTimeMs → 不渲染「耗时」", () => {
    const text = buildTerminalNoticeText("task.background.completed", {
      description: "x",
      associatedTaskId: 1,
    });
    expect(text).toContain("已完成");
    expect(text).not.toContain("耗时");
  });

  test("未知类型（未来扩白名单）→ 中性文案，不冒充「完成」", () => {
    const text = buildTerminalNoticeText("task.background.failed", {
      description: "x",
      associatedTaskId: 7,
    });
    expect(text).toContain("failed");
    expect(text).not.toContain("已完成");
  });
});

describe("parseTimeoutMsFromError", () => {
  test("标准文案", () => {
    expect(parseTimeoutMsFromError("Task execution timeout after 5400000ms")).toBe(5400000);
  });
  test("大小写 / 多余空格", () => {
    expect(parseTimeoutMsFromError("task execution TIMEOUT after   7200000 ms")).toBe(7200000);
  });
  test("解析不出来 → undefined", () => {
    expect(parseTimeoutMsFromError(undefined)).toBeUndefined();
    expect(parseTimeoutMsFromError("unknown certificate verification error")).toBeUndefined();
    expect(parseTimeoutMsFromError("timeout after 0ms")).toBeUndefined();
  });
});

describe("白名单语义", () => {
  test("telemetry = started/progress；rule notice = completed/timeout，互斥", () => {
    expect(isTelemetryEvent("task.background.started")).toBe(true);
    expect(isTelemetryEvent("task.background.progress")).toBe(true);
    expect(isRuleNoticeEvent("task.background.started")).toBe(false);

    expect(isRuleNoticeEvent("task.background.completed")).toBe(true);
    expect(isRuleNoticeEvent("task.background.timeout")).toBe(true);
    expect(isTelemetryEvent("task.background.completed")).toBe(false);

    // failed / stopped 刻意不进回执白名单（见 telemetry-notice.ts 注释）
    expect(isRuleNoticeEvent("task.background.failed")).toBe(false);
    expect(isRuleNoticeEvent("task.background.stopped")).toBe(false);
    expect(isRuleNoticeEvent(undefined)).toBe(false);
  });
});

describe("deriveRuleNoticeIdempotencyKey", () => {
  test("同一 (event, chat) → 稳定同 key", () => {
    const a = deriveRuleNoticeIdempotencyKey("evt-1", "oc_x");
    const b = deriveRuleNoticeIdempotencyKey("evt-1", "oc_x");
    expect(a).toBe(b);
  });

  test("跨 chat → 不同 key（同一个任务可能通知多个群）", () => {
    expect(deriveRuleNoticeIdempotencyKey("evt-1", "oc_a")).not.toBe(
      deriveRuleNoticeIdempotencyKey("evt-1", "oc_b"),
    );
  });

  test("与 telemetry 的 key 不撞（namespace 隔离）", () => {
    expect(deriveRuleNoticeIdempotencyKey("evt-1", "oc_x")).not.toBe(
      deriveTelemetryIdempotencyKey("evt-1", "oc_x"),
    );
  });

  test("长度 ≤ 飞书 50 字符上限", () => {
    const key = deriveRuleNoticeIdempotencyKey("evt-" + "x".repeat(200), "oc_" + "y".repeat(120));
    expect(key.length).toBeLessThanOrEqual(50);
  });

  test("缺 event.id → 仍生成唯一 key（不共用同一个去重键）", () => {
    const a = deriveRuleNoticeIdempotencyKey(undefined, "oc_x");
    const b = deriveRuleNoticeIdempotencyKey(undefined, "oc_x");
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// Task #5036：提示消息嵌入「跳到任务卡片」链接
// ============================================================================

describe("buildTerminalNoticeText / 卡片链接（Task #5036）", () => {
  const URL = "https://applink.feishu.cn/client/chat/open?openChatId=oc_x&position=127";

  test("★ 传入 cardUrl → 正文含可点击 Markdown 链接，且插在标题行后", () => {
    const text = buildTerminalNoticeText(
      "task.background.completed",
      { description: "实施 P1 布局+状态栏", associatedTaskId: 4954, executionTimeMs: HOUR },
      { cardUrl: URL },
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("✅ Task #4954「实施 P1 布局+状态栏」已完成（耗时 1h）");
    expect(lines[1]).toBe(`[📌 查看任务卡片](${URL})`);
    // 帮助句仍在最后（不能让链接把它顶掉）
    expect(text).toContain("助手随后补充交付摘要");
    expect(text.indexOf("查看任务卡片")).toBeLessThan(text.indexOf("助手随后补充"));
  });

  test("★ timeout 回执同样带链接", () => {
    const text = buildTerminalNoticeText(
      "task.background.timeout",
      { description: "修 bug", associatedTaskId: 7, executionTimeMs: HOUR, timeoutMs: 2 * HOUR },
      { cardUrl: URL },
    );
    expect(text).toContain(`[📌 查看任务卡片](${URL})`);
    expect(text).toContain("已超时");
  });

  test("★ 无 cardUrl → 零痕迹降级（与改动前完全一致，无空行无占位）", () => {
    const withOpts = buildTerminalNoticeText(
      "task.background.completed",
      { description: "x", associatedTaskId: 1, executionTimeMs: HOUR },
      {},
    );
    const withoutOpts = buildTerminalNoticeText("task.background.completed", {
      description: "x",
      associatedTaskId: 1,
      executionTimeMs: HOUR,
    });
    expect(withOpts).toBe(withoutOpts);
    expect(withOpts).not.toContain("查看任务卡片");
    expect(withOpts).not.toContain("applink");
  });

  test("★ cardUrl 为空串 → 视同无链接（不渲染空链接）", () => {
    const text = buildTerminalNoticeText(
      "task.background.completed",
      { description: "x", associatedTaskId: 1 },
      { cardUrl: "" },
    );
    expect(text).not.toContain("查看任务卡片");
    expect(text).not.toContain("]()");
  });

  test("仍是同一回调用的 3 参签名兼容（不传第 3 参不报错）", () => {
    expect(() =>
      buildTerminalNoticeText("task.background.completed", { description: "x" }),
    ).not.toThrow();
  });
});

describe("buildTerminalNoticeText / 卡片链接 —— review 修复回归（Task #5036）", () => {
  const URL = "https://applink.feishu.cn/client/chat/open?openChatId=oc_x&position=127";

  test("★ m1: description 含换行 → 链接不得插进「」中间（标题必须单行）", () => {
    const text = buildTerminalNoticeText(
      "task.background.completed",
      {
        description: "line1\nline2",
        associatedTaskId: 1,
        executionTimeMs: HOUR,
      },
      { cardUrl: URL },
    );
    const firstLine = text.split("\n")[0];
    // 标题行必须完整（换行被压平），链接不能出现在「」内
    expect(firstLine).toBe("✅ Task #1「line1 line2」已完成（耗时 1h）");
    expect(firstLine).not.toContain("applink");
    expect(text.split("\n")[1]).toBe(`[📌 查看任务卡片](${URL})`);
  });

  test("★ m1: 多行 description 全部压平成单行（含制表符）", () => {
    const text = buildTerminalNoticeText("task.background.completed", {
      description: "  a\n\n\tb  ",
      associatedTaskId: 2,
    });
    expect(text.split("\n")[0]).toBe("✅ Task #2「a b」已完成");
  });
});
