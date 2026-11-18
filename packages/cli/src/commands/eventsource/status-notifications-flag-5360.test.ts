/**
 * @fileoverview Task #5360 — `eventsource add/update` 的 `--status-notifications` flag
 *
 * ## 用户补充需求（2026-11-11 20:54）
 *
 * > 「`~/.roy-bot/event-sources.json` 新增配置项控制「状态通知消息」，
 * >   默认 false 不启动；false = 不发状态通知文本（走卡片），
 * >   true = 恢复之前的状态通知消息推送」
 *
 * ## 本文件锁定的不变量
 *
 * 1. `add` / `update` 都声明 `--status-notifications`（yargs boolean）
 * 2. `add`：**不传就不写该键**（默认 false，保持配置文件干净）；
 *    传了则显式写入布尔（含 `false`，保留"显式关"的信息）
 * 3. `update`：走 `partial` 语义 —— 不传不改该键
 * 4. 两处都做 `=== true` 严判（防 yargs 被传字符串）
 *
 * ## 为什么用源码断言而不是跑 yargs
 *
 * 与同目录 `update-v0.14.test.ts` 同一套做法：命令注册是 side-effect 型
 * （`process.exit` / 真实 fs 写），端到端跑会污染 `~/.roy-bot`。
 * 这里断言的是**接线存在且形态正确**，行为语义由
 * `status-notifications-5360.test.ts`（纯函数）保证。
 */

import { describe, test, expect } from "bun:test";
import { join } from "node:path";

async function readSrc(name: "add.ts" | "update.ts"): Promise<string> {
  return Bun.file(join(import.meta.dir, name)).text();
}

describe("eventsource add — --status-notifications", () => {
  test("★ 声明 boolean 选项", async () => {
    const src = await readSrc("add.ts");
    expect(src).toContain('.option("status-notifications"');
    // yargs boolean：不能是 string/number 类型
    const idx = src.indexOf('.option("status-notifications"');
    const snippet = src.slice(idx, idx + 400);
    expect(snippet).toContain('type: "boolean"');
  });

  test("★ 不传 ⇒ 不写该键（默认 false，配置干净）", async () => {
    const src = await readSrc("add.ts");
    // 必须是 typeof === "boolean" 才写入 —— undefined 时整段被跳过
    expect(src).toMatch(/typeof a\.statusNotifications === "boolean"/);
  });

  test("★ 传了 ⇒ 显式写入布尔原值（false 也写，不做省略）", async () => {
    const src = await readSrc("add.ts");
    expect(src).toMatch(/statusNotifications: a\.statusNotifications/);
  });
});

describe("eventsource update — --status-notifications", () => {
  test("★ 声明 boolean 选项", async () => {
    const src = await readSrc("update.ts");
    expect(src).toContain('.option("status-notifications"');
    const idx = src.indexOf('.option("status-notifications"');
    const snippet = src.slice(idx, idx + 400);
    expect(snippet).toContain('type: "boolean"');
  });

  test("★ partial 语义：不传不改（undefined 判断）", async () => {
    const src = await readSrc("update.ts");
    expect(src).toMatch(/if \(a\.statusNotifications !== undefined\)/);
  });

  test("★ 严格 === true（yargs 可能给字符串）", async () => {
    const src = await readSrc("update.ts");
    expect(src).toMatch(/partial\.statusNotifications = a\.statusNotifications === true/);
  });
});

describe("旗标语义一致性（add vs update）", () => {
  test("两个命令用同一个旗标名（用户不用记两套）", async () => {
    const [add, update] = await Promise.all([readSrc("add.ts"), readSrc("update.ts")]);
    const flag = '.option("status-notifications"';
    expect(add).toContain(flag);
    expect(update).toContain(flag);
  });

  test("description 都说明了默认 false / 卡片语义", async () => {
    const [add, update] = await Promise.all([readSrc("add.ts"), readSrc("update.ts")]);
    expect(add).toContain("默认 false");
    expect(add).toContain("卡片");
    expect(update).toContain("卡片");
  });
});