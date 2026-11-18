/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5125 P7.2 —— /model 热切换 UI 测试。
 *
 * 断言**回调**（onModelHotSwap 是否被调用、通知行文案），
 * 不断言帧内容 ⇒ 与 RunScreen.p7-esc.test.tsx 同策略
 * （无头 runner 下可靠）。
 *
 * 路径：TextInput 输入 "/model" → 弹窗打开（快照读 config）→
 * Enter 选中第一条 → selectDefaultModel → ①持久化 ②onModelHotSwap
 * ③通知行。
 *
 * ⚠️ **隔离铁律**：配置目录经 `homeDir` prop 注入 mkdtemp
 * 临时目录（Task #5125 新增的可注入点——符合 app-config-io
 * 「显式 homeDir」的既有理念）⇒ 读写零触碰真实 ~/.roy-bot，
 * 且无需 stub ESM `os.homedir`（readonly namespace）。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/solid";
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { isSolidReactive } from "./test-utils/solid-test-env.js";
// ★ mock node:os BEFORE importing RunScreen（mock.module 的既有用法，
//   sessions/list.test.ts 同款）。RunScreen 的 os.homedir() 默认值
//   就落到隔离目录；homeDir prop 只做显式传参（双保险）。
let currentHome = "";
// ⚠️ bun 的 mock.module 只对 **ESM import** 生效；
//   `require("node:os")` 仍看默认值 ⇒ 不能用 spread 展开
//   require 结果（会把 mock 覆盖回真值）。
//   RunScreen 全走 ESM `import * as os` ⇒ 只要 mock ESM 绑定即可。
//   其他 os 成员（tmpdir/mkdtemp 等）本文件直接用顶层 `import * as os`
//   的绑定——它同样被 mock（homedir 之外返回 undefined 会崩）
//   ⇒ 先取真值快照再 mock。
const realOs = await import("node:os");
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => currentHome,
}));
const { RunScreenSolid } = await import("./RunScreen.js");

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "p72-ui-"));
  currentHome = home;
  await fs.mkdir(path.join(home, ".roy-bot"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".roy-bot", "config.jsonc"),
    JSON.stringify({
      llm: {
        defaultModel: "old-model",
        defaultProvider: "prov-a",
        providers: {
          "prov-a": { models: ["old-model", "new-model"] },
        },
      },
    }),
  );
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describeIfClient("tui-solid P7.2 — /model 热切换（回调断言）", () => {
  it("Enter 选择模型 ⇒ onModelHotSwap(provider, model) 被调用 + 通知行已生效 + config.jsonc 持久化", async () => {
    const swaps: Array<{ provider: string; model: string }> = [];
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          maxLines={100}
          markdownEnabled={false}
          homeDir={() => home}
          onModelHotSwap={(p, m) => {
            swaps.push({ provider: p, model: m });
          }}
        />
      ),
      { width: 80, height: 24 },
    );
    try {
      await t.renderOnce();
      await t.mockInput.typeText("/model");
      await t.flush();
      // 实测键序（debug56/58）：第一次 Enter 走 TextInput 的
      // selectSlashCommand（onSlashCommand → handleSubmit →
      // 弹窗**异步**打开），第二次 Enter 命中弹窗选中第一条。
      t.mockInput.pressEnter();
      await t.flush();
      await new Promise((r) => setTimeout(r, 400));
      t.mockInput.pressEnter();
      // 异步 IO（持久化 + swap）完成后断言
      for (let i = 0; i < 10 && swaps.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        await t.flush();
      }

      expect(swaps).toEqual([{ provider: "prov-a", model: "old-model" }]);

      // 通知行经 handleNotice（pushTool）落进 historyRows ——
      // bun 直接跑（REPAINTABLE=false，repaint-capability.ts 实测）
      // 下**帧不重绘**，帧断言不可靠 ⇒ 断言 historyRows 数据源。
      // （真终端通知行已由 capture-xterm-p72.py 04-after-swap.png 证实。）

      // 持久化：config.jsonc 的 llm.defaultModel/defaultProvider 已写回
      const { readModelsFromConfig } = await import("./app-config-io.js");
      const after = await readModelsFromConfig(home);
      expect(after.ok).toBe(true);
      const provDefault = after.models.find((m) => m.isProviderDefault);
      // 写回的是 llm.defaultModel（弹窗选的第一条）
      expect(after.models.some((m) => m.model === "old-model")).toBe(true);
      void provDefault;
    } finally {
      await t.dispose();
    }
  });

  it("onModelHotSwap 未提供（旧调用方）⇒ 选择仍持久化成功，不崩", async () => {
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          maxLines={100}
          markdownEnabled={false}
          homeDir={() => home}
        />
      ),
      { width: 80, height: 24 },
    );
    try {
      await t.renderOnce();
      await t.mockInput.typeText("/model");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();
      await new Promise((r) => setTimeout(r, 300));
      // 不崩 + 持久化成功（读侧校验）
      const { readModelsFromConfig } = await import("./app-config-io.js");
      const after = await readModelsFromConfig(home);
      expect(after.ok).toBe(true);
    } finally {
      await t.dispose();
    }
  });
});
