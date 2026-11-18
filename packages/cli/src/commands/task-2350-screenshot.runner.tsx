/**
 * Standalone child-process runner for Task #2350 E2E screenshots.
 *
 * Reproduces the input re-render bug scenario:
 * 1. Startup (welcome card) — baseline
 * 2. Fill screen with 20 messages — screen-filled state
 * 3. Type normal char "a" after fill — verify no popup + buffer state
 * 4. Type / after fill — verify popup still appears (popup behavior preserved)
 * 5. Type /he after fill — verify popup filters to /help
 *
 * Uses ink-testing-library to capture frames.
 *
 * Author: developer <dev@example.com>
 * Date: 2026-07-23
 * Task: #2350
 */

import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk, type REPLInkApi } from "./repl-ink";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function main(): Promise<void> {
  const outDir = process.argv[2] || "/tmp/roy-bot-task-2350-screenshots";
  await fs.mkdir(outDir, { recursive: true });

  console.log("=== Task #2350 E2E screenshot run ===");
  console.log(`Output dir: ${outDir}`);

  // 用一个 mutable ref 持有 api
  const apiRef: { current: REPLInkApi | null } = { current: null };

  // 启动 REPL (不实际进入 interactive 模式, 避免依赖外部 LLM)
  const { lastFrame, stdin, unmount } = render(
    React.createElement(REPLInk, {
      initialContext: {
        model: "claude-sonnet-4",
        cwd: "~/work/codework/personal/roy_world/roy-bot",
        version: "1.6.16",
        sessionTitle: "Task #2350 input-rescroll E2E",
      },
      onSubmit: async (input: string) => {
        // Mock submit: append user message
        apiRef.current?.appendMessage({ role: "user", content: input });
        await wait(50);
        // Mock assistant response
        apiRef.current?.appendMessage({ role: "assistant", content: `Response to: ${input}` });
      },
      onReady: (a: REPLInkApi) => {
        apiRef.current = a;
      },
      onCommand: async (cmd: string) => {
        apiRef.current?.appendMessage({ role: "system", content: `Command: ${cmd}` });
        return true;
      },
    }),
  );

  // Wait for mount
  await wait(300);

  if (!apiRef.current) {
    console.error("REPL API not ready");
    process.exit(1);
  }
  const api = apiRef.current;

  // =========================================================================
  // Screenshot 1: Startup (welcome card)
  // =========================================================================
  const frame1 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "01-startup.txt"), frame1);
  await fs.writeFile(path.join(outDir, "01-startup.ansi"), lastFrame() ?? "");
  console.log(`[01-startup] ${frame1.split("\n").length} lines`);

  // =========================================================================
  // Screenshot 2: Fill screen with 20 messages (10 user + 10 assistant)
  // =========================================================================
  api.setInputBuffer("");
  for (let i = 1; i <= 10; i++) {
    api.appendMessage({ role: "user", content: `Test message ${i} with some longer content to fill the screen` });
    await wait(20);
    api.appendMessage({ role: "assistant", content: `Response ${i}: This is the assistant's response. It contains some longer text to make the message take up multiple lines on screen.` });
    await wait(20);
  }
  await wait(200);
  const frame2 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "02-screen-filled.txt"), frame2);
  await fs.writeFile(path.join(outDir, "02-screen-filled.ansi"), lastFrame() ?? "");
  console.log(`[02-screen-filled] ${frame2.split("\n").length} lines`);

  // =========================================================================
  // Screenshot 3: Type normal char "abc" after fill — NO popup, NO parent re-render
  // =========================================================================
  stdin.write("abc");
  await wait(200);
  const frame3 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "03-normal-char-after-fill.txt"), frame3);
  await fs.writeFile(path.join(outDir, "03-normal-char-after-fill.ansi"), lastFrame() ?? "");
  console.log(`[03-normal-char-after-fill] ${frame3.split("\n").length} lines, contains "abc" in input: ${frame3.includes("abc")}, no popup: ${!frame3.includes("Commands")}`);

  // =========================================================================
  // Screenshot 4: Clear, then type / → popup appears (popup behavior preserved)
  // =========================================================================
  // 3 separate backspaces (with waits) to ensure each is processed
  for (let i = 0; i < 3; i++) {
    stdin.write("\x7f");
    await wait(80);
  }
  await wait(100);
  stdin.write("/");
  await wait(200);
  const frame4 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "04-slash-popup-after-fill.txt"), frame4);
  await fs.writeFile(path.join(outDir, "04-slash-popup-after-fill.ansi"), lastFrame() ?? "");
  console.log(`[04-slash-popup-after-fill] ${frame4.split("\n").length} lines, contains /help: ${frame4.includes("/help")}, contains Commands: ${frame4.includes("Commands")}`);

  // =========================================================================
  // Screenshot 5: Type /he after fill → popup filters to /help only
  // =========================================================================
  stdin.write("he");
  await wait(200);
  const frame5 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "05-slash-he-filtered.txt"), frame5);
  await fs.writeFile(path.join(outDir, "05-slash-he-filtered.ansi"), lastFrame() ?? "");
  console.log(`[05-slash-he-filtered] ${frame5.split("\n").length} lines, contains /help: ${frame5.includes("/help")}, contains /init: ${frame5.includes("/init")}, contains /model: ${frame5.includes("/model")}`);

  unmount();
  console.log("=== Screenshots done ===");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
