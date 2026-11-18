/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Spinner — animated thinking indicator for the **Solid** TUI.
 *
 * Forked from `tui/Spinner.tsx` (Ink/React) for the `roy-bot interactive`
 * chain (Task #4278, 片1). Port notes (Ink → opentui/solid):
 *
 *   Ink                            opentui/solid
 *   ----------------------------- --------------------------------
 *   useEffect + useState(frame)    onMount + onCleanup + createSignal
 *   <Text dimColor>                <text style={{ fg, attributes }}>
 *   <Text><Text/>{x}</Text>        <text> 里嵌 <span>
 *
 * The frame list and 80ms cadence are intentionally unchanged so visual
 * output matches the Ink version.
 */

import { createSignal, onCleanup, onMount } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { fg, useTuiThemeReactive } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerProps {
  /** Label displayed next to the spinner glyph. */
  label: string;
  /** Frame interval in milliseconds. Defaults to 80. */
  intervalMs?: number;
}

export function Spinner(props: SpinnerProps) {
  const [frame, setFrame] = createSignal(0);
  const theme = useTuiThemeReactive();

  onMount(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, props.intervalMs ?? 80);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <text>
      <span style={{ fg: fg(theme.primary) }}>{FRAMES[frame()]}</span>
      <span style={{ fg: fg(theme.muted), attributes: TextAttributes.DIM }}>
        {" "}
        {props.label}
      </span>
    </text>
  );
}
