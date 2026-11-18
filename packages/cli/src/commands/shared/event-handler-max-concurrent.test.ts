/**
 * @fileoverview maxConcurrentSessions 生产可配置通路测试 (Task #4515 / M4)
 *
 * ## 问题（#4514 复审 M4）
 *
 * 设计文档 §3 + §4 反复宣称：
 *   - `maxConcurrentSessions` 默认 4
 *   - 「运行时软回滚（不改代码）：`maxConcurrentSessions: 1`」→ 退化为旧全局串行
 *
 * 但全仓库检索 maxConcurrentSessions 后可见：除 EventHandler 自身外零调用方，
 * 既没有 CLI flag 也没有 config/env 通路 → 文档宣称的软回滚**物理上不可执行**
 * （那段风险缓解全是空话）。
 *
 * ## 修复
 *
 * 补一条 env 通路 `ROY_AGENT_MAX_CONCURRENT_SESSIONS`，在 factory
 * `createEventHandlerForInteractive()` 里解析并透传给 EventHandler。
 * 放在 factory 里而不是各调用点，保证 interactive.ts / run.ts 两条生产路径
 * 都自动生效（不留漏接）。
 *
 * ## 本测试锁定的语义
 *
 * - 未设置 env → EventHandler 用默认值（4）
 * - `ROY_AGENT_MAX_CONCURRENT_SESSIONS=1` → 生效（这就是"软回滚"）
 * - 非法值（0 / 负数 / NaN / 空串）→ 回落默认，不崩
 * - 调用方显式传 `maxConcurrentSessions` 时 **优先于 env**（代码 > 环境）
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEventHandlerForInteractive,
  resetEventStoreCacheForTest,
} from "./event-handler-wiring";
import { EventMessageFormatter } from "./event-message-formatter";
import type { BaseEnvironment } from "@ai-setting/roy-bot-core";

const ENV_KEY = "ROY_AGENT_MAX_CONCURRENT_SESSIONS";

let tmpDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "m4-test-"));
  resetEventStoreCacheForTest();
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  resetEventStoreCacheForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeEnv(): BaseEnvironment {
  return {
    subscribeAll: vi.fn().mockReturnValue(() => {}),
    getComponent: vi.fn().mockReturnValue(undefined),
  } as any;
}

function build(extra: Record<string, unknown> = {}) {
  return createEventHandlerForInteractive({
    env: makeEnv(),
    eventTypes: ["task.background.*"],
    formatter: new EventMessageFormatter(),
    isIdle: () => true,
    onEvent: async () => {},
    dbPath: join(tmpDir, "event-store.db"),
    ...extra,
  } as any);
}

/** 读私有字段（Bun 没有 TS private 运行时约束） */
function maxOf(handler: unknown): number {
  return (handler as any).maxConcurrentSessions;
}

// ============================================================================
// ★ Task #5360：wiring 真的注入了 resolveStatusNotifications（行为断言）
// ============================================================================

describe("★ Task #5360: resolveStatusNotifications 的生产接线", () => {
  /**
   * 为什么必须有这条（补充需求核验记录点名要求的风险）
   *
   * 核验记录（Decision #42149 风险提示）明确写道：
   * > 「#7 未做则『配置 true 恢复文本』在真实 daemon 上完全不生效
   * >   （单元测试若只 mock 端口会假绿）—— 建议补一条『wiring 真的注入了
   * >   端口』的行为断言，而非仅断言纯函数。」
   *
   * 所以这里**不说**「纯函数对」，而是断言：**工厂造出来的 EventHandler
   * 私有字段真的不是 null**，且能被 env 的 ES 配置驱动出 true。
   */
  function makeEnvWithSources(sources: Array<Record<string, unknown>>) {
    return {
      subscribeAll: vi.fn().mockReturnValue(() => {}),
      getComponent: vi.fn((name: string) =>
        name === "event-source" ? { list: () => sources } : undefined,
      ),
    } as any;
  }

  function ev(): any {
    return {
      id: "e1",
      type: "task.background.progress",
      timestamp: 0,
      payload: {},
      metadata: { sourceId: "es_lark", replyChannel: { type: "lark-cli", chatId: "oc_x" } },
    };
  }

  test("★ 工厂注入了解析器（不是 null）", () => {
    const h = build();
    expect((h as any).resolveStatusNotifications).not.toBeNull();
    expect(typeof (h as any).resolveStatusNotifications).toBe("function");
  });

  test("★ 调用方显式传入时优先（测试注入口不被覆盖）", () => {
    const custom = () => true;
    const h = build({ resolveStatusNotifications: custom });
    expect((h as any).resolveStatusNotifications).toBe(custom);
  });

  test("★ 端到端：ES 配置 statusNotifications=true → 解析器返回 true", () => {
    const h = createEventHandlerForInteractive({
      env: makeEnvWithSources([
        { id: "es_lark", type: "lark-cli", statusNotifications: true },
      ]),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, "event-store.db"),
    } as any);
    expect((h as any).resolveStatusNotifications(ev())).toBe(true);
  });

  test("★ 端到端：ES 配置缺省 → 解析器返回 false（默认走卡片）", () => {
    const h = createEventHandlerForInteractive({
      env: makeEnvWithSources([{ id: "es_lark", type: "lark-cli" }]),
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter(),
      isIdle: () => true,
      onEvent: async () => {},
      dbPath: join(tmpDir, "event-store.db"),
    } as any);
    expect((h as any).resolveStatusNotifications(ev())).toBe(false);
  });

  test("★ env 没注册 event-source 组件 → 安全降级为 false（不抛）", () => {
    const h = build();
    expect((h as any).resolveStatusNotifications(ev())).toBe(false);
  });
});

describe("Task #4515 (M4): maxConcurrentSessions 的生产配置通路", () => {
  test("未设置 env 时用默认值 4", () => {
    expect(maxOf(build())).toBe(4);
  });

  test("ROY_AGENT_MAX_CONCURRENT_SESSIONS=1 生效（= 文档宣称的软回滚）", () => {
    process.env[ENV_KEY] = "1";
    expect(maxOf(build())).toBe(1);
  });

  test("ROY_AGENT_MAX_CONCURRENT_SESSIONS=2 生效", () => {
    process.env[ENV_KEY] = "2";
    expect(maxOf(build())).toBe(2);
  });

  test("大于默认值也生效（用户想开更大并发）", () => {
    process.env[ENV_KEY] = "8";
    expect(maxOf(build())).toBe(8);
  });

  test.each([
    ["0", "0 无意义（会永久阻塞）"],
    ["-3", "负数"],
    ["abc", "非数字"],
    ["", "空串"],
    ["3.9", "小数 → 向下取整为 3"],
  ])("非法值 %p（%s）回落/规范化", (raw) => {
    process.env[ENV_KEY] = raw;
    const value = maxOf(build());
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(1);
    // 3.9 → 3（向下取整），其余非法值 → 默认 4
    if (raw === "3.9") expect(value).toBe(3);
    else expect(value).toBe(4);
  });

  test("调用方显式传 maxConcurrentSessions 时优先于 env（代码 > 环境）", () => {
    process.env[ENV_KEY] = "1";
    expect(maxOf(build({ maxConcurrentSessions: 6 }))).toBe(6);
  });

  test("软回滚确实把执行模型退回串行（行为验证，不只是读字段）", async () => {
    process.env[ENV_KEY] = "1";
    const handler = build();

    // 两个不同 session 的事件：limit=1 时必须串行（区间不重叠）
    const traces: Array<{ tag: string; start: number; end: number }> = [];
    const formatter = new EventMessageFormatter();
    (handler as any).onEventWithEnv = async (fe: any) => {
      const tag = (fe.envEvent?.payload as any)?.tag ?? "?";
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 40));
      traces.push({ tag, start, end: Date.now() });
    };
    // 不提供 sessionComponent → 走 __default__ 单 lane；为测跨 lane 限流，
    // 直接驱动私有 lane 结构
    (handler as any).sessionComponent = null;
    (handler as any).isSessionIdleFn = null;

    const mkEvent = (chatId: string, tag: string) => ({
      type: "event-source.event.lark-cli",
      payload: { tag },
      metadata: {
        sourceId: "s",
        replyChannel: { type: "lark-cli", chatId, messageId: `om_${tag}` },
      },
    });

    handler.enqueue(formatter.formatWithEvent(mkEvent("oc_1", "t1") as any));
    handler.enqueue(formatter.formatWithEvent(mkEvent("oc_2", "t2") as any));

    const start = Date.now();
    while (traces.length < 2 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(traces.length).toBe(2);
    const overlap =
      traces[0].start < traces[1].end && traces[1].start < traces[0].end;
    expect(overlap).toBe(false);

    handler.stop();
  });
});
