/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview ToolCall card tests — **opentui/solid** edition (Task #4679 片5).
 *
 * 1:1 port of the 6 Ink assertions in `tui/ToolCall.test.tsx`. The Ink file is
 * **untouched** — it still guards the live Ink chain (`repl-ink.tsx`).
 *
 * Recipe (docs/tui-opentui-migration-plan.md §7.1):
 *   `render(<C/>)` → `await testRender(() => <C/>, {width,height})`
 *   `lastFrame()`  → `await t.renderOnce(); t.captureCharFrame()`
 *   `unmount()`    → `await t.dispose()`
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { ToolCall } from "./ToolCall.js";
import type { ToolCallInfo } from "../tui/tool-call.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

/**
 * `ToolCall` uses `<Show>`; under the SSR build of solid-js opentui's
 * reconciler rejects the fallback branch (`Orphan text error`). Gate on the
 * **measured** client-runtime probe so the skip is visible, never silent.
 */
const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/** Render a `ToolCall` card headlessly and return its captured frame. */
async function frameOf(info: ToolCallInfo, showOutput?: boolean): Promise<string> {
  const t = await testRender(
    () => <ToolCall info={info} showOutput={showOutput} />,
    { width: 60, height: 8 },
  );
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

describeIfClient("ToolCall card (opentui/solid)", () => {
  it("renders the humanised tool name and primary arg", async () => {
    const f = await frameOf({
      name: "bash",
      args: { command: "ls -la" },
      status: "completed",
      output: "file1.txt",
    });
    expect(f).toContain("Bash");
    expect(f).toContain("ls -la");
  });

  it("shows a ✓ and duration for a completed call", async () => {
    const f = await frameOf({
      name: "read_file",
      args: { file_path: "/a.ts" },
      status: "completed",
      output: "contents",
      durationMs: 320,
    });
    expect(f).toContain("✓");
    expect(f).toContain("320ms");
    expect(f).toContain("contents");
  });

  it("shows a ✗ and the error text for a failed call", async () => {
    const f = await frameOf({
      name: "bash",
      args: { command: "boom" },
      status: "error",
      error: "command not found",
    });
    expect(f).toContain("✗");
    expect(f).toContain("command not found");
  });

  it("shows a running indicator (and no ✓) while executing", async () => {
    const f = await frameOf({
      name: "glob",
      args: { pattern: "**/*.ts" },
      status: "running",
    });
    expect(f).toContain("Glob");
    expect(f).toContain("**/*.ts");
    expect(f).toContain("running");
    expect(f).not.toContain("✓");
  });

  it("hides the output preview when showOutput=false", async () => {
    const f = await frameOf(
      {
        name: "bash",
        args: { command: "ls" },
        status: "completed",
        output: "SECRET_OUTPUT",
      },
      false,
    );
    expect(f).toContain("Bash");
    expect(f).not.toContain("SECRET_OUTPUT");
  });

  it("renders an icon for known tools", async () => {
    const f = await frameOf({
      name: "read_file",
      args: { file_path: "a" },
      status: "completed",
    });
    expect(f).toContain("📖");
  });
});

describe("ToolCall card (opentui/solid) — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[片5] solid-reactive=${SOLID_REACTIVE} ` +
        `=> ToolCall suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
