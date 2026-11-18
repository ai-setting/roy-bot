/**
 * Standalone child-process runner for the Task #2297 real Ink E2E test.
 *
 * This file intentionally is not named *.test.*. The parent Bun test starts
 * it in a fresh process so legacy tests that globally mock core's
 * cascadeStopSessionTree cannot race with this real-path verification.
 */

import * as React from "react";
import { render } from "ink-testing-library";
import { REPLInk } from "./repl-ink";
import { REPL } from "./run";
import { resetStreamAbort, streamAbortSignal } from "../services/stream-output.service";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let rendered: { stdin: { write: (input: string) => void }; unmount: () => void } | undefined;
let resolveQuery: ((value: string) => void) | undefined;
let queryStarted = false;
let abortCount = 0;
const stoppedTaskParents: string[] = [];
const stoppedWorkflowParents: string[] = [];

const inkRenderer = async (props: any): Promise<void> => {
  rendered = render(
    React.createElement(REPLInk, props),
  ) as unknown as { stdin: { write: (input: string) => void }; unmount: () => void };
  await new Promise<void>(() => {});
};

const env = {
  getComponent(name: string): any {
    if (name === "agent") {
      return { abortAll: () => { abortCount += 1; } };
    }
    if (name === "task") {
      return {
        getBackgroundTaskManager: () => ({
          stopAllForParent: async (id: string) => {
            stoppedTaskParents.push(id);
            return { stoppedTaskIds: [`task:${id}`] };
          },
        }),
      };
    }
    if (name === "workflow") {
      return {
        workflowService: {
          stopAllForParent: async (id: string) => {
            stoppedWorkflowParents.push(id);
            return { stoppedSessionIds: [`workflow:${id}`] };
          },
        },
      };
    }
    return undefined;
  },
};

const repl = new REPL(
  {
    sessionId: "task-2297-child-session",
    sessionTitle: "task-2297-child",
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
      sessionId: "task-2297-child-session",
      sessionTitle: "task-2297-child",
      messageCount: 0,
      tokenCount: 0,
    }),
    onSwitchSession: async () => ({
      sessionId: "task-2297-child-session",
      sessionTitle: "task-2297-child",
    }),
    onCompact: async () => {},
    onShutdown: async () => {},
  },
  env as any,
);

const fail = (message: string): never => {
  throw new Error(message);
};

try {
  resetStreamAbort();
  void repl.start();
  await wait(150);
  if (!rendered) fail("startInk did not render REPLInk through ink-testing-library");

  // Real user input: TextInput receives bytes, then Enter invokes onSubmit.
  rendered.stdin.write("long running query");
  await wait(100);
  rendered.stdin.write("\r");
  for (let i = 0; i < 20 && !queryStarted; i += 1) await wait(25);
  if (!queryStarted) fail("real Ink TextInput did not submit the query");
  if ((repl as any).isExecuting !== true) {
    fail(`isExecuting before ESC was ${(repl as any).isExecuting}, expected true`);
  }

  // Real ESC byte reaches REPLInk.useInput -> interactive.handleEscKey.
  rendered.stdin.write("\x1b");
  await wait(200);

  if (abortCount !== 1) fail(`abortAll count=${abortCount}, expected 1`);
  if (!stoppedTaskParents.includes("task-2297-child-session")) {
    fail(`task cascade parents=${JSON.stringify(stoppedTaskParents)}`);
  }
  if (!stoppedWorkflowParents.includes("task-2297-child-session")) {
    fail(`workflow cascade parents=${JSON.stringify(stoppedWorkflowParents)}`);
  }
  if (!streamAbortSignal.aborted) fail("abortStream signal was not set");
  if ((repl as any).isExecuting !== false) {
    fail(`isExecuting after ESC was ${(repl as any).isExecuting}, expected false`);
  }

  resolveQuery?.("done");
  await wait(150);
  if ((repl as any).isExecuting !== false) {
    fail(`isExecuting after query settle was ${(repl as any).isExecuting}, expected false`);
  }

  rendered.unmount();
  console.log(JSON.stringify({
    marker: "TASK2297_REAL_INK_E2E_PASS",
    abortCount,
    stoppedTaskParents,
    stoppedWorkflowParents,
    streamAborted: streamAbortSignal.aborted,
    isExecuting: (repl as any).isExecuting,
  }));
  process.exit(0);
} catch (error) {
  rendered?.unmount();
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
