/** @jsxImportSource @opentui/solid */
/**
 * PoC（Solid 版）："Agent is thinking..." 可点击展开/折叠
 *
 * 为什么是 Solid 而不是 React（片 0 PoC 的实测结论）：
 *   - @opentui/react@0.6.6 的 peerDependencies 要求 react ">=19.2.0"，
 *     而 roy-bot 是 React 18（ink ^5.2.1 依赖它）→ 实测报错
 *     `TypeError: undefined is not an object (evaluating 'ReactSharedInternals.S')`。
 *   - 升 React 19 会让 run 链路的 ink 承担风险（违反"只动 interactive"约束）。
 *   - @opentui/solid 的 peer 只有 solid-js → **零 React 依赖**，两条链路彻底隔离。
 *     （opencode 自己也选的 Solid，等于走它验证过的组合。）
 *
 * 验证目标：
 *   1. @opentui/core 的 Zig 原生内核在本机可用（风险 R7）
 *   2. **鼠标点击**能命中 thinking 行并 toggle（迁移到 opentui 的唯一理由）
 *   3. 流式 thinking 文本在展开区增量渲染
 *   4. 键盘 fallback（t 切换 / q 退出）
 *
 * 运行（必须在真实终端，非 TTY 无法渲染）：
 *   cd .worktrees/feat-tui-opentui/scripts/poc-opentui-solid
 *   bun run poc.tsx
 */

import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal, onCleanup, onMount, Show, For } from "solid-js";

/** 模拟流式 reasoning（真实实现里来自 llm.reasoning delta 事件） */
const THINKING_CHUNKS = [
  "让我先理解需求：用户希望 thinking 块可点击展开。",
  "先看现有 TUI 怎么渲染 —— App.tsx 里 status==='thinking' 时渲染 Spinner。",
  "关键问题：Ink 没有鼠标能力，而 opentui 原生支持 onMouseUp。",
  "实测发现 @opentui/react 要 React 19，与 ink 5 的 React 18 冲突。",
  "改用 @opentui/solid（零 React 依赖）→ 两条链路彻底隔离。",
  "如果 PoC 通过，再按分片推进真正的迁移。",
];

function App() {
  const [expanded, setExpanded] = createSignal(false);
  const [thinking, setThinking] = createSignal<string[]>([]);
  const [done, setDone] = createSignal(false);
  const [frame, setFrame] = createSignal(0);
  const [log, setLog] = createSignal<string[]>([]);

  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  onMount(() => {
    // 模拟流式：即使收起也在累积（贴合真实场景）
    let i = 0;
    const t1 = setInterval(() => {
      if (i >= THINKING_CHUNKS.length) {
        setDone(true);
        clearInterval(t1);
        return;
      }
      const c = THINKING_CHUNKS[i] ?? "";
      setThinking((prev) => [...prev, c]);
      i++;
    }, 700);

    const t2 = setInterval(() => setFrame((f) => (f + 1) % spinner.length), 80);
    onCleanup(() => {
      clearInterval(t1);
      clearInterval(t2);
    });
  });

  const toggle = (via: string) => {
    // Bug fix (Task #4278 片2): log the *pre-toggle* state so the message matches
    // the action the user just took (was reversed: it read the flipped value).
    const willExpand = !expanded();
    setExpanded(willExpand);
    setLog((prev) => [...prev.slice(-3), `${via} → ${willExpand ? "展开" : "收起"}`]);
  };

  // Bug fix (Task #4278 片2): expose the toggle so the core-level keyHandler can
  // drive it. Previously `globalThis.__POC_TOGGLE__` was referenced but never
  // assigned, so pressing `t` silently did nothing while the footer advertised it.
  // Solid component bodies run once, so assigning here (not in an effect) is fine.
  (globalThis as Record<string, unknown>).__POC_TOGGLE__ = toggle;

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text content="OpenTUI/Solid PoC — thinking 块可点击" style={{ fg: "#7aa2f7" }} />
      <text content="──────────────────────────────────────────────" style={{ fg: "#3b4261" }} />

      {/* ★ 可点击行：整行是命中区域 */}
      <box onMouseUp={() => toggle("🖱 鼠标点击")} style={{ flexDirection: "row" }}>
        <text
          content={
            done()
              ? `✓ 思考完成 ${expanded() ? "▾" : "▸"}  ${expanded() ? "（再次点击收起）" : "（点击展开）"}`
              : `${spinner[frame()]} Agent is thinking... ${expanded() ? "▾" : "▸"}  ${expanded() ? "（再次点击收起）" : "（点击展开）"}`
          }
          style={{ fg: done() ? "#9ece6a" : "#e0af68" }}
        />
      </box>

      {/* 展开区：流式 thinking 正文 */}
      <Show when={expanded()}>
        <box style={{ flexDirection: "column", paddingLeft: 2 }}>
          <Show when={thinking().length > 0} fallback={<text content="（等待流式输出…）" style={{ fg: "#565f89" }} />}>
            <For each={thinking()}>{(line) => <text content={`· ${line}`} style={{ fg: "#565f89" }} />}</For>
          </Show>
        </box>
      </Show>

      <text content="──────────────────────────────────────────────" style={{ fg: "#3b4261" }} />
      <text content="[点击上面的 thinking 行] 或 按 t 切换 · 按 q 退出" style={{ fg: "#565f89" }} />
      <Show when={log().length > 0}>
        <text content={`最近操作: ${log().join(" | ")}`} style={{ fg: "#3b4261" }} />
      </Show>
    </box>
  );
}

const renderer = await createCliRenderer();

// 键盘 fallback：直接用 core renderer 的 keyHandler（先不引入 @opentui/keymap，减小 PoC 变量）
renderer.keyHandler = ((e: any) => {
  if (e?.name === "t") {
    // `__POC_TOGGLE__` is published by the App component body (see toggle()).
    (globalThis as Record<string, unknown> & { __POC_TOGGLE__?: (via: string) => void })
      .__POC_TOGGLE__?.("⌨ 按 t");
  }
  if (e?.name === "q") {
    renderer.destroy?.();
    process.exit(0);
  }
}) as any;

await render(() => <App />, renderer);
