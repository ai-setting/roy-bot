/**
 * @fileoverview CLI Markdown rendering demo
 *
 * Drives `StreamOutputService` with a deterministic markdown payload split
 * into realistic LLM-style deltas (no real LLM call — fixture text only).
 * Used by Task #2193 for trace closure + visual screenshot baseline.
 *
 * Usage:
 *   bun scripts/cli-markdown-render-demo.ts
 *
 * Output:
 *   - Writes ANSI-styled assistant text to stdout
 *   - Records `stream.handle-text` and `markdown.render-delta` spans to spans.db
 *   - Exits 0 after a brief pause so the spans.db flush completes
 */

import { StreamOutputService, resetStreamAbort } from "../packages/cli/src/services/stream-output.service";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

/** A realistic streaming payload: heading + paragraph + bold + code block + list + link. */
const DELTAS: string[] = [
  "# Claude Code CLI Output\n",
  "Below is a sample of how Markdown text becomes ANSI in the terminal.\n",
  "\n",
  "**bold** text and *italic* and `inline_code` mix together here.\n",
  "\n",
  "```ts\n",
  "const greeting: string = \"hello\";\n",
  "console.log(greeting);\n",
  "```\n",
  "\n",
  "- First item\n",
  "- Second item\n",
  "- Third item\n",
  "\n",
  "> A blockquote line with dim style.\n",
  "\n",
  "Visit [docs](https://example.test/docs) for more info.\n",
];

function ts(offsetMs: number = 0): number {
  return Date.now() + offsetMs;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  resetStreamAbort();
  const svc = new StreamOutputService();

  // llm.start — opens a session
  svc.handleEvent({
    id: "evt-start",
    type: "llm.start",
    timestamp: ts(0),
    metadata: {},
    payload: {
      model: "demo-fixture",
      providerId: "demo",
      sessionId: "demo-session-1",
      traceId: "demo-trace-1",
    },
  });

  // Feed each delta with a tiny inter-delta delay (mimics real LLM stream)
  for (let i = 0; i < DELTAS.length; i++) {
    svc.handleEvent({
      id: `evt-text-${i}`,
      type: "llm.text",
      timestamp: ts(10 + i * 5),
      metadata: { traceId: "demo-trace-1" },
      payload: { delta: DELTAS[i]! },
    });
    await sleep(2);
  }

  // llm.completed — closes session
  svc.handleEvent({
    id: "evt-done",
    type: "llm.completed",
    timestamp: ts(100),
    metadata: {},
    payload: {
      model: "demo-fixture",
      providerId: "demo",
      usage: {
        model: "demo-fixture",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    },
  });

  // Allow spans.db flush
  await sleep(300);
  process.stdout.write("\n[demo complete]\n");
}

main().catch((err) => {
  console.error("[demo] error:", err);
  process.exit(1);
});