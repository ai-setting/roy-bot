/** @jsxImportSource @opentui/react */
/**
 * PoC: "Agent is thinking..." 可点击展开/折叠（OPENTUI 版）
 *
 * 目的（片 0 PoC，不改主代码）：
 *   1. 验证 @opentui/react 在本机可用（含 Zig 原生内核能否加载 → 风险 R7）
 *   2. 验证 **鼠标点击** 能命中并 toggle（这是迁移到 opentui 的**唯一理由**）
 *   3. 验证 **流式 thinking 文本**在展开区域里增量渲染
 *   4. 验证键盘 fallback（t 键 toggle、q 退出）
 *
 * 运行（在真实终端里跑，非 TTY 环境无法渲染）：
 *   cd .worktrees/feat-tui-opentui
 *   bun run scripts/poc-opentui-thinking.tsx
 *
 * 预期：看到一行 "⏳ Agent is thinking... [点击展开]"；
 *   - 点它 → 展开显示流式思考文本；再点 → 收起
 *   - 按 t 同样 toggle；按 q 退出
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";

/** 模拟流式 reasoning（真实实现里来自 llm.reasoning delta 事件） */
const THINKING_CHUNKS = [
  "让我先理解需求：用户希望 thinking 块可点击展开。",
  "先看现有 TUI 怎么渲染 —— App.tsx 里 status==='thinking' 时渲染 Spinner。",
  "关键问题：Ink 没有鼠标能力，而 opentui 原生支持 onMouseUp。",
  "决定：PoC 先验证鼠标点击能否命中 + toggle 是否稳定。",
  "另外要确认 Zig 原生内核在本机可加载，否则整个迁移不成立。",
  "如果 PoC 通过，再按 7 个分片推进真正的迁移。",
];

function App() {
  const [expanded, setExpanded] = useState(false);
  const [thinking, setThinking] = useState("");
  const [done, setDone] = useState(false);

  // 模拟流式输出：即使收起，文本也在累积（贴合真实场景）
  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      if (i >= THINKING_CHUNKS.length) {
        setDone(true);
        clearInterval(timer);
        return;
      }
      const chunk = THINKING_CHUNKS[i] ?? "";
      setThinking((prev) => prev + chunk + "\n");
      i++;
    }, 700);
    return () => clearInterval(timer);
  }, []);

  const toggle = () => setExpanded((v) => !v);

  // 键盘 fallback（真实迁移后仍需保留，键盘用户不依赖鼠标）
  useKeyboard((e) => {
    if (e.name === "t") toggle();
    if (e.name === "q") process.exit(0);
  });

  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % spinner.length), 80);
    return () => clearInterval(t);
  }, []);

  const arrow = expanded ? "▾" : "▸";
  const hint = expanded ? "（再次点击收起）" : "（点击展开）";

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text content="OpenTUI/React PoC — thinking 块可点击" style={{ fg: "#7aa2f7" }} />
      <text content="──────────────────────────────────────────" style={{ fg: "#3b4261" }} />

      {/* ★ 可点击的 thinking 头行：整行是命中区域 */}
      <box onMouseUp={toggle} style={{ flexDirection: "row" }}>
        <text
          content={
            done
              ? `✓ 思考完成 ${arrow} ${hint}`
              : `${spinner[frame]} Agent is thinking... ${arrow} ${hint}`
          }
          style={{ fg: done ? "#9ece6a" : "#e0af68" }}
        />
      </box>

      {/* 展开区域：流式 thinking 正文 */}
      {expanded ? (
        <box style={{ flexDirection: "column", paddingLeft: 2 }}>
          <text content={thinking || "（暂无内容，等待流式输出…）"} style={{ fg: "#565f89" }} />
        </box>
      ) : null}

      <text content="──────────────────────────────────────────" style={{ fg: "#3b4261" }} />
      <text content="[点击上方 thinking 行] 或 按 t 切换 · 按 q 退出" style={{ fg: "#565f89" }} />
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
