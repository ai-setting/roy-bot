/**
 * Task #5459 — self-bot-identity：自身 bot 身份解析（门禁 selfBotIds 的来源）
 *
 * 关键断言：`app_id` 来自本地配置（同步、零网络），`open_id` 来自 API（可关），
 * 任一失败都只降级不抛 —— 事件处理链路不能因身份解析失败而中断。
 */

import { describe, test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetSelfBotIdentityCacheForTest,
  getCachedSelfBotIds,
  readSelfAppIdFromLarkConfig,
  resolveSelfBotIdentities,
  warmSelfBotIdentities,
} from "./self-bot-identity";

const SELF_APP_ID = "cli_aXXXXXXXXXXXXXX";
const SELF_BOT_OPEN_ID = "ou_745dd5b0549250479aefe045c50a8fec";

/** 写一个临时 lark-cli 配置（apps 里含 tongzhuli / gonglin） */
function makeConfigFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "selfbot-"));
  const p = join(dir, "config.json");
  writeFileSync(
    p,
    JSON.stringify({
      currentApp: "tongzhuli",
      apps: [
        { name: "tongzhuli", appId: SELF_APP_ID },
        { name: "gonglin", appId: "cli_aXXXXXXXXXXXXXX" },
      ],
    }),
  );
  return p;
}

describe("Task #5459 — readSelfAppIdFromLarkConfig（本地配置，同步）", () => {
  test("按 profile 名取 appId", () => {
    const cfg = makeConfigFile();
    expect(readSelfAppIdFromLarkConfig("tongzhuli", cfg)).toBe(SELF_APP_ID);
    expect(readSelfAppIdFromLarkConfig("gonglin", cfg)).toBe("cli_aXXXXXXXXXXXXXX");
  });

  test("不传 profile → 用 currentApp", () => {
    expect(readSelfAppIdFromLarkConfig(undefined, makeConfigFile())).toBe(SELF_APP_ID);
  });

  test("profile 不存在 → undefined（不抛）", () => {
    expect(readSelfAppIdFromLarkConfig("nope", makeConfigFile())).toBeUndefined();
  });

  test("文件不存在 → undefined（不抛）", () => {
    expect(readSelfAppIdFromLarkConfig("tongzhuli", "/tmp/definitely-not-here-5459.json")).toBeUndefined();
  });

  test("JSON 损坏 → undefined（不抛）", () => {
    const dir = mkdtempSync(join(tmpdir(), "selfbot-bad-"));
    const p = join(dir, "config.json");
    writeFileSync(p, "{not json");
    expect(readSelfAppIdFromLarkConfig("tongzhuli", p)).toBeUndefined();
  });
});

describe("Task #5459 — resolveSelfBotIdentities（合并 appId + open_id）", () => {
  test("两路都成功 → ids 含 app_id 与 open_id", async () => {
    const cfg = makeConfigFile();
    const r = await resolveSelfBotIdentities({
      profile: "tongzhuli",
      configPath: cfg,
      execLarkCli: async () =>
        JSON.stringify({ ok: true, data: { open_id: SELF_BOT_OPEN_ID } }),
    });
    expect(r.appId).toBe(SELF_APP_ID);
    expect(r.botOpenId).toBe(SELF_BOT_OPEN_ID);
    expect(r.ids).toEqual([SELF_APP_ID, SELF_BOT_OPEN_ID]);
  });

  test("execLarkCli 失败 → 降级为只有 app_id（不抛）", async () => {
    const r = await resolveSelfBotIdentities({
      profile: "tongzhuli",
      configPath: makeConfigFile(),
      execLarkCli: async () => {
        throw new Error("boom");
      },
    });
    expect(r.appId).toBe(SELF_APP_ID);
    expect(r.botOpenId).toBeUndefined();
    expect(r.ids).toEqual([SELF_APP_ID]);
  });

  test("execLarkCli 返回非法 JSON → 降级为只有 app_id", async () => {
    const r = await resolveSelfBotIdentities({
      profile: "tongzhuli",
      configPath: makeConfigFile(),
      execLarkCli: async () => "not-json",
    });
    expect(r.ids).toEqual([SELF_APP_ID]);
  });

  test("queryBotOpenId=false → 完全不调 lark-cli（零网络）", async () => {
    let called = false;
    const r = await resolveSelfBotIdentities({
      profile: "tongzhuli",
      configPath: makeConfigFile(),
      queryBotOpenId: false,
      execLarkCli: async () => {
        called = true;
        return "{}";
      },
    });
    expect(called).toBe(false);
    expect(r.ids).toEqual([SELF_APP_ID]);
  });

  test("配置也读不到 + API 也失败 → ids 为空数组（不抛）", async () => {
    const r = await resolveSelfBotIdentities({
      profile: "tongzhuli",
      configPath: "/tmp/definitely-not-here-5459-b.json",
      execLarkCli: async () => {
        throw new Error("boom");
      },
    });
    expect(r.ids).toEqual([]);
  });

  test("app_id 与 open_id 相同时去重（防御异常配置）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "selfbot-dup-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ currentApp: "x", apps: [{ name: "x", appId: "SAME" }] }));
    const r = await resolveSelfBotIdentities({
      profile: "x",
      configPath: p,
      execLarkCli: async () => JSON.stringify({ data: { open_id: "SAME" } }),
    });
    expect(r.ids).toEqual(["SAME"]);
  });

  test("兼容 data.bot.open_id 形态（防 API 口径漂移）", async () => {
    const r = await resolveSelfBotIdentities({
      profile: "tongzhuli",
      configPath: makeConfigFile(),
      execLarkCli: async () => JSON.stringify({ data: { bot: { open_id: SELF_BOT_OPEN_ID } } }),
    });
    expect(r.botOpenId).toBe(SELF_BOT_OPEN_ID);
  });
});

// ============================================================================
// 热路径缓存 + 预热（★ 关键：门禁每条事件都跑，不能 await 网络）
// ============================================================================
//
// 实测教训：第一版把 `await lark-cli`（~1s）放进 handleEvent 最前面
// ⇒ 打挂 7 个 `await sleep(120)` 后断言的既有时序测试。
// 所以拆成：热路径同步读缓存 / 网络解析交给后台预热。

describe("Task #5459 — getCachedSelfBotIds（同步热路径）", () => {
  test("未预热时只返回 app_id（不 spawn 任何子进程、不阻塞）", () => {
    __resetSelfBotIdentityCacheForTest();
    const cfg = makeConfigFile();
    expect(getCachedSelfBotIds("tongzhuli", cfg)).toEqual([SELF_APP_ID]);
  });

  test("预热后包含 bot open_id", async () => {
    __resetSelfBotIdentityCacheForTest();
    const cfg = makeConfigFile();
    await warmSelfBotIdentities("tongzhuli", {
      configPath: cfg,
      execLarkCli: async () => JSON.stringify({ data: { open_id: SELF_BOT_OPEN_ID } }),
    });
    expect(getCachedSelfBotIds("tongzhuli", cfg)).toEqual([SELF_APP_ID, SELF_BOT_OPEN_ID]);
  });

  test("预热失败 → 缓存为空，热路径仍只返回 app_id（不抛）", async () => {
    __resetSelfBotIdentityCacheForTest();
    const cfg = makeConfigFile();
    await warmSelfBotIdentities("tongzhuli", {
      configPath: cfg,
      execLarkCli: async () => {
        throw new Error("boom");
      },
    });
    expect(getCachedSelfBotIds("tongzhuli", cfg)).toEqual([SELF_APP_ID]);
  });

  test("warm 幂等：同一 profile 只 spawn 一次 lark-cli", async () => {
    __resetSelfBotIdentityCacheForTest();
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return JSON.stringify({ data: { open_id: SELF_BOT_OPEN_ID } });
    };
    const cfg = makeConfigFile();
    await Promise.all([
      warmSelfBotIdentities("tongzhuli", { configPath: cfg, execLarkCli: exec }),
      warmSelfBotIdentities("tongzhuli", { configPath: cfg, execLarkCli: exec }),
    ]);
    await warmSelfBotIdentities("tongzhuli", { configPath: cfg, execLarkCli: exec });
    expect(calls).toBe(1);
  });

  test("profile 隔离：预热 tongzhuli 不影响 gonglin 的缓存", async () => {
    __resetSelfBotIdentityCacheForTest();
    const cfg = makeConfigFile();
    await warmSelfBotIdentities("tongzhuli", {
      configPath: cfg,
      execLarkCli: async () => JSON.stringify({ data: { open_id: SELF_BOT_OPEN_ID } }),
    });
    expect(getCachedSelfBotIds("gonglin", cfg)).toEqual(["cli_aXXXXXXXXXXXXXX"]);
  });

  test("配置读不到 → 空数组（门禁降级为只看 senderType）", () => {
    __resetSelfBotIdentityCacheForTest();
    expect(getCachedSelfBotIds("nope", "/tmp/definitely-not-here-5459-c.json")).toEqual([]);
  });
});
