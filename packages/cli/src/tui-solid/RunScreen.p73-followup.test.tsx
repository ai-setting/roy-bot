/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5129 P7.3 —— RunScreen follow-up 三条测试。
 *
 * F2：含 `/` 的模型名（OpenRouter 风格 provider/org/model）
 * 走完 /model 选择后，onModelHotSwap 收到的 model 必须是
 * **完整模型名**（不能被 split 截断）。
 * F3：/model 热切换后，状态栏（StatusBar 的 model prop 来源）
 * 必须跟随新 model（不再显示启动时的旧 model）。
 *
 * 键序沿用 RunScreen.p72-hotmodel.test.tsx 实测结论：
 * 第一次 Enter = TextInput selectSlashCommand（弹窗异步打开），
 * 第二次 Enter = 弹窗选中第一条。
 *
 * ⚠️ 隔离铁律：homeDir prop 注入 mkdtemp 临时目录。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { testRender } from "@opentui/solid";
import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { isSolidReactive } from "./test-utils/solid-test-env.js";
import { canRepaintWith, NO_REPAINT_REASON } from "./test-utils/repaint-capability.js";
let currentHome = "";
const realOs = await import("node:os");
mock.module("node:os", () => ({
  ...realOs,
  homedir: () => currentHome,
}));
const { RunScreenSolid } = await import("./RunScreen.js");

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;
// F3 断言「signal 变化 → 状态栏重绘」⇒ 必须按实测能力 gate
//（bun test 内置 JSX 转换是急求值 ⇒ 帧不更新，REPAINTABLE=false；
// 行为由真终端 e2e 截图兜底——与 App.p7-slash.test.tsx 同策略）。
const REPAINTABLE = await canRepaintWith(
  (value) => <box><text>{`Z=${value()}`}</text></box>,
);
const describeIfRepaintable = REPAINTABLE ? describeIfClient : describe.skip;

let home = "";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "p73-ui-"));
  currentHome = home;
  await fs.mkdir(path.join(home, ".roy-bot"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const writeConfig = async (models: string[], defaultModel?: string) => {
  await fs.writeFile(
    path.join(home, ".roy-bot", "config.jsonc"),
    JSON.stringify({
      llm: {
        ...(defaultModel ? { defaultModel, defaultProvider: "openrouter" } : {}),
        providers: { openrouter: { models } },
      },
    }),
  );
};

/**
 * 驱动：/model → Enter（打开）→ Enter（选第 1 条）→ 等 swap。
 *
 * 实测（probe12）：弹窗渲染在 captureCharFrame 里不可见
 * （App root-level 兄弟节点 + 帧缓存），但键盘路径与
 * p72-hotmodel 测试完全一致——两次 Enter 间必须留间隔
 * （第 1 次 Enter 异步打开弹窗），否则第 2 次 Enter 空过。
 */
async function selectFirstModel(
  t: Awaited<ReturnType<typeof testRender>>,
  onSwapped: () => boolean,
) {
  await t.renderOnce();
  await t.mockInput.typeText("/model");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();
  await new Promise((r) => setTimeout(r, 400));
  t.mockInput.pressEnter();
  for (let i = 0; i < 20 && !onSwapped(); i++) {
    await new Promise((r) => setTimeout(r, 100));
    await t.flush();
  }
}

/** 驱动：/model → Enter（打开）→ ↓ → Enter（选第 2 条）。 */
async function selectSecondModel(
  t: Awaited<ReturnType<typeof testRender>>,
  onSwapped: () => boolean,
) {
  await t.mockInput.typeText("/model");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();
  await new Promise((r) => setTimeout(r, 400));
  t.mockInput.pressArrow("down");
  await t.flush();
  t.mockInput.pressEnter();
  for (let i = 0; i < 20 && !onSwapped(); i++) {
    await new Promise((r) => setTimeout(r, 100));
    await t.flush();
  }
}

describeIfClient("tui-solid P7.3 F2 — slash model id 解析", () => {
  it("model name containing '/' survives the whole selection path", async () => {
    await writeConfig(["meta-llama/llama-3.1-70b-instruct"]);
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
      await selectFirstModel(t, () => swaps.length > 0);
      expect(swaps).toEqual([
        { provider: "openrouter", model: "meta-llama/llama-3.1-70b-instruct" },
      ]);
      // 持久化侧同步校验：config.jsonc 顶层 llm.defaultModel
      // 已写为完整模型名（isProviderDefault 是 provider 级
      // defaultModel 标记，与写回键不同，不可用作断言）。
      const text = await fs.readFile(
        path.join(home, ".roy-bot", "config.jsonc"),
        "utf-8",
      );
      const parsed = JSON.parse(text);
      // ★ P7.3 F2：持久化为完整 id（首个 / 恒为 provider 段）
      expect(parsed.llm.defaultModel).toBe(
        "openrouter/meta-llama/llama-3.1-70b-instruct",
      );
      expect(parsed.llm.defaultProvider).toBe("openrouter");
    } finally {
      await t.dispose();
    }
  });
});

describeIfRepaintable("tui-solid P7.3 F3 — 状态栏 model 跟随热切换", () => {
  it("after hot swap the footer shows the NEW model", async () => {
    await writeConfig(["old-model", "hot/new-model"], "old-model");
    const swaps: Array<{ provider: string; model: string }> = [];
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          maxLines={100}
          markdownEnabled={false}
          homeDir={() => home}
          model="old-model"
          onModelHotSwap={(p, m) => {
            swaps.push({ provider: p, model: m });
          }}
        />
      ),
      { width: 120, height: 24 },
    );
    try {
      // 选第 2 条（hot/new-model）——第 1 条 old-model 与
      // 启动 model 相同，无法区分「跟随」与「本来就显示」。
      await selectSecondModel(t, () => swaps.length > 0);
      expect(swaps).toEqual([{ provider: "openrouter", model: "hot/new-model" }]);
      // REPAINTABLE 口径下帧会跟随 signal 更新 ⇒
      // 状态栏（Build 行）必须显示新模型。
      await t.flush({ maxPasses: 10 });
      const f = t.captureCharFrame();
      const statusLine = f.split("\n").find((l) => l.includes("Build"));
      expect(statusLine).toContain("hot/new-model");
      expect(statusLine).not.toContain("old-model");
    } finally {
      await t.dispose();
    }
  });
});
