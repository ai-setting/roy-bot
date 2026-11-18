/**
 * Standalone child-process runner for Task #2333 E2E screenshots.
 *
 * Reproduces the opencode-borrow pattern's REPL with realistic scenarios:
 * 1. Startup with welcome card
 * 2. Type / in clean state → popup shows all commands
 * 3. Fill screen with 10 messages → multiline input scenario
 * 4. Type /h after fill → popup filters to /help
 * 5. Press ↓ → popup highlight moves
 *
 * Uses ink-testing-library to capture frames.
 *
 * Author: developer <dev@example.com>
 * Date: 2026-07-23
 * Task: #2333
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
  const outDir = process.argv[2] || "/tmp/roy-bot-task-2333-screenshots";
  await fs.mkdir(outDir, { recursive: true });

  console.log("=== Task #2333 E2E screenshot run ===");
  console.log(`Output dir: ${outDir}`);

  // 用一个 mutable ref 持有 api
  const apiRef: { current: REPLInkApi | null } = { current: null };

  // 启动 REPL (不实际进入 interactive 模式, 避免依赖外部 LLM)
  const { lastFrame, stdin, unmount } = render(
    React.createElement(REPLInk, {
      initialContext: {
        model: "claude-sonnet-4",
        cwd: "~/work/codework/personal/roy_world/roy-bot",
        version: "1.6.15",
        sessionTitle: "Task #2333 opencode-borrow E2E",
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
  // Screenshot 2: Type / in clean state → popup shows all commands
  // =========================================================================
  api.setInputBuffer("/");
  await wait(150);
  const frame2 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "02-slash-empty.txt"), frame2);
  await fs.writeFile(path.join(outDir, "02-slash-empty.ansi"), lastFrame() ?? "");
  console.log(`[02-slash-empty] ${frame2.split("\n").length} lines, contains /help: ${frame2.includes("/help")}`);

  // =========================================================================
  // Screenshot 3: Fill screen with 10 messages
  // =========================================================================
  api.setInputBuffer("");
  for (let i = 1; i <= 10; i++) {
    api.appendMessage({ role: "user", content: `Test message ${i} with some longer content to fill the screen` });
    await wait(20);
    api.appendMessage({ role: "assistant", content: `Response ${i}: This is the assistant's response. It contains some longer text to make the message take up multiple lines on screen.` });
    await wait(20);
  }
  await wait(200);
  const frame3 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "03-screen-filled.txt"), frame3);
  await fs.writeFile(path.join(outDir, "03-screen-filled.ansi"), lastFrame() ?? "");
  console.log(`[03-screen-filled] ${frame3.split("\n").length} lines`);

  // =========================================================================
  // Screenshot 4: Type /h after fill → popup filters to /help
  // =========================================================================
  api.setInputBuffer("/h");
  await wait(150);
  const frame4 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "04-slash-h-after-fill.txt"), frame4);
  await fs.writeFile(path.join(outDir, "04-slash-h-after-fill.ansi"), lastFrame() ?? "");
  console.log(`[04-slash-h-after-fill] ${frame4.split("\n").length} lines, contains /help: ${frame4.includes("/help")}, contains /init: ${frame4.includes("/init")}`);

  // =========================================================================
  // Screenshot 5: Press ↓ → popup highlight moves (test internal useInput)
  // =========================================================================
  stdin.write("\u001b[B"); // ArrowDown
  await wait(150);
  const frame5 = stripAnsi(lastFrame() ?? "");
  await fs.writeFile(path.join(outDir, "05-popup-down.txt"), frame5);
  await fs.writeFile(path.join(outDir, "05-popup-down.ansi"), lastFrame() ?? "");
  console.log(`[05-popup-down] ${frame5.split("\n").length} lines, contains ▶: ${frame5.includes("▶")}`);

  unmount();
  console.log("=== Screenshots done ===");
}

main().catch((err: unknown) => {
  console.error("Error:", err);
  process.exit(1);
});
