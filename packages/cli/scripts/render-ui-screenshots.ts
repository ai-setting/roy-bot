/**
 * @fileoverview 生成 roy-bot UI 改造前/后截图对比
 *
 * Task #2252: Step 7 - 截图
 *
 * 流程：
 *   1. 生成"改造前"截图（旧 printHeader ╔══╗ 风格）
 *   2. 生成"改造后"截图（新的欢迎卡 + 状态栏）
 *   3. 用 rich 渲染成 PNG，保存到 /tmp/roy-ui-before.png 和 /tmp/roy-ui-after.png
 *
 * 用法：
 *   cd ~/work/codework/personal/roy-ui-v2
 *   bun packages/cli/scripts/render-ui-screenshots.ts
 */

import { buildWelcomeCard } from "../src/commands/ui/welcome-card";
import { buildStatusBar } from "../src/commands/ui/status-bar";
import { buildTopBorder, buildBottomBorder } from "../src/commands/ui/input-slot";
import { COLORS } from "../src/services/stream-output.service";
import * as fs from "node:fs/promises";

/**
 * 旧版 printHeader 的输出（mock 改造前的样子）。
 */
function buildOldHeader(model: string, cwd: string, version: string, sessionTitle: string): string {
  const cyan = COLORS.userInput;
  const dim = COLORS.muted;
  return [
    "",
    "\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557",
    "\u2551          " + COLORS.assistant("roy-bot") + " Interactive Mode" + "              \u2551",
    "\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D",
    "",
    dim("\u4f1a\u8bdd: ") + sessionTitle,
    dim("\u8f93\u5165 ") + cyan("/help") + dim(" \u67e5\u770b\u53ef\u7528\u547d\u4ee4"),
    "",
  ].join("\n");
}

/**
 * 新版完整 UI（欢迎卡 + 槽位 hint + 状态栏）。
 */
function buildNewUI(model: string, cwd: string, version: string, sessionTitle: string): string {
  const lines: string[] = [];
  lines.push(buildWelcomeCard({ model, cwd, version, sessionTitle }));
  lines.push("");  // spacer
  lines.push(buildTopBorder());
  lines.push("\u2502 " + COLORS.muted("Try \"/help\" or ask anything...").replace(/\u001b\[[0-9;]*m/g, "").trimEnd() + " \u2502");
  lines.push(buildBottomBorder());
  lines.push("");
  lines.push(cyan("❯ ") + dim("(waiting for input)"));
  lines.push("");
  // 状态栏：先 ready，再 thinking，再 executing
  lines.push(buildStatusBar({ mode: "ready" }));
  lines.push(buildStatusBar({ mode: "thinking" }));
  lines.push(buildStatusBar({ mode: "executing", detail: "bash" }));
  return lines.join("\n");
}

function cyan(s: string): string {
  return COLORS.userInput(s);
}
function dim(s: string): string {
  return COLORS.muted(s);
}

// ============== main ==============

const ctx = {
  model: "MiniMax-M3",
  cwd: "~/work/codework/personal/roy_world/roy-bot",
  version: "1.6.13",
  sessionTitle: "ui-revamp-demo",
};

const before = buildOldHeader(ctx.model, ctx.cwd, ctx.version, ctx.sessionTitle);
const after = buildNewUI(ctx.model, ctx.cwd, ctx.version, ctx.sessionTitle);

console.log("===== BEFORE =====");
console.log(before);
console.log("");
console.log("===== AFTER =====");
console.log(after);

// 保存为文本（方便后续用 rich 渲染）
await fs.writeFile("/tmp/roy-ui-before.txt", before);
await fs.writeFile("/tmp/roy-ui-after.txt", after);
console.log("\n[OK] Text files saved to /tmp/roy-ui-before.txt and /tmp/roy-ui-after.txt");
