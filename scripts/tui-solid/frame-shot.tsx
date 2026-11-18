/** @jsxImportSource @opentui/solid */
/**
 * frame-shot.tsx — dump deterministic frames for the tui-solid components so a
 * PNG can be produced without a real terminal (Task #4278 片2 evidence).
 *
 * Usage: bun run scripts/tui-solid/frame-shot.tsx <outDir>
 * Writes <outDir>/<name>.txt for each frame.
 */
import { testRender } from "@opentui/solid";
import { App } from "../../packages/cli/src/tui-solid/App.tsx";
import { ToolCall } from "../../packages/cli/src/tui-solid/ToolCall.tsx";
import { StatusBar } from "../../packages/cli/src/tui-solid/StatusBar.tsx";
import { mkdir } from "node:fs/promises";

const outDir = process.argv[2] ?? "reports/4278-phase2-screenshots/frames";
await mkdir(outDir, { recursive: true });

const cases: [string, () => any, { width: number; height: number }][] = [
  [
    "01-app-transcript",
    () => (
      <App
        history={[
          { role: "user", content: "把 tui-solid 的属性对齐一下", id: "h1" },
          {
            role: "assistant",
            content: "好的，我先核对 `borderStyle` 与颜色属性：\n\n- **round** → `rounded`\n- `color` → `fg`\n\n```ts\n<box style={{ borderStyle: \"rounded\" }} />\n```",
            id: "h2",
          },
          { role: "assistant", content: "第二段：同一个回复的续块不再重复角色标题。", continuation: true, id: "h3" },
          { role: "tool", content: "📢 这是普通 tool 行（通知/斜杠回复）", id: "h4" },
          { role: "tool", content: "", tool: { name: "Bash", args: { command: "bun run test:cli:fast" }, status: "completed", output: "1779 pass\n316 skip\n13 fail", durationMs: 48213 }, id: "h5" },
          { role: "tool", content: "", tool: { name: "Read", args: { file_path: "/tmp/x" }, status: "error", error: "ENOENT: no such file", durationMs: 12 }, id: "h6" },
        ]}
        status="idle"
        model="MiniMax-M3"
        workdir="~/work/codework/personal/roy_world/roy-bot"
        tokenCount={1234}
      />
    ),
    { width: 96, height: 30 },
  ],
  [
    "02-thinking",
    () => <App history={[{ role: "user", content: "解释一下 R8", id: "h1" }]} status="thinking" model="MiniMax-M3" workdir="/tmp" />,
    { width: 96, height: 14 },
  ],
  [
    "03-streaming",
    () => (
      <App
        history={[{ role: "user", content: "写一段 markdown", id: "h1" }]}
        status="streaming"
        streamingText={"## 标题\n\n正在流式输出 **加粗** 与 `代码` …"}
        model="MiniMax-M3"
        workdir="/tmp"
      />
    ),
    { width: 96, height: 14 },
  ],
  [
    "04-toolcall-cards",
    () => (
      <box style={{ flexDirection: "column" }}>
        <ToolCall info={{ name: "Bash", args: { command: "ls -la" }, status: "running" }} />
        <ToolCall info={{ name: "Grep", args: { pattern: "solid-js" }, status: "completed", output: "a.ts:1\nb.ts:2", durationMs: 31 }} />
        <ToolCall info={{ name: "Write", args: { file_path: "/tmp/o" }, status: "error", error: "permission denied", durationMs: 5 }} />
      </box>
    ),
    { width: 72, height: 14 },
  ],
  [
    "05-statusbar",
    () => (
      <box style={{ flexDirection: "column" }}>
        <StatusBar model="MiniMax-M3" workdir="~/work/codework/personal/roy_world/roy-bot" tokenCount={1234} columns={100} />
        <StatusBar model="MiniMax-M3" workdir="~/work/codework/personal/roy_world/roy-bot" tokenCount={1234} columns={55} />
        <StatusBar model="MiniMax-M3" workdir="~/work/codework/personal/roy_world/roy-bot" tokenCount={1234} columns={38} />
      </box>
    ),
    { width: 104, height: 6 },
  ],
];

for (const [name, node, size] of cases) {
  const t = await testRender(node, size);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  await Bun.write(`${outDir}/${name}.txt`, frame);
  console.log(`${name}: ${size.width}x${size.height} → ${outDir}/${name}.txt`);
  await t.dispose();
}
