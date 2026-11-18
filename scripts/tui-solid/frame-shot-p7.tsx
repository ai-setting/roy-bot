/** @jsxImportSource @opentui/solid */
/**
 * frame-shot-p7.tsx — Task #5109 P7 斜杠命令帧级截图。
 *
 * 渲染 SlashPalette + TextInput 组合（RunScreen 底部区），
 * 三个状态：idle → "/" 面板展开（高亮 /help）→ 过滤 "he"。
 * 帧字符 + spans 落 /tmp/tui-p7/，供 frames-to-png-p7.py 渲染 PNG。
 *
 * ## 为什么不用 RunScreen + typeText
 *
 * `bun --conditions=browser` 跑脚本时与 `bun test` 同源：Bun 内置
 * JSX 是**急求值**快照 —— `typeText` 能触发回调、能改 signal，
 * 但**帧不会重绘**（RunScreen.anchor / App.p7-slash 测试里
 * REPAINTABLE=false 的同一实测约束）。⇒ RunScreen 级交互帧在
 * 无头测试渲染器里拿不到。
 *
 * ⇒ 与 P5 同思路：**测试渲染器仍能首帧渲染出真组件树**。
 * SlashPalette 是**受控组件**（query / selectedIndex / visible
 * 全是 props），初始 props 即状态 ⇒ 面板内容、高亮、过滤全部
 * 真实渲染。TextInput 只渲染首帧输入框（占位符）。
 *
 * 用法: bun --conditions=browser scripts/tui-solid/frame-shot-p7.tsx
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { testRender } from "@opentui/solid";
import { SlashPalette } from "../../packages/cli/src/tui-solid/SlashPalette.tsx";
import { TextInput } from "../../packages/cli/src/tui-solid/TextInput.tsx";
import { interactiveSlashCommands } from "../../packages/cli/src/tui-solid/interactive-slash-commands.ts";

const COLS = 90;
const ROWS = 16;
const OUT = "/tmp/tui-p7";

const SPECS = interactiveSlashCommands({ model: "fake/p7" });

async function shot(
  name: string,
  palette: { query: string; selectedIndex: number; visible: boolean },
) {
  const t = await testRender(
    () => (
      <box style={{ flexDirection: "column", paddingLeft: 1 }}>
        <SlashPalette
          specs={SPECS}
          query={palette.query}
          selectedIndex={palette.selectedIndex}
          visible={palette.visible}
        />
        <TextInput label="You" prefix="👤" placeholder="Type a message… ( / for commands)" />
      </box>
    ),
    { width: COLS, height: ROWS },
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  const spans = t.captureSpans();
  writeFileSync(`${OUT}/frame-${name}.txt`, frame);
  writeFileSync(`${OUT}/spans-${name}.json`, JSON.stringify(spans, null, 2));
  const visible = frame.includes("/help");
  console.log(`[${name}] frame=${frame.split("\n").length}rows palette-visible=${visible}`);
  await t.dispose();
}

mkdirSync(OUT, { recursive: true });
await shot("01-idle", { query: "", selectedIndex: 0, visible: false });
await shot("02-slash-trigger", { query: "", selectedIndex: 0, visible: true });
await shot("03-filter-he", { query: "he", selectedIndex: 0, visible: true });
console.log("done");
