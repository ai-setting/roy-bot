/**
 * @fileoverview Popup scrolling screenshot generator (Task #2316)
 *
 * 用 ink-testing-library 渲染 SlashCommandPopup 在不同 selectedIndex 下的输出,
 * 把 ANSI 转义序列写入文本文件, 然后用 scripts/render_ansi_to_png.py 转成 PNG.
 *
 * 生成 2 张截图:
 * - screenshot-popup-middle.txt/.png  selectedIndex=7 (中段滚动, /attach 高亮)
 * - screenshot-popup-bottom.txt/.png  selectedIndex=12 (底部, /abort 高亮)
 *
 * 任务记录:
 * - Task #2316: 修复 slash command popup 滚动 bug
 */

import * as React from "react";
import { render } from "ink-testing-library";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { SlashCommandPopup } from "../src/commands/ui/slash-command-popup";
import { COMMANDS } from "../src/commands/ui/commands-registry";

/**
 * 把 ANSI 截图写到 <repo-root>/reports/2026-07-23-popup-scrolling/ (worktree 根)
 * 从 packages/cli/ 运行: ../../reports/...
 * 从 worktree 根运行: reports/...
 * 兼容两种: 用 process.cwd() 探测.
 */
const REPORTS_DIR = (() => {
  const cwd = process.cwd();
  // 如果在 packages/cli 子目录, 回到 worktree 根
  const repoRoot = cwd.endsWith("/packages/cli") || cwd.endsWith("packages\\cli")
    ? resolve(cwd, "..", "..")
    : cwd;
  return join(repoRoot, "reports/2026-07-23-popup-scrolling");
})();
mkdirSync(REPORTS_DIR, { recursive: true });

interface ShotSpec {
  /** selectedIndex passed to popup */
  selectedIndex: number;
  /** output text file name (without .txt) */
  textFile: string;
  /** description for log */
  label: string;
}

const SHOTS: ShotSpec[] = [
  { selectedIndex: 7, textFile: "screenshot-1-popup-middle-scroll", label: "middle scroll (selectedIndex=7, /attach highlighted, 4 more ↑ / 1 more ↓)" },
  { selectedIndex: 12, textFile: "screenshot-2-popup-bottom-scroll", label: "bottom scroll (selectedIndex=12, /abort highlighted, 5 more ↑)" },
];

function capture(spec: ShotSpec): void {
  const { lastFrame, unmount } = render(
    React.createElement(SlashCommandPopup, {
      query: "/", // 全部 13 个命令
      selectedIndex: spec.selectedIndex,
    }),
  );
  // 给 ink 一点时间让 ANSI escape sequence 稳定
  // (lastFrame 是同步的, 但内部 setImmediate 已经调度)
  const frame = lastFrame() ?? "";

  // 在最前面加一个空行 (视觉边距) + 提示行
  const header = `\x1b[36m┌─ Task #2316: popup scrolling fix ────────────────────────┐\x1b[0m\r\n\x1b[36m│\x1b[0m \x1b[1m${spec.label}\x1b[0m\r\n\x1b[36m│\x1b[0m Total commands: \x1b[33m${COMMANDS.length}\x1b[0m  MAX_POPUP_ITEMS: 8\r\n\x1b[36m└──────────────────────────────────────────────────────────┘\x1b[0m\r\n\r\n`;
  const full = header + frame + "\r\n";

  const outPath = resolve(REPORTS_DIR, `${spec.textFile}.txt`);
  writeFileSync(outPath, full, "utf-8");
  console.log(`✓ Wrote ${outPath}`);

  unmount();
}

console.log(`[popup-scroll-shots] Output dir: ${REPORTS_DIR}`);
console.log(`[popup-scroll-shots] COMMANDS.length = ${COMMANDS.length}`);
for (const shot of SHOTS) {
  console.log(`[popup-scroll-shots] Capturing: ${shot.label}`);
  capture(shot);
}
console.log(`[popup-scroll-shots] Done. Run scripts/render_ansi_to_png.py to convert to PNG.`);
