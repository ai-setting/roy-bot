/**
 * Task #5425 — 建群后新群无卡（230002 Bot/User can NOT be out of the chat）
 *
 * ## 根因（2026-11-13 07:25 用户实测日志）
 *
 * `handleGroupActionSessionOnly` 建群成功后调
 * `upsertSessionCard({chatId, ...})` 给新群发卡，但飞书报
 * **230002「Bot/User can NOT be out of the chat」**——
 * `createGroupChatViaLarkCli` 建群时 `--users` 只拉了操作者
 * （operatorOpenId），**bot 自己没有进群**（lark-cli `+chat-create
 * --as bot` 创建者 bot 默认不在群里，需显式 `--bots cli_xxx`）。
 * 发卡是 best-effort（只 warn），于是「建群成功但新群永远没卡」。
 *
 * ## 锁定的行为
 *
 * 1. `createGroupChatViaLarkCli` 支持 `initialBotIds`：
 *    传了就拼 `--bots`（逗号分隔），没传就不拼（向后兼容）。
 * 2. `handleGroupActionSessionOnly` 建群时把 bot app id
 *    传给 `createGroupChat`（通过 ports 透传 initialBotIds），
 *    bot 在群里 ⇒ 发卡不再 230002。
 * 3. 既有 `--users`（操作者拉人）语义不回归。
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(
  path.join(import.meta.dir, "lark-card-action-handler.ts"),
  "utf-8",
);

/** 抠出函数体（与 bugs.test.ts 同法） */
function extractFnBody(fnName: string, src: string): string {
  const lines = src.split("\n");
  const marker = `export async function ${fnName}`;
  const lineIndex = lines.findIndex((l) => l.includes(marker));
  if (lineIndex === -1) throw new Error(`Cannot find ${fnName}`);
  const collected: string[] = [];
  for (let i = lineIndex; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      i > lineIndex &&
      (trimmed.startsWith("export async function") ||
        trimmed.startsWith("export function "))
    ) {
      break;
    }
    collected.push(lines[i]);
  }
  return collected.join("\n");
}

describe("Task #5425：建群把 bot 拉进群（修 230002）", () => {
  test("T1. createGroupChatViaLarkCli 支持 initialBotIds → 拼 --bots", () => {
    const body = extractFnBody("createGroupChatViaLarkCli", SRC);
    expect(body).toContain("initialBotIds");
    expect(body).toMatch(/--bots/);
  });

  test("T2. handleGroupActionSessionOnly 建群时透传 initialBotIds", () => {
    // handleGroupActionSessionOnly 是函数内嵌套逻辑，直接对
    // handleGroupActionSessionOnly 调用点做源码级断言：
    // createGroupChat 调用点附近应有 initialBotIds 透传
    const idx = SRC.indexOf("async function handleGroupActionSessionOnly");
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = SRC.slice(idx, idx + 12000);
    // 建群调用带 initialBotIds
    expect(fnSrc).toMatch(/initialBotIds/);
    // bot app id 从环境/配置解析（不硬编码 cli_xxx 占位）
    expect(fnSrc).toMatch(/resolveBotAppId|botAppId/);
  });

  test("T3. --users 语义不回归（操作者仍被拉进群）", () => {
    const body = extractFnBody("createGroupChatViaLarkCli", SRC);
    expect(body).toMatch(/--users/);
    expect(body).toContain("initialUserIds");
  });
});
