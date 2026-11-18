/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5086 P5 验收集成测试 —— 换主题全 UI 色变 + NO_COLOR 全灰。
 *
 * 走 `resolveSolidTheme(env)` 环境变量入口，驱动真实 App 渲染，
 * 用 `captureSpans()` 读帧级 RGBA，断言：
 *   1. dark vs light：同一个 App、同一帧，bg/fg 的 token 色**不同**；
 *   2. NO_COLOR：整帧前景/背景色**全部**落到 opentui 默认（即 token="" → fg()=undefined）。
 *
 * 与 Theme.p5.test.ts 的差别：那个测纯函数形状，这个测**帧级像素**。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { App, type HistoryItem } from "./App.js";
import { isSolidReactive } from "./test-utils/solid-test-env.js";
import { setMarkdownPalette } from "../render/markdown.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

interface Span {
  text: string;
  fg: string;
  bg: string;
  attributes: number;
}

function spansOf(frame: { lines: Array<{ spans: Array<Span> }> }): Span[][] {
  // normalize RGBA objects (RGBA2 buffer) → "rgba(r, g, b, a)" strings
  const norm = (v: unknown): string => {
    if (typeof v === "string") return v;
    const buf = (v as { buffer?: Uint16Array })?.buffer;
    if (buf && buf.length >= 4) {
      return `rgba(${(buf[0] / 255).toFixed(2)}, ${(buf[1] / 255).toFixed(2)}, ${(buf[2] / 255).toFixed(2)}, ${(buf[3] / 255).toFixed(2)})`;
    }
    return String(v);
  };
  return frame.lines.map((l) =>
    l.spans.map((s) => ({ ...s, fg: norm(s.fg), bg: norm(s.bg) })),
  );
}

const HIST: HistoryItem[] = [
  { role: "user", content: "hello", id: "u1" },
  // Task #5086 P5 r2 (DS MAJOR-2): fixture MUST contain real markdown
  // with SGR sequences (heading + body) — a plain-text fixture lets
  // the baseStyle.fg pass while the SGR path stays broken.
  { role: "assistant", content: "# Heading\n\nbody text", id: "a1" },
];

async function mountWithEnv(env: NodeJS.ProcessEnv): Promise<{ spans: Span[][]; dispose: () => Promise<void> }> {
  const prev = { ...process.env };
  // 清空可能影响探测的环境变量，再注入我们的
  delete process.env.NO_COLOR;
  delete process.env.TERM;
  delete process.env.ROY_TUI_THEME;
  Object.assign(process.env, env);
  try {
    const t = await testRender(
      () => <App history={HIST} status="idle" model="fake/p5" workdir="/tmp" />,
      { width: 60, height: 16 },
    );
    await t.renderOnce();
    const spans = spansOf(t.captureSpans() as unknown as { lines: Array<{ spans: Span[] }> });
    return {
      spans,
      dispose: async () => {
        await t.dispose();
        // 恢复 env
        for (const k of ["NO_COLOR", "TERM", "ROY_TUI_THEME"]) delete process.env[k];
        Object.assign(process.env, prev);
        // Task #5086 P5 (DS r5 MAJOR-1): resolveSolidTheme() flips the
        // module-level markdown palette as a side effect. Restore the
        // default (dark) so subsequent test files don't inherit the
        // light palette — otherwise Markdown.nocolor assertions on
        // classic 16-colour codes fail when the file order changes.
        setMarkdownPalette("dark");
      },
    };
  } catch (e) {
    for (const k of ["NO_COLOR", "TERM", "ROY_TUI_THEME"]) delete process.env[k];
    Object.assign(process.env, prev);
    setMarkdownPalette("dark");
    throw e;
  }
}

describeIfClient("P5 换主题全 UI 色变 + NO_COLOR 降级（帧级）", () => {
  it("ROY_TUI_THEME=dark vs light：同帧前景色不同（token 化生效）", async () => {
    const dark = await mountWithEnv({ ROY_TUI_THEME: "dark" });
    const light = await mountWithEnv({ ROY_TUI_THEME: "light" });
    try {
      // 收集两帧里所有非空 span 的前景色
      const fgOf = (s: Span[][]) =>
        s
          .flat()
          .filter((x) => x.text.trim() !== "")
          .map((x) => x.fg);
      const darkFg = fgOf(dark.spans);
      const lightFg = fgOf(light.spans);
      // 至少有一对同位置 span 的 fg 不同 ⇒ token 切换穿透到了帧
      expect(darkFg.length).toBeGreaterThan(0);
      expect(lightFg.length).toBeGreaterThan(0);
      // dark primary=#fab283 = rgba(0.98,0.70,0.51)
      // light primary=#3b7dd8 = rgba(0.23,0.49,0.85)
      // banner 文字 "🚀 Roy Agent" 用 primary —— 直接断言它
      const findBanner = (s: Span[][]) =>
        s.flat().find((x) => x.text.includes("Roy Agent"));
      const darkBanner = findBanner(dark.spans);
      const lightBanner = findBanner(light.spans);
      expect(darkBanner).toBeDefined();
      expect(lightBanner).toBeDefined();
      expect(darkBanner!.fg).not.toBe(lightBanner!.fg);
    } finally {
      await dark.dispose();
      await light.dispose();
    }
  });

  it("NO_COLOR=1：帧前景/背景色全部走 opentui 默认（token 全空）", async () => {
    const noColor = await mountWithEnv({ NO_COLOR: "1" });
    const colored = await mountWithEnv({ ROY_TUI_THEME: "dark" });
    try {
      // NO_COLOR 下 primary/accent/error 都应是 "" → fg() 返 undefined → opentui 默认 fg。
      // 断言 banner 不再带 primary 色（dark 下 banner 是 #fab283）
      const findBanner = (s: Span[][]) => s.flat().find((x) => x.text.includes("Roy Agent"));
      const ncBanner = findBanner(noColor.spans);
      const cBanner = findBanner(colored.spans);
      expect(ncBanner).toBeDefined();
      expect(cBanner).toBeDefined();
      // 有色版 banner 前景 ≠ NO_COLOR 版（NO_COLOR 走默认）
      expect(ncBanner!.fg).not.toBe(cBanner!.fg);
      // NO_COLOR 下所有 span 的前景/背景都不应出现 dark token 的 hex 对应 RGBA
      const darkHex = ["rgba(0.98, 0.70, 0.51, 1.00)", "rgba(0.36, 0.61, 0.96, 1.00)"];
      const allFg = noColor.spans.flat().map((s) => s.fg);
      for (const bad of darkHex) {
        expect(allFg).not.toContain(bad);
      }
    } finally {
      await noColor.dispose();
      await colored.dispose();
    }
  });

  // Task #5086 P5 r2 (DS MAJOR-1/2 regression guards):
  //  - canvas bg must follow the token (light #ffffff vs dark #0a0a0a);
  //  - assistant body text must NOT stay pure white on light canvas.
  it("画布 bg 随 mode 变（light #ffffff ≠ dark #0a0a0a）", async () => {
    const dark = await mountWithEnv({ ROY_TUI_THEME: "dark" });
    const light = await mountWithEnv({ ROY_TUI_THEME: "light" });
    try {
      // assistant row: find the body text span and read canvas bg
      const bodyBgs = (s: Span[][]) =>
        s.flat().filter((x) => x.text.includes("body text")).map((x) => x.bg);
      const darkBg = bodyBgs(dark.spans);
      const lightBg = bodyBgs(light.spans);
      expect(darkBg.length).toBeGreaterThan(0);
      expect(lightBg.length).toBeGreaterThan(0);
      // dark canvas #0a0a0a = rgba(0.04,0.04,0.04); light #ffffff = rgba(1,1,1)
      expect(darkBg[0]).not.toBe(lightBg[0]);
      expect(lightBg[0]).toBe("rgba(1.00, 1.00, 1.00, 1.00)");
    } finally {
      await dark.dispose();
      await light.dispose();
    }
  });

  it("light 下助手正文 fg = theme.text（含 SGR 的真实 markdown）", async () => {
    const light = await mountWithEnv({ ROY_TUI_THEME: "light" });
    try {
      const bodyFgs = (s: Span[][]) =>
        s.flat().filter((x) => x.text.includes("body text")).map((x) => x.fg);
      const fgs = bodyFgs(light.spans);
      expect(fgs.length).toBeGreaterThan(0);
      // theme.text light = #1a1a1a → rgba(0.10, 0.10, 0.10)
      // (DS r2 MAJOR-2: assert the exact token, not just "not white")
      expect(fgs[0]).toBe("rgba(0.10, 0.10, 0.10, 1.00)");
    } finally {
      await light.dispose();
    }
  });

  // Task #5086 P5 (DS r3 MAJOR-2): the markdown ANSI palette must be
  // mode-aware — the classic 16-colour codes are dark-background tuned
  // (heading cyan #00cdcd = 1.98:1 on a white canvas).
  it("light 下 heading 色走 light 调色板（非 dark 的 #00cdcd）", async () => {
    const light = await mountWithEnv({ ROY_TUI_THEME: "light" });
    try {
      const headingFg = light.spans
        .flat()
        .filter((x) => x.text.includes("Heading"))
        .map((x) => x.fg);
      expect(headingFg.length).toBeGreaterThan(0);
      // dark palette cyan = #00cdcd = rgba(0.00, 0.80, 0.80)
      expect(headingFg[0]).not.toBe("rgba(0.00, 0.80, 0.80, 1.00)");
      // light palette cyan = #318795 = rgba(0.19, 0.53, 0.58)
      expect(headingFg[0]).toBe("rgba(0.19, 0.53, 0.58, 1.00)");
    } finally {
      await light.dispose();
    }
  });
});
