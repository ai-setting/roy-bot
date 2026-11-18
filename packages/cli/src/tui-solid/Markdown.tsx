/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Markdown — Solid wrapper around the ANSI markdown renderer.
 *
 * Forked from `tui/Markdown.tsx` (Ink/React) for the `roy-bot interactive`
 * chain (Task #4278, 片1; ANSI conversion added in 片2).
 *
 * Strategy: we do NOT re-parse markdown here. `renderMarkdown()` (shared with
 * the Ink chain) already emits SGR-styled text.
 *
 * ⚠️ 片2 measured difference (this is why 片1's `<text content={ansi}>` was wrong):
 *   Ink's `<Text>` interprets nested SGR escapes; opentui's `<text content>`
 *   renders them as **literal** text — a reply containing `**bold**` showed up
 *   as `[1mbold[22m`.
 *   Fix: convert the SGR string into `<span style={…}>` runs (`ansiToRuns`).
 *   We deliberately stay on the ANSI path instead of adopting opentui's native
 *   `<markdown>` renderable so the Ink chain and this chain share one renderer
 *   (single variable during migration, per §2-R6).
 *
 * Streaming safety: `renderMarkdown()` tolerates unclosed fences / inline
 * markers, and `ansiToRuns()` tolerates a truncated trailing escape, so partial
 * input can be passed straight through.
 */

import { For, Show } from "solid-js";
import { renderMarkdown } from "../render/markdown.js";
import { ansiToRuns } from "./style.js";
import { fg, useTuiThemeReactive } from "./theme.js";

export interface MarkdownProps {
  /** Markdown source (may be partial while streaming). */
  text: string;
  /** Optional override for the wrap width. Defaults to `process.stdout.columns`. */
  width?: number;
}

/**
 * Render markdown text inside a Solid `<text>` block.
 *
 * The output is a sequence of `<span>` runs; opentui lays the `<text>` out as
 * a normal flex child, so wrapping matches the Ink version.
 */
export function Markdown(props: MarkdownProps) {
  const theme = useTuiThemeReactive();
  const effectiveWidth = () => props.width ?? process.stdout.columns ?? 80;
  const rendered = () => renderMarkdown(props.text, { width: effectiveWidth() });
  // Task #5086 P5 MAJOR-2 fix: spans without an explicit fg inherit the
  // terminal default (near-white), which is unreadable on a light canvas.
  // `ansiToRuns(input, baseStyle)` merges `baseStyle` under each run —
  // feeding `fg: theme.text` makes plain markdown text follow the token
  // (dark #eeeeee / light #1a1a1a) while SGR-coloured runs keep their own fg.
  const runs = () => ansiToRuns(rendered(), { fg: fg(theme.text) });

  return (
    <Show when={runs().length > 0}>
      <text>
        <For each={runs()}>{(run) => <span style={run.style}>{run.text}</span>}</For>
      </text>
    </Show>
  );
}

export default Markdown;
