/** @jsxImportSource @opentui/solid */
/**
 * frame-shot-p3.tsx — render the real TUI (App + scrollbox + scrollbar)
 * with opentui's test renderer and dump the frame as text + PNG.
 *
 * Task #5077 P3 Phase 2 acceptance: the scrollbar must be visible on the
 * right edge of the message area and must move with the scroll offset.
 *
 * Why testRender and not a real xterm: on this machine the opentui
 * renderer exits immediately inside xterm / pty (verified: the **main**
 * branch build shows the exact same 454-byte early exit, so it is an
 * environment issue, not a regression of this branch). testRender drives
 * the **same** opentui renderer/scrollbar code path headlessly, so the
 * scrollbar glyph and its movement are still real evidence.
 *
 * Usage: bun --conditions=browser scripts/tui-solid/frame-shot-p3.tsx
 */
import { writeFileSync } from "node:fs";
import { testRender } from "@opentui/solid";
import { ScrollBoxRenderable } from "@opentui/core";
import { App, type HistoryItem } from "../../packages/cli/src/tui-solid/App.tsx";

const COLS = 100;
const ROWS = 26;

const rows = (n: number): HistoryItem[] =>
  Array.from({ length: n }, (_, i) => ({
    role: "assistant" as const,
    text: `scroll-row-${String(i + 1).padStart(3, "0")} — content line`,
  }));

async function shot(name: string, scrollTop: number | "bottom"): Promise<string[]> {
  const t = await testRender(
    () => (
      <App history={rows(60)} status="idle" model="fake/fake-scroll" workdir="/tmp" />
    ),
    { width: COLS, height: ROWS },
  );
  await t.renderOnce();
  // find the scrollbox in the render tree (same helper the tests use)
  const findScrollbox = (node: any): ScrollBoxRenderable | undefined => {
    if (!node) return undefined;
    if (node instanceof ScrollBoxRenderable) return node;
    for (const child of typeof node.getChildren === "function" ? node.getChildren() : []) {
      const hit = findScrollbox(child);
      if (hit) return hit;
    }
    return undefined;
  };
  const scrollbox = findScrollbox((t as any).renderer?.root);
  if (!scrollbox) throw new Error("no scrollbox");

  if (scrollTop === "bottom") {
    scrollbox.scrollTop = scrollbox.scrollHeight;
  } else {
    scrollbox.scrollTop = scrollTop;
  }
  await t.renderOnce();

  const frame = t.captureCharFrame();
  const lines = frame.split("\n");
  const thumb = lines
    .map((l, i) => ({ row: i, ch: (l[COLS - 1] ?? " ") as string }))
    .filter((x) => x.ch === "▀" || x.ch === "▄");
  console.log(
    `[${name}] scrollTop=${scrollbox.scrollTop} scrollHeight=${scrollbox.scrollHeight} ` +
      `viewport=${scrollbox.viewport.height} thumbRows=[${thumb.map((x) => `${x.row}${x.ch}`).join(",")}]`,
  );
  await t.dispose();
  return lines;
}

const bottom = await shot("01-bottom", "bottom");
const mid = await shot("02-scrolled-up", 20);
const top = await shot("03-top", 0);

writeFileSync("/tmp/tui-p3-p2/frame-bottom.txt", bottom.join("\n"));
writeFileSync("/tmp/tui-p3-p2/frame-scrolled.txt", mid.join("\n"));
writeFileSync("/tmp/tui-p3-p2/frame-top.txt", top.join("\n"));
console.log("frames written to /tmp/tui-p3-p2/frame-*.txt");
