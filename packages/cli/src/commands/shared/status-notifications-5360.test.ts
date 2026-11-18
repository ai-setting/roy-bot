/**
 * @fileoverview Task #5360 — `statusNotifications` 解析层单测
 *
 * ## 用户补充需求（2026-11-11 20:54）
 *
 * > 「`~/.roy-bot/event-sources.json` 新增配置项控制「状态通知消息」，
 * >   默认 false 不启动；false = 不发状态通知文本（走卡片），
 * >   true = 恢复之前的状态通知消息推送。覆盖 lark ES（wecom ES 对称考虑）」
 *
 * ## 本文件锁定的不变量（对应 supplement §S.7 断言 1/2）
 *
 * 1. 快照优先：`replyChannel.params.statusNotifications` 存在就是最终答案
 * 2. 快照说 false、ES 配置说 true ⇒ **false**（快照优先，中途改配置不影响已派生任务）
 * 3. 快照缺失 + `metadata.sourceId` 命中 ⇒ 用该源的值
 * 4. 快照缺失 + 该渠道恰好单源 ⇒ 用该源的值（老 delegate / 重启兜底）
 * 5. 快照缺失 + 多源歧义 / 零源 ⇒ false（安全侧）
 * 6. 类型严格 `=== true`：`"true"` / `1` / `null` / 缺失 ⇒ false
 * 7. 永不抛
 */

import { describe, test, expect } from "bun:test";
import type { EnvEvent } from "@ai-setting/roy-bot-core";
import {
  inferChannelFromEvent,
  isStrictlyTrue,
  pickStatusNotificationsFromParams,
  pickStatusNotificationsFromSources,
  resolveStatusNotificationsFromEvent,
  type StatusNotificationSource,
} from "./status-notifications";

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function ev(metadata: Record<string, unknown> = {}): EnvEvent {
  return {
    id: "evt-5360",
    type: "task.background.progress",
    timestamp: Date.now(),
    payload: {},
    metadata,
  } as unknown as EnvEvent;
}

function withSnapshot(v: unknown, extra: Record<string, unknown> = {}) {
  return ev({
    replyChannel: { type: "lark-cli", chatId: "oc_x", params: { statusNotifications: v } },
    ...extra,
  });
}

const LARK_ON: StatusNotificationSource = {
  id: "id_lark_1",
  type: "lark-cli",
  statusNotifications: true,
};
const LARK_OFF: StatusNotificationSource = {
  id: "id_lark_2",
  type: "lark-cli",
  statusNotifications: false,
};

// ============================================================================
// 0. isStrictlyTrue
// ============================================================================

describe("isStrictlyTrue（类型严格，防手改 JSON 漂移）", () => {
  test("只有真布尔 true 才算开启", () => {
    expect(isStrictlyTrue(true)).toBe(true);
  });

  test('★ "true"（字符串）/ 1 / "1" / null / undefined / {} 一律 false', () => {
    for (const v of ["true", 1, "1", null, undefined, {}, [], "yes"]) {
      expect(isStrictlyTrue(v)).toBe(false);
    }
  });
});

// ============================================================================
// 1. 第 1 层：快照
// ============================================================================

describe("pickStatusNotificationsFromParams（第 1 层：delegate 快照）", () => {
  test("显式 true → true", () => {
    expect(pickStatusNotificationsFromParams({ statusNotifications: true })).toBe(true);
  });

  test("★ 显式 false → false（不是 undefined —— 否则会被下层覆盖）", () => {
    expect(pickStatusNotificationsFromParams({ statusNotifications: false })).toBe(false);
  });

  test("缺失 / params 非对象 → undefined（继续往下找）", () => {
    expect(pickStatusNotificationsFromParams({})).toBeUndefined();
    expect(pickStatusNotificationsFromParams(undefined)).toBeUndefined();
    expect(pickStatusNotificationsFromParams(null)).toBeUndefined();
    expect(pickStatusNotificationsFromParams("x")).toBeUndefined();
  });

  test('★ 非布尔值（"true" / 1 / null）→ undefined（快照里没有可用信息）', () => {
    expect(pickStatusNotificationsFromParams({ statusNotifications: "true" })).toBeUndefined();
    expect(pickStatusNotificationsFromParams({ statusNotifications: 1 })).toBeUndefined();
    expect(pickStatusNotificationsFromParams({ statusNotifications: null })).toBeUndefined();
  });
});

// ============================================================================
// 2. 第 2/3 层：ES 配置
// ============================================================================

describe("pickStatusNotificationsFromSources（第 2/3 层：ES 配置）", () => {
  test("sourceId 精确命中 → 该源的值", () => {
    const e = ev({ sourceId: "id_lark_1" });
    expect(pickStatusNotificationsFromSources(e, [LARK_ON, LARK_OFF], "lark-cli")).toBe(true);
  });

  test("★ sourceId 命中 false 的源 → false（显式配置优先于单源推断）", () => {
    const e = ev({ sourceId: "id_lark_2" });
    // 该渠道有 2 个源，单源推断会失效；但 sourceId 精确命中 → false
    expect(pickStatusNotificationsFromSources(e, [LARK_ON, LARK_OFF], "lark-cli")).toBe(false);
  });

  test("★ 单源推断：该渠道恰好 1 个源 → 用它的值", () => {
    const e = ev({}); // 无 sourceId
    expect(pickStatusNotificationsFromSources(e, [LARK_ON], "lark-cli")).toBe(true);
  });

  test("★ 多源歧义（该渠道 2 个源）→ undefined（保守走卡片）", () => {
    const e = ev({});
    expect(
      pickStatusNotificationsFromSources(e, [LARK_ON, LARK_OFF], "lark-cli"),
    ).toBeUndefined();
  });

  test("零源 / undefined / 空数组 → undefined", () => {
    expect(pickStatusNotificationsFromSources(ev({}), [], "lark-cli")).toBeUndefined();
    expect(pickStatusNotificationsFromSources(ev({}), undefined, "lark-cli")).toBeUndefined();
  });

  test("不传 channel → 跳过单源推断（保守）", () => {
    expect(pickStatusNotificationsFromSources(ev({}), [LARK_ON])).toBeUndefined();
  });

  test("sourceId 命中但该源 statusNotifications 是字符串 → false（严格）", () => {
    const e = ev({ sourceId: "id_weird" });
    const weird: StatusNotificationSource = {
      id: "id_weird",
      type: "lark-cli",
      statusNotifications: "true", // 手改 JSON 的典型错误
    };
    expect(pickStatusNotificationsFromSources(e, [weird], "lark-cli")).toBe(false);
  });
});

// ============================================================================
// 3. 组合：resolveStatusNotificationsFromEvent
// ============================================================================

describe("resolveStatusNotificationsFromEvent（最终语义，永不抛）", () => {
  test("★ 快照 true → true（最高优先级）", () => {
    expect(resolveStatusNotificationsFromEvent(withSnapshot(true), [], "lark-cli")).toBe(true);
  });

  test("★ 快照 false + ES 配置 true → false（快照优先，改配置不影响已派生任务）", () => {
    const e = withSnapshot(false, { sourceId: "id_lark_1" });
    expect(resolveStatusNotificationsFromEvent(e, [LARK_ON], "lark-cli")).toBe(false);
  });

  test("★ 快照缺失 + sourceId 命中 true → true", () => {
    const e = ev({ sourceId: "id_lark_1" });
    expect(resolveStatusNotificationsFromEvent(e, [LARK_ON, LARK_OFF], "lark-cli")).toBe(true);
  });

  test("★ 快照缺失 + 单源 true → true（老 delegate / 重启兜底）", () => {
    expect(resolveStatusNotificationsFromEvent(ev({}), [LARK_ON], "lark-cli")).toBe(true);
  });

  test("★ 快照缺失 + 多源歧义 → false（安全侧）", () => {
    const e = ev({});
    expect(
      resolveStatusNotificationsFromEvent(e, [LARK_ON, LARK_OFF], "lark-cli"),
    ).toBe(false);
  });

  test("★ 全空（默认安装，event-sources.json 无该字段）→ false", () => {
    expect(resolveStatusNotificationsFromEvent(ev({}), [], "lark-cli")).toBe(false);
    expect(resolveStatusNotificationsFromEvent(ev({}), undefined)).toBe(false);
  });

  test('★ 源上字段为 "true"/1/null → false', () => {
    for (const v of ["true", 1, null]) {
      const src: StatusNotificationSource = {
        id: "id_x",
        type: "lark-cli",
        statusNotifications: v,
      };
      expect(
        resolveStatusNotificationsFromEvent(ev({ sourceId: "id_x" }), [src], "lark-cli"),
      ).toBe(false);
    }
  });

  test("★ 永不抛：metadata 是字符串 → 不抛，无 ES 配置时 false", () => {
    const weird = {
      id: "e",
      type: "t",
      timestamp: 0,
      payload: {},
      metadata: "not-an-object",
    } as unknown as EnvEvent;
    // metadata 不可读 ⇒ 第 1/2 层都无信息；零源 ⇒ 第 4 层兜底 false
    expect(resolveStatusNotificationsFromEvent(weird, [], "lark-cli")).toBe(false);
  });

  test("★ 单源推断不依赖 metadata（形状异常时仍能生效）", () => {
    // 这不是"异常路径"：第 3 层（单源推断）本来就不读 metadata，
    // 该渠道恰好 1 个源时用它的值是正确的，不该因为 metadata 坏而丢配置。
    const weird = {
      id: "e",
      type: "t",
      timestamp: 0,
      payload: {},
      metadata: "not-an-object",
    } as unknown as EnvEvent;
    expect(resolveStatusNotificationsFromEvent(weird, [LARK_ON], "lark-cli")).toBe(true);
  });

  test("★ 永不抛：读 metadata 时抛异常 ⇒ false（catch 兜底）", () => {
    const boom = {
      id: "e",
      type: "t",
      timestamp: 0,
      payload: {},
      get metadata(): never {
        throw new Error("boom");
      },
    } as unknown as EnvEvent;
    expect(resolveStatusNotificationsFromEvent(boom, [LARK_ON], "lark-cli")).toBe(false);
  });

  test("★ 永不抛：replyChannel 是字符串 → false（落到后续层）", () => {
    const e = ev({ replyChannel: "oops" });
    expect(resolveStatusNotificationsFromEvent(e, [], "lark-cli")).toBe(false);
  });
});

// ============================================================================
// 4. 渠道推断
// ============================================================================

describe("inferChannelFromEvent", () => {
  test("replyChannel.type = lark-cli / wecom-cli", () => {
    expect(inferChannelFromEvent(ev({ replyChannel: { type: "lark-cli" } }))).toBe("lark-cli");
    expect(inferChannelFromEvent(ev({ replyChannel: { type: "wecom-cli" } }))).toBe("wecom-cli");
  });

  test("★ 退路：chatId 带 wecom 前缀 → wecom-cli", () => {
    expect(
      inferChannelFromEvent(ev({ replyChannel: { chatId: "wecom:unknown" } })),
    ).toBe("wecom-cli");
  });

  test("无法判断 → undefined（跳过单源推断）", () => {
    expect(inferChannelFromEvent(ev({}))).toBeUndefined();
    expect(inferChannelFromEvent(ev({ replyChannel: { type: "bounty-im" } }))).toBeUndefined();
  });
});

// ============================================================================
// 5. 两渠道对称（supplement §S.5）
// ============================================================================

describe("两渠道对称性", () => {
  test("lark 单源 true / wecom 单源 false → 各自解析出各自的值", () => {
    const sources: StatusNotificationSource[] = [
      { id: "l", type: "lark-cli", statusNotifications: true },
      { id: "w1", type: "wecom-cli", statusNotifications: false },
    ];
    expect(
      resolveStatusNotificationsFromEvent(ev({}), sources, "lark-cli"),
    ).toBe(true);
    // wecom 有 1 个源
    expect(
      resolveStatusNotificationsFromEvent(ev({}), sources, "wecom-cli"),
    ).toBe(false);
  });

  test("wecom 两个源 → 歧义 → false", () => {
    const sources: StatusNotificationSource[] = [
      { id: "w1", type: "wecom-cli", statusNotifications: true },
      { id: "w2", type: "wecom-cli", statusNotifications: true },
    ];
    expect(resolveStatusNotificationsFromEvent(ev({}), sources, "wecom-cli")).toBe(false);
  });

  test("wecom 快照优先（与 lark 同语义）", () => {
    const e = ev({
      replyChannel: { type: "wecom-cli", chatId: "u1", params: { statusNotifications: false } },
      sourceId: "w1",
    });
    const sources: StatusNotificationSource[] = [
      { id: "w1", type: "wecom-cli", statusNotifications: true },
    ];
    expect(resolveStatusNotificationsFromEvent(e, sources, "wecom-cli")).toBe(false);
  });
});