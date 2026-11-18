/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview StatusBar — Solid footer status line (compact mode).
 *
 * Forked from `tui/StatusBar.tsx` (Ink/React) for the `roy-bot interactive`
 * chain (Task #4278, 片1).
 *
 * The layout planner (`planSegments` / `shortenWorkdir` / `clipModel`) is
 * **pure** and kept byte-identical to the Ink version so the narrow-terminal
 * behaviour (Task #4160) is unchanged. Only the render path differs:
 *
 *   Ink                                  opentui/solid
 *   ------------------------------------ ----------------------------------
 *   <Box>                                <box>
 *   <Text color dimColor bold>           <text style={{ fg, attributes }}>
 *   array.map(...)                       <For each={...}>
 */

import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { fg, useTuiThemeReactive } from "./theme.js";
import type { TuiSolidTheme } from "./theme.js";

export interface StatusBarProps {
  model?: string;
  workdir?: string;
  tokenCount?: number;
  columns?: number;
  /** ★ Task #4954 P1：左段状态（"Build" 默认 / "esc interrupt" 工作中）。 */
  status?: string;
  /** ★ Task #4954 P1：右段快捷键提示（单一 hint 来源）。 */
  hint?: string;
}

function detectColumns(): number {
  const c = process.stdout?.columns;
  if (typeof c === "number" && c > 0) return c;
  return 80;
}

const WORKDIR_TAIL_MAX = 30;
const MODEL_NARROW_MAX = 24;

export function shortenWorkdir(input: string | undefined): string | undefined {
  if (!input) return input;
  if (input.length <= WORKDIR_TAIL_MAX) return input;
  const tail = input.slice(input.length - WORKDIR_TAIL_MAX);
  return `\u2026/${tail}`;
}

export function clipModel(input: string | undefined, max = MODEL_NARROW_MAX): string | undefined {
  if (!input) return input;
  if (input.length <= max) return input;
  return input.slice(0, max - 1) + "\u2026";
}

export interface RenderedSegment {
  text: string;
  color: "primary" | "accent" | "muted";
  dimPrefix?: string;
}

/** Narrow-terminal segment planner — identical logic to the Ink version.
 *
 * ★ Task #4954 P1：重排为**三段**（对齐 opencode 用户截图基准）：
 *   左  = status（"Build"/"esc interrupt"）· model
 *   中  = 📁 workdir
 *   右  = hint（快捷键提示，单一来源）
 * 窄终端逐级降级：tier1 只留 model+hint；tokenCount 保留 tier>=2。
 */
export function planSegments(
  props: Pick<StatusBarProps, "model" | "workdir" | "tokenCount" | "status" | "hint">,
  columns: number,
): RenderedSegment[] {
  const segs: RenderedSegment[] = [];
  const tier = columns >= 80 ? 4 : columns >= 60 ? 3 : columns >= 40 ? 2 : 1;

  // 左段：状态 · 模型
  if (props.status && tier >= 3) {
    segs.push({ text: props.status, color: "primary" });
  }
  if (props.model) {
    const text = tier === 1 ? clipModel(props.model) ?? "" : props.model;
    segs.push({ text, color: "primary", dimPrefix: tier >= 3 ? "\u00b7 " : "\uD83E\uDD16 " });
  }
  // 中段：工作目录
  if (tier >= 3) {
    if (props.workdir) {
      segs.push({
        text: shortenWorkdir(props.workdir) ?? "",
        color: "muted",
        dimPrefix: "\uD83D\uDCC1 ",
      });
    }
  }
  if (tier >= 2) {
    if (typeof props.tokenCount === "number") {
      segs.push({ text: `n=${props.tokenCount}`, color: "accent" });
    }
  }
  // 右段：快捷键提示（★ 单一 hint 来源；旧硬编码 "Ctrl+C to exit" 退役，
  // 由调用方按 stream.status 传 "ctrl+c exit"/"esc interrupt"）。
  if (props.hint && tier >= 2) {
    segs.push({ text: props.hint, color: "muted" });
  }
  return segs;
}

const COLOR_KEY: Record<RenderedSegment["color"], keyof TuiSolidTheme> = {
  primary: "primary",
  accent: "accent",
  muted: "muted",
};

export function StatusBar(props: StatusBarProps) {
  const theme = useTuiThemeReactive();
  const segments = () => planSegments(props, props.columns ?? detectColumns());

  // ★ Task #4954 P1：三段**分位**渲染（对齐 opencode 截图基准）：
  //   左（状态·模型）flexGrow=1 占满中段 → 中（workdir）→ 右（hint）。
  //   顺序 For 拼接（旧实现）会让 hint 出现在最左——视觉错位。
  //   用一个 flexGrow=1 的 spacer 把 workdir 之后的内容推到右边。
  const leftSegs = () => segments().filter((_, i) => i < leftCount(segments()));
  const rightSegs = () => segments().slice(leftCount(segments()));

  return (
    <box style={{ flexDirection: "row", gap: 1 }}>
      <For each={leftSegs()}>
        {(seg, i) => (
          <>
            {i() > 0 ? (
              <text style={{ fg: fg(theme.muted), attributes: TextAttributes.DIM }}>{" \u00b7 "}</text>
            ) : null}
            {seg.dimPrefix ? (
              <text style={{ fg: fg(theme.muted), attributes: TextAttributes.DIM }}>{seg.dimPrefix}</text>
            ) : null}
            <text style={{ fg: fg(theme[COLOR_KEY[seg.color]]) }}>{seg.text}</text>
          </>
        )}
      </For>
      <box style={{ flexGrow: 1 }} />
      <For each={rightSegs()}>
        {(seg, i) => (
          <>
            {i() > 0 ? (
              <text style={{ fg: fg(theme.muted), attributes: TextAttributes.DIM }}>{" \u00b7 "}</text>
            ) : null}
            <text style={{ fg: fg(theme[COLOR_KEY[seg.color]]) }}>{seg.text}</text>
          </>
        )}
      </For>
    </box>
  );
}

/** workdir 及其 dimPrefix 在 segs 中的下标（中段起点 = 左段结束）。 */
function leftCount(segs: RenderedSegment[]): number {
  const idx = segs.findIndex((seg) => seg.dimPrefix === "\uD83D\uDCC1 ");
  return idx === -1 ? segs.length : idx;
}

export default StatusBar;
