/**
 * @fileoverview App — Ink root component for the roy-bot CLI.
 *
 * Task #2610 stage 2: implements the prototype App.tsx from
 * refs/imported/ink-tui-overhaul.
 *
 * Composition:
 *   ┌────────────────────────────────────────┐
 *   │  Header banner                         │
 *   │  <Static items={history}>              │  ← rendered once, immutable
 *   │    - user message                      │
 *   │    - assistant message (markdown)      │
 *   │    - tool result                       │
 *   │  </Static>                             │
 *   │  <Spinner/> when status=thinking       │  ← dynamic region
 *   │  <Prompt/> when status=idle            │
 *   │  <StreamingMessage/> when streaming    │
 *   │  <ToolCall/> live tool cards (Task #4124)│
 *   │  ───────────────────────────────────── │
 *   │  <StatusBar/>                          │
 *   └────────────────────────────────────────┘
 *
 * pi-mono note: pi-mono uses a custom <Container> framework that does
 * diff-based re-rendering to avoid full-screen flicker. For Phase 1 we
 * use Ink's <Static> component (designed for exactly this use case) and
 * accept that the dynamic region re-renders on each tick.
 */

import React from "react";
import { Box, Static, Text } from "ink";
import { Markdown } from "./Markdown.js";
import { Spinner } from "./Spinner.js";
import { StatusBar } from "./StatusBar.js";
import { ToolCall } from "./ToolCall.js";
import type { ToolCallInfo } from "./tool-call.js";
import { getTheme } from "./theme.js";
// Task #4396: dim grey cache/token footer under every assistant message.
import { UsageFooter, type UsageLike } from "./UsageFooter.js";

/**
 * Task #4396: `usage` is a standalone footer row rather than a property of the
 * assistant row. Ink's <Static> only ever *appends* — patching a row that was
 * already committed never repaints it, so the footer must be its own item.
 */
export type Role = "user" | "assistant" | "tool" | "usage";

export interface HistoryItem {
  role: Role;
  content: string;
  /**
   * Task #4124: when set on a `tool` row, the item renders as an
   * opencode-style tool card (icon + name + args + status + output)
   * instead of the plain dim one-liner used for notifications / slash
   * replies.
   */
  tool?: ToolCallInfo;
  /**
   * Task #4123: marks a block that continues the *same* assistant message
   * as the previous item (progressive scrollback commit emits one item per
   * stable markdown block). Continuation items suppress the repeated role
   * heading so a streamed reply still reads as one "🤖 Agent" message.
   */
  continuation?: boolean;
  /**
   * Stable identifier for React reconciliation.
   *
   * Task #3001: Without a stable id, `<Static items={history}>` keys on
   * `${role}:${content}` — two messages with identical content collide
   * (duplicate-key warning) AND content updates cause the entire Static
   * region to re-render (UI flicker / 跳变).
   *
   * When `id` is present, App uses it as the React key, so:
   *   - Same id across re-renders → React reuses the existing element (no re-output).
   *   - New id → React mounts a fresh Static row (only the new row is printed).
   *   - Two messages with same content but different ids → no collision.
   *
   * Backward compat: when `id` is missing, App falls back to
   * `${role}:${index}` (still unique because index differs in append-only flow).
   */
  id?: string;
  /**
   * Task #4396: usage of the LLM call that produced this assistant message.
   * Rendered as a dim grey footer underneath the message body.
   */
  usage?: UsageLike;
}

export type AppStatus = "idle" | "thinking" | "streaming";

export interface AppProps {
  /** Completed messages to render in the static region. */
  history: HistoryItem[];
  /** Current dynamic state. */
  status: AppStatus;
  /** Model identifier for the status bar. */
  model?: string;
  /** Working directory for the status bar. */
  workdir?: string;
  /** Live streaming text (shown only when status=streaming). */
  streamingText?: string;
  /**
   * Task #4124: tool calls currently executing. Rendered in the dynamic
   * region so the user sees "running" cards; each is moved into
   * `history` (as a `tool` item) when its result arrives.
   */
  liveTools?: ToolCallInfo[];
  /** Token count for the status bar. */
  tokenCount?: number;
}

const ROLE_PREFIX: Record<Role, string> = {
  user: "👤 You",
  assistant: "🤖 Agent",
  tool: "🔧 Tool",
  usage: "",
};

const RoleLabel: React.FC<{ role: Role }> = ({ role }) => {
  // Task #2657 R2: route role colors through theme
  const theme = getTheme();
  const roleColor =
    role === "user"
      ? theme.user
      : role === "assistant"
      ? theme.assistant
      : theme.tool;
  return (
    <Text bold color={roleColor}>
      {ROLE_PREFIX[role]}
    </Text>
  );
};

const HistoryEntry: React.FC<{ item: HistoryItem }> = ({ item }) => {
  if (item.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <RoleLabel role="user" />
        <Box marginLeft={2}>
          <Text>{item.content}</Text>
        </Box>
      </Box>
    );
  }
  if (item.role === "tool") {
    // Task #4124: structured tool cards render through <ToolCall/>;
    // plain tool rows (notifications, slash replies) keep the one-liner.
    if (item.tool) {
      return <ToolCall info={item.tool} />;
    }
    return (
      <Box flexDirection="column" marginBottom={1}>
        <RoleLabel role="tool" />
        <Box marginLeft={2}>
          <Text dimColor>{item.content}</Text>
        </Box>
      </Box>
    );
  }
  // Task #4396: standalone dim grey footer row (its own <Static> item so it
  // can actually be painted after the assistant text it belongs to).
  if (item.role === "usage") {
    return <UsageFooter usage={item.usage} />;
  }
  // assistant: render as markdown
  return (
    <Box flexDirection="column" marginBottom={1}>
      {item.continuation ? null : <RoleLabel role="assistant" />}
      <Box marginLeft={2} flexDirection="column">
        <Markdown text={item.content} />
      </Box>
    </Box>
  );
};

export const App: React.FC<AppProps> = ({
  history,
  status,
  model,
  workdir,
  streamingText,
  liveTools,
  tokenCount,
}) => {
  // Task #2657 R2: header banner color via theme
  const theme = getTheme();

  return (
    <Box flexDirection="column">
      {/* Header banner */}
      <Box
        borderStyle="round"
        borderColor={theme.primary}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold color={theme.primary}>
          🚀 Roy Agent
        </Text>
        <Text dimColor> — interactive TUI</Text>
      </Box>

      {/* Static history — rendered once, never re-rendered */}
      {/* Task #3001: Use stable `id` as React key (when present) so that
          - previously-rendered Static rows are not re-output (no flicker)
          - two messages with identical content don't collide
          Falls back to role:content:index when id is missing (backward compat). */}
      <Static items={history}>
        {(item, index) => (
          <HistoryEntry
            key={item.id ?? `${item.role}:${index}`}
            item={item}
          />
        )}
      </Static>

      {/* Dynamic region */}
      {status === "thinking" ? (
        <Box marginBottom={1}>
          <Spinner label="Agent is thinking..." />
        </Box>
      ) : null}
      {status === "streaming" && streamingText ? (
        <Box flexDirection="column" marginBottom={1}>
          <RoleLabel role="assistant" />
          <Box marginLeft={2}>
            <Markdown text={streamingText} />
          </Box>
        </Box>
      ) : status === "streaming" ? (
        <Box marginBottom={1}>
          <Spinner label="Generating response..." />
        </Box>
      ) : null}

      {/* Task #4124: live (running) tool cards. Kept in the dynamic region
          while the tool executes; moved into `history` once settled. */}
      {liveTools && liveTools.length > 0 ? (
        <Box flexDirection="column">
          {liveTools.map((tool, i) => (
            <ToolCall key={`live-tool-${i}`} info={tool} />
          ))}
        </Box>
      ) : null}

      {/* Task #4103 follow-up (opencode-style split layout): the transcript
          is committed to <Static> (the terminal's native scrollback) above,
          and the live frame below stays *short* — in-flight tail + status +
          prompt. There is deliberately NO full-height spacer / minHeight:
          a frame pinned to the full terminal height leaves a huge blank
          once a message is committed to scrollback (the completed text is
          no longer part of the frame). Reference: opencode's "mini"
          split-footer mode keeps the footer short and lets the terminal
          scroll the transcript. */}

      {/* Footer status bar */}
      <StatusBar
        model={model}
        workdir={workdir}
        tokenCount={tokenCount}
      />
    </Box>
  );
};

export default App;