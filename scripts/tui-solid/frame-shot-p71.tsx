/** @jsxImportSource @opentui/solid */
/**
 * frame-shot-p71.tsx — Task #5116 P7.1 配置弹窗帧级截图。
 *
 * 四个状态：
 *   01-connect-list  /connect 弹窗（provider 列表 + 脱敏 key）
 *   02-connect-form  /connect 添加表单（name/apiKey/baseURL）
 *   03-model-list    /model 弹窗（模型列表 + default 徽标）
 *   04-slash-palette /c 过滤（面板含 /connect）
 *
 * 帧字符 + spans 落 /tmp/tui-p71/，供 frames-to-png-p7.py 渲染 PNG。
 *
 * ## 为什么是受控 props 快照
 *
 * bun --conditions=browser 下 testRender 保证**首帧**真实渲染
 * （Bun 急求值 JSX 约束，见 frame-shot-p7.tsx 头注释）。
 * Dialog 是受控组件（items/selectedIndex/form 全 props）⇒
 * 传入的状态即真实帧。
 *
 * 用法: bun --conditions=browser scripts/tui-solid/frame-shot-p71.tsx
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { testRender } from "@opentui/solid";
import { Dialog } from "../../packages/cli/src/tui-solid/Dialog.tsx";
import { SlashPalette } from "../../packages/cli/src/tui-solid/SlashPalette.tsx";
import { TextInput } from "../../packages/cli/src/tui-solid/TextInput.tsx";
import { interactiveSlashCommands } from "../../packages/cli/src/tui-solid/interactive-slash-commands.ts";

const COLS = 80;
const ROWS = 14;
const OUT = "/tmp/tui-p71";

const SPECS = interactiveSlashCommands({ model: "fake/p71" });

const CONNECT_ITEMS = [
  { id: "openai", label: "openai", detail: "••••cdef" },
  { id: "anthropic", label: "anthropic", detail: "••••here" },
  { id: "minimax", label: "minimax", detail: "••••YWRj" },
  { id: "deepseek", label: "deepseek", detail: "••••d700" },
  { id: "tong", label: "tong", detail: "••••eCig" },
];

const MODEL_ITEMS = [
  { id: "tong/GLM-5.3-Flash", label: "GLM-5.3-Flash", detail: "tong", badge: "provider default" },
  { id: "opencodego/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", detail: "opencodego" },
  { id: "ali/qwen3.8-max-preview", label: "qwen3.8-max-preview", detail: "ali" },
  { id: "minimax/MiniMax-M3.1-Flash", label: "MiniMax-M3.1-Flash", detail: "minimax" },
];

async function shot(name: string, makeEl: () => any) {
  const t = await testRender(makeEl, { width: COLS, height: ROWS });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  const spans = t.captureSpans();
  writeFileSync(`${OUT}/frame-${name}.txt`, frame);
  writeFileSync(`${OUT}/spans-${name}.json`, JSON.stringify(spans, null, 2));
  console.log(`[${name}] frame=${frame.split("\n").length}rows`);
  await t.dispose();
}

mkdirSync(OUT, { recursive: true });

await shot("01-connect-list", () => (
  <Dialog
    title="Connect a provider"
    visible={true}
    items={CONNECT_ITEMS}
    selectedIndex={0}
    hint="↑↓ move · Enter new/edit · a add · Esc close"
  />
));

await shot("02-connect-form", () => (
  <Dialog
    title="Add a provider"
    visible={true}
    items={[]}
    selectedIndex={0}
    hint="Enter next/submit · Esc cancel"
    form={{ mode: "form", fieldIndex: 1, fields: { name: "myprov", apiKey: "sk-live-9f8e7d6c", baseURL: "" } }}
  />
));

await shot("03-model-list", () => (
  <Dialog
    title="Select default model"
    visible={true}
    items={MODEL_ITEMS}
    selectedIndex={0}
    hint="↑↓ move · Enter set default · Esc close"
  />
));

await shot("04-slash-palette-connect", () => (
  <box style={{ flexDirection: "column", paddingLeft: 1 }}>
    <SlashPalette
      specs={SPECS}
      query="c"
      selectedIndex={0}
      visible={true}
    />
    <TextInput label="You" prefix="👤" placeholder="Type a message… ( / for commands)" />
  </box>
));

console.log("done");
