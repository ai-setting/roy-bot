/**
 * @fileoverview ChatTui — Ink one-shot screen for one-message queries.
 *
 * Task #2610 stage 3: implements the prototype ChatTui.tsx from
 * refs/imported/ink-tui-overhaul. Mounts an <App> with the user message
 * as initial history, shows a Spinner while the query resolves, then
 * the markdown-rendered answer, then auto-exits.
 *
 * Streaming strategy: same one-shot as the prototype — the full reply
 * is rendered at once when the query resolves. (Streaming live updates
 * are a future enhancement.)
 */

import React, { useEffect, useRef, useState } from "react";
import { Box, useApp } from "ink";
import { App, type HistoryItem } from "./tui/index.js";
import { useStreamingAccumulator } from "./tui/use-streaming-accumulator.js";
import {
  renderMarkdown,
  truncateForTerminal,
} from "./render/markdown.js";

export interface ChatTuiProps {
  /** Async function that returns the assistant reply as a string. */
  handleQuery: (message: string) => Promise<string>;
  /**
   * Task #2657 Round 2 (T-A): streaming variant. If provided, ChatTui
   * uses this instead of handleQuery and shows live deltas.
   */
  streamHandleQuery?: (
    message: string,
    onChunk: (chunk: string) => void
  ) => Promise<string>;
  /** The message that was sent (shown as user message in history). */
  message: string;
  /** Model identifier for the status bar. */
  model?: string;
  /** Working directory for the status bar. */
  workdir?: string;
  /** Max lines per response (0 = no limit). */
  maxLines: number;
  /** Whether markdown rendering is enabled. */
  markdownEnabled: boolean;
}

export const ChatScreen: React.FC<ChatTuiProps> = ({
  handleQuery,
  streamHandleQuery,
  message,
  model,
  workdir,
  maxLines,
  markdownEnabled,
}) => {
  const [history, setHistory] = useState<HistoryItem[]>([
    // Task #3001: stable id on the initial user message so App's Static
    // row is keyed by id (not role:content) and not re-output.
    { role: "user", content: message, id: "h-init-1" },
  ]);
  // Task #3001: stable id counter for additional history rows.
  // Starts at 1 because the initial user message uses id "h-init-1".
  const historyIdRef = useRef(1);
  // Task #2657 R2 T-A: streaming accumulator for live deltas
  const stream = useStreamingAccumulator();
  const { exit } = useApp();

  const width = process.stdout.columns ?? 80;

  useEffect(() => {
    let cancelled = false;
    stream.start();
    (async () => {
      try {
        let responseText: string;
        if (streamHandleQuery) {
          responseText = await streamHandleQuery(message, (chunk) =>
            stream.append(chunk)
          );
        } else {
          responseText = await handleQuery(message);
        }
        if (cancelled) return;
        stream.finish();
        const rendered = markdownEnabled
          ? renderMarkdown(responseText, { width })
          : responseText;
        const finalText = truncateForTerminal(rendered, maxLines);

        // Task #3001: allocate a stable id for the new assistant row.
        const assistantId = `h${++historyIdRef.current}`;
        setHistory((h) => [
          ...h,
          { role: "assistant", content: finalText, id: assistantId },
        ]);
        // Auto-exit on completion so one-shot chat returns to the shell
        setTimeout(() => exit(), 100);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        stream.fail(err instanceof Error ? err : new Error(msg));
        // Task #3001: allocate a stable id for the error row.
        const errorId = `h${++historyIdRef.current}`;
        setHistory((h) => [
          ...h,
          { role: "tool", content: `❌ Error: ${msg}`, id: errorId },
        ]);
        setTimeout(() => exit(), 100);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleQuery, streamHandleQuery, message, maxLines, markdownEnabled, exit, width, stream]);

  return (
    <Box flexDirection="column">
      <App
        history={history}
        status={stream.status}
        model={model}
        workdir={workdir}
        streamingText={stream.streamingText}
      />
    </Box>
  );
};

export default ChatScreen;