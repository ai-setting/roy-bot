/** @jsxImportSource @opentui/solid */
/**
 * frame-shot-p5.tsx — Task #5086 P5 帧级截图取证。
 *
 * 渲染同一份 App（含 banner + user/assistant/tool 三类消息 + 滚动条），
 * 分别在 dark / light / NO_COLOR 三种模式下抓帧，落 /tmp/tui-p5/：
 *   - frame-dark.txt   （字符帧）
 *   - frame-light.txt
 *   - frame-nocolor.txt
 *   - spans-{dark,light,nocolor}.json （带 fg/bg RGBA 的原始 span 数据，
 *     供 frames-to-png-p5.py 真彩渲染成 PNG）
 *
 * 为什么 testRender 而非 xterm/pty：本机 xterm/pty 链路连 main 的 dist
 * 都立即退出（P3 Phase 2 已实证，环境级既有问题）；testRender 走同一
 * opentui 渲染管线，帧级 RGBA 是真实像素证据。
 *
 * 用法: bun --conditions=browser scripts/tui-solid/frame-shot-p5.tsx
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { testRender } from "@opentui/solid";
import { App, type HistoryItem } from "../../packages/cli/src/tui-solid/App.tsx";

const COLS = 90;
const ROWS = 32;
const OUT = "/tmp/tui-p5";

const HIST: HistoryItem[] = [
  { role: "user", content: "P5 主题怎么落地？", id: "u1" },
  {
    role: "assistant",
    content:
      "## 核心思路\n\n全部改读 token：\n\n- primary/secondary/accent\n- background/border\n\n```ts\nconst theme = resolveSolidTheme();\n```",
    id: "a1",
  },
  { role: "tool", content: "✓ 329 pass", id: "t1" },
  { role: "assistant", content: "NO_COLOR 全灰。", id: "a2" },
];

async function shot(name: string, env: NodeJS.ProcessEnv) {
  // 清环境再注入，避免串扰
  delete process.env.NO_COLOR;
  delete process.env.TERM;
  delete process.env.ROY_TUI_THEME;
  Object.assign(process.env, env);

  const t = await testRender(
    () => <App history={HIST} status="idle" model="fake/p5-theme" workdir="/tmp" />,
    { width: COLS, height: ROWS },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  const spans = t.captureSpans();
  writeFileSync(`${OUT}/frame-${name}.txt`, frame);
  writeFileSync(`${OUT}/spans-${name}.json`, JSON.stringify(spans, null, 2));
  console.log(`[${name}] frame=${frame.split("\n").length} rows  spans lines=${spans.lines.length}`);
  await t.dispose();
}

mkdirSync(OUT, { recursive: true });
await shot("dark", { ROY_TUI_THEME: "dark" });
await shot("light", { ROY_TUI_THEME: "light" });
await shot("nocolor", { NO_COLOR: "1" });
console.log(`frames + spans written to ${OUT}`);
