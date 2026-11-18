/** @jsxImportSource @opentui/solid */
/**
 * frame-truth.tsx — deterministic headless frame assertions for tui-solid/.
 *
 * Task #4278 片2. Uses `@opentui/solid` `testRender` so component layout can be
 * asserted without a real pty (deterministic, CI-friendly). The real-pty
 * screenshot harness (`capture-interactive-solid.py`) remains the end-to-end
 * evidence; this one pins *per-component* structure.
 *
 * Run:  bun run scripts/tui-solid/frame-truth.tsx
 * Exit: 0 = all assertions pass.
 */
import { testRender } from "@opentui/solid";
import { App } from "../../packages/cli/src/tui-solid/App.tsx";
import { ToolCall } from "../../packages/cli/src/tui-solid/ToolCall.tsx";
import { StatusBar } from "../../packages/cli/src/tui-solid/StatusBar.tsx";
import { Markdown } from "../../packages/cli/src/tui-solid/Markdown.tsx";
import { Spinner } from "../../packages/cli/src/tui-solid/Spinner.tsx";
import { ThinkingBlock } from "../../packages/cli/src/tui-solid/App.tsx";
import { createMockMouse, MouseButtons } from "@opentui/core/testing";

type Check = { name: string; ok: boolean; detail?: string };
const results: Check[] = [];

async function frame(node: () => any, opts: { width: number; height: number }) {
  const t = await testRender(node, opts);
  await t.renderOnce();
  const f = t.captureCharFrame();
  await t.dispose();
  return f;
}

function rows(f: string): string[] {
  return f.split("\n").map((l) => l.replace(/\s+$/, ""));
}

function assert(name: string, cond: boolean, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? "✅" : "❌"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  console.log("=== 片2 帧断言（@opentui/solid testRender）===");

  // --- 1. App must render non-empty history without throwing (片1 regression guard)
  console.log("\n[1] App + non-empty history (片1 regression guard)");
  {
    let f = "";
    let err: unknown = null;
    try {
      f = await frame(
        () => (
          <App
            history={[
              { role: "user", content: "hello there", id: "h1" },
              { role: "assistant", content: "hi **bold** text", id: "h2" },
              { role: "assistant", content: "continued block", continuation: true, id: "h3" },
              { role: "tool", content: "note row", id: "h4" },
              {
                role: "tool",
                content: "",
                tool: { name: "Bash", args: { command: "ls -la" }, status: "completed", output: "file1\nfile2", durationMs: 312 },
                id: "h5",
              },
            ]}
            status="idle"
            model="MiniMax-M3"
            workdir="/tmp"
          />
        ),
        { width: 72, height: 26 },
      );
    } catch (e) {
      err = e;
    }
    const body = rows(f).join("\n");
    assert("no throw with 5 history rows", err === null, err ? String((err as Error).message) : "");
    assert("user row rendered", body.includes("hello there"));
    assert("assistant row rendered", body.includes("bold"));
    assert("continuation row rendered", body.includes("continued block"));
    assert("plain tool row rendered", body.includes("note row"));
    assert("structured ToolCall card rendered", body.includes("Bash") && body.includes("file1"));
    assert("role heading present", body.includes("You") && body.includes("Agent"));
    assert("no raw SGR escapes leaked", !/\u001b\[[0-9;]*m/.test(f) && !/\[1m|\[22m|\[0m/.test(body), "markdown ANSI must be converted, not literal");
  }

  // --- 2. ToolCall card structure
  console.log("\n[2] ToolCall card");
  {
    const f = await frame(
      () => <ToolCall info={{ name: "Bash", args: { command: "ls -la" }, status: "completed", output: "file1\nfile2", durationMs: 312 }} />,
      { width: 60, height: 8 },
    );
    const body = rows(f).join("\n");
    assert("icon + name + duration", body.includes("Bash") && body.includes("312ms"));
    assert("first output line prefixed └", body.includes("└ file1"));
    assert("continuation output line indented", /^\s+file2/m.test(f));
  }
  {
    const f = await frame(
      () => <ToolCall info={{ name: "Read", args: { file_path: "/tmp/x" }, status: "error", error: "boom", durationMs: 12 }} />,
      { width: 60, height: 6 },
    );
    const body = rows(f).join("\n");
    assert("error badge ✗ + message", body.includes("✗") && body.includes("boom"));
  }

  // --- 3. StatusBar segment planner
  console.log("\n[3] StatusBar");
  {
    const f = await frame(() => <StatusBar model="MiniMax-M3" workdir="/tmp" tokenCount={42} />, { width: 90, height: 2 });
    const body = rows(f)[0] ?? "";
    assert("model + workdir + tokens", body.includes("MiniMax-M3") && body.includes("/tmp") && body.includes("n=42"));
    assert("mid-dot separators", (body.match(/·/g) ?? []).length >= 2);
  }

  // --- 4. Markdown ANSI → styled spans
  console.log("\n[4] Markdown");
  {
    const f = await frame(() => <Markdown text={"# Title\n\nSome **bold** and `code` text.\n\n- a\n- b"} />, { width: 60, height: 12 });
    const body = rows(f).join("\n");
    assert("heading text present", body.includes("Title"));
    assert("bold text present", body.includes("bold"));
    assert("list items present", body.includes("a") && body.includes("b"));
    assert("no literal SGR remnants", !/\[1m|\[22m|\[0m|\[33m|\[2m/.test(body));
  }

  // --- 5. Spinner + empty-markdown guard
  console.log("\n[5] Spinner / empty content");
  {
    const f = await frame(() => <Spinner label="Agent is thinking..." />, { width: 40, height: 2 });
    assert("spinner label renders", rows(f)[0]!.includes("Agent is thinking..."));
  }
  {
    const f = await frame(() => <Markdown text="" />, { width: 20, height: 2 });
    assert("empty markdown renders blank (no throw)", rows(f).join("").trim() === "");
  }

  // --- 6. 片6: clickable thinking block (mouse toggle, both directions)
  console.log("\n[6] ThinkingBlock (片6 clickable)");
  {
    // 6a. collapse hint + no reasoning body
    const t = await testRender(
      () => <ThinkingBlock text="FIRST reasoning line" />,
      { width: 72, height: 8 },
    );
    await t.renderOnce();
    const f0 = rows(t.captureCharFrame()).join("\n");
    assert("collapsed: spinner + expand hint", f0.includes("Agent is thinking...") && f0.includes("click to expand"));
    assert("collapsed: reasoning body hidden", !f0.includes("FIRST reasoning line"));

    // 6b. inject a REAL left-click on the row → expand
    const mouse = createMockMouse(t.renderer);
    await mouse.click(6, 0, MouseButtons.LEFT);
    await t.renderOnce();
    const f1 = rows(t.captureCharFrame()).join("\n");
    assert("click → expanded (collapse hint shown)", f1.includes("click to collapse"));
    assert("click → reasoning text visible", f1.includes("FIRST reasoning line"));

    // 6c. click again → collapse (toggle must be bidirectional)
    await mouse.click(6, 0, MouseButtons.LEFT);
    await t.renderOnce();
    const f2 = rows(t.captureCharFrame()).join("\n");
    assert("re-click → collapsed again (hint back)", f2.includes("click to expand") && !f2.includes("click to collapse"));
    assert("re-click → reasoning hidden", !f2.includes("FIRST reasoning line"));

    // 6d. keyboard fallback (`t`)
    await t.mockInput.pressKey("t");
    await t.renderOnce();
    const f3 = rows(t.captureCharFrame()).join("\n");
    assert("keyboard `t` → expanded (fallback)", f3.includes("click to collapse") && f3.includes("FIRST reasoning line"));

    await t.dispose();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    console.log("失败项:");
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    return 1;
  }
  console.log("结论: ✅ 片2 帧断言全通过");
  return 0;
}

process.exit(await main());
