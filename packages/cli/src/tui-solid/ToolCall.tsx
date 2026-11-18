/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview ToolCall — opencode-style tool invocation card, **Solid** fork.
 *
 * Forked from `tui/ToolCall.tsx` (Ink/React) for the `roy-bot interactive`
 * chain (Task #4278, 片1; 片2 fixes).
 *
 * Layout/format helpers (`describeToolCall` / `formatDuration`) are pure and
 * re-exported from the Ink-side `tool-call.ts` (single source of truth).
 *
 * ⚠️ 片2 fix (critical): `<Show>` children are **eagerly constructed** by bun's
 * Solid JSX transform, unlike React where a conditional element is never
 * created. `App` therefore used to crash with
 * `undefined is not an object (evaluating 'props.info.name')` as soon as any
 * history row existed, because `<ToolCall info={item.tool!}/>` was built even
 * when `item.tool` was undefined (1亿: the renderer ErrorBoundary swallowed it
 * and the UI silently froze). Two defences are kept:
 *   1. `props.info` is normalised to a non-null default (defensive).
 *   2. Conditional children are passed as **functions** (`{() => …}`) which
 *      restores Solid's laziness.
 *
 * Port notes (besides the above):
 *   <Box flexDirection="column" marginBottom={1}>  → <box style={{...}}>
 *   <Text color dimColor bold>                     → <text style={{ fg, attributes }}>
 *   {lines.map(...)}                               → <For each={...}>
 *   <Spinner/>                                     → Solid Spinner
 */

import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { Spinner } from "./Spinner.js";
import { fg, useTuiThemeReactive } from "./theme.js";
import {
  describeToolCall,
  formatDuration,
  type ToolCallInfo,
} from "../tui/tool-call.js";

export interface ToolCallProps {
  info: ToolCallInfo;
  /** Whether to show the output / error preview. Defaults to true. */
  showOutput?: boolean;
}

/** Never let a missing `info` crash the whole transcript (see 片2 note). */
const EMPTY_INFO: ToolCallInfo = { name: "tool", status: "completed" };

/** Status badge: spinner while running, ✓ / ✗ once settled. */
function StatusBadge(props: { info: ToolCallInfo }) {
  const theme = useTuiThemeReactive();
  const duration = () =>
    props.info.durationMs !== undefined ? ` ${formatDuration(props.info.durationMs)}` : "";

  return (
    <Show
      when={props.info.status === "running"}
      fallback={() => (
        <Show
          when={props.info.status === "error"}
          fallback={() => (
            <text style={{ fg: fg(theme.success) }}>{`✓${duration()}`}</text>
          )}
        >
          {() => (
            <text style={{ fg: fg(theme.error) }}>
              {`✗${duration() || " failed"}`}
            </text>
          )}
        </Show>
      )}
    >
      {() => <Spinner label="running" />}
    </Show>
  );
}

export function ToolCall(props: ToolCallProps) {
  const theme = useTuiThemeReactive();
  const info = () => props.info ?? EMPTY_INFO;
  const described = () => describeToolCall(info().name, info().args ?? {});
  const showOutput = () => props.showOutput ?? true;
  const outputLines = () =>
    showOutput() && info().output ? info().output!.split("\n") : [];
  const errorLines = () =>
    showOutput() && info().error ? info().error!.split("\n").slice(0, 12) : [];

  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      {/* Title: icon + humanised name + status badge */}
      <box style={{ flexDirection: "row" }}>
        <text style={{ fg: fg(theme.tool) }}>{described().icon + " "}</text>
        <text style={{ fg: fg(theme.tool), attributes: TextAttributes.BOLD }}>
          {described().label}
        </text>
        <text> </text>
        <StatusBadge info={info()} />
      </box>

      {/* Primary argument */}
      <Show when={described().detail}>
        {() => (
          <box style={{ marginLeft: 2 }}>
            <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
              {described().detail}
            </text>
          </box>
        )}
      </Show>

      {/* Output preview (completed calls) */}
      <For each={outputLines()}>
        {(line, i) => (
          <box style={{ marginLeft: 2 }}>
            <text style={{ fg: fg(theme.textMuted), attributes: TextAttributes.DIM }}>
              {(i() === 0 ? "└ " : "  ") + line}
            </text>
          </box>
        )}
      </For>

      {/* Error preview (failed calls) */}
      <For each={errorLines()}>
        {(line, i) => (
          <box style={{ marginLeft: 2 }}>
            <text style={{ fg: fg(theme.error) }}>
              {(i() === 0 ? "└ " : "  ") + line}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

export default ToolCall;
