/**
 * Standalone child-process runner for Task #2309 Bug 1 E2E investigation.
 *
 * This file intentionally is not named *.test.* — invoked manually by the
 * Task #2309 R&D pipeline to reproduce the input-swallow bug after ESC.
 *
 * Scenario: render real REPLInk via ink-testing-library, simulate user
 *   typing a draft, submit, ESC during in-flight, then type new input —
 *   verify all characters are preserved.
 */

import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk } from "./repl-ink";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let rendered: ReturnType<typeof render> | undefined;
let resolveQuery: ((value: string) => void) | undefined;
let queryStarted = false;

const inkRenderer = async (props: any): Promise<void> => {
  rendered = render(React.createElement(REPLInk, props));
  await new Promise<void>(() => {});
};

const repl = new (await import("./run")).REPL(
  {
    sessionId: "task-2309-bug1-session",
    sessionTitle: "task-2309-bug1",
    model: "M3",
    version: "1.6.13",
    useInk: true,
    inkRenderer,
    onExecute: async () => {
      queryStarted = true;
      return await new Promise<string>((resolve) => {
        resolveQuery = resolve;
      });
    },
    onStatus: async () => ({
      sessionId: "task-2309-bug1-session",
      sessionTitle: "task-2309-bug1",
      messageCount: 0,
      tokenCount: 0,
    }),
    onSwitchSession: async () => ({
      sessionId: "task-2309-bug1-session",
      sessionTitle: "task-2309-bug1",
    }),
    onCompact: async () => {},
    onShutdown: async () => {},
  },
  {
    getComponent(_name: string): any {
      return undefined;
    },
  } as any,
);

const fail = (msg: string): never => {
  throw new Error(msg);
};

try {
  void repl.start();
  await wait(150);
  if (!rendered) fail("rendered is undefined");

  // Step 1: 用户输入一段 draft
  rendered.stdin.write("draft query");
  await wait(100);

  // Step 2: 提交 (触发 onExecute 永远 pending)
  rendered.stdin.write("\r");
  for (let i = 0; i < 20 && !queryStarted; i += 1) await wait(25);
  if (!queryStarted) fail("query did not start");

  // Step 3: ESC 中断
  rendered.stdin.write("\x1b");
  await wait(200);

  // Step 4: 重新输入 (验证字符全部保留)
  rendered.stdin.write("你好呀");
  await wait(150);

  // Snapshot frame
  const frame = rendered.lastFrame() ?? "";
  console.log(JSON.stringify({
    marker: "TASK2309_BUG1_FRAME",
    frameLength: frame.length,
    frameContains你好呀: frame.includes("你好呀"),
    frameContainsAll3: frame.includes("你") && frame.includes("好") && frame.includes("呀"),
    frameTail: frame.slice(-200),
  }));

  // Cleanup
  resolveQuery?.("done");
  await wait(100);
  rendered.unmount();
  process.exit(0);
} catch (error) {
  rendered?.unmount();
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
