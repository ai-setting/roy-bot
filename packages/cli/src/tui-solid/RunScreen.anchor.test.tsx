/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #4721 G3 — **锚定**（流式输出时输入框恒贴底）。
 *
 * ## 根因（设计文档 /tmp/interactive-ui-4721-design.md §1.3）
 *
 * `tui-solid/RunScreen.tsx` 原来是这样写的：
 *
 * ```tsx
 * <Show when={stream.status() === "idle"}>
 *   <box style={{ marginTop: 1 }}><TextInput … /></box>
 * </Show>
 * <Show when={stream.status() !== "idle"}>
 *   <box style={{ marginTop: 1 }}><text>⠿ working… (Ctrl-C to interrupt)</text></box>
 * </Show>
 * ```
 *
 * ⇒ **流式期间 `<TextInput>` 被卸载**，输入框**整个消失**（不是漂移）。
 * 用户看到的只有 `⠿ working…` 那一行 ⇒ 「输入框无法锚定到底部」。
 *
 * ## 验收标准
 *
 * 1. **流式期间输入框仍在**（渲染帧里能看到 `👤 You:` 标签）。
 * 2. 输入框是动态区的**最后一行**（恒贴底）。
 * 3. 动态区内容变高（长 streaming 文本）时，输入框**仍然可见**。
 * 4. 空闲态与流式态，输入框的位置**一致**（不漂移）。
 *
 * ## ⚠️ 断言能力 gate（必读）
 *
 * `bun test` 用 Bun **内置**的 JSX 转换，它是**急求值**（React 风格）⇒
 * `status={stream.status()}` 是**静态快照**不是响应式 getter ⇒ **首帧之后
 * 永远不重绘**（实测 probe 8/9）。
 *
 * ⇒ 「流式态」这类**依赖重绘**的断言在 `bun test` 下**不可信** ⇒ 必须
 * 按**实测能力** gate（与既有 `Spinner.opentui.test.tsx` 的 `REPAINTABLE`
 * 探针同构）。
 *
 * 生产路径**不受影响**：`scripts/build-cli-dev.ts` 走真正的 Solid JSX 转译，
 * 实测产物含 64 处 `setProp(...)` ⇒ 出货 UI 是响应式的。
 *
 * ## 断言策略
 *
 * opentui `testRender` + `captureCharFrame()` 做**渲染断言**
 * （不看源码字符串），断言输入行在帧的最后一行。
 */

import { describe, expect, it } from "bun:test";
import { createEffect, createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import RunScreenSolid from "./RunScreen.js";
import { canRepaintWith, NO_REPAINT_REASON } from "./test-utils/repaint-capability.js";

function isSolidReactive(): boolean {
  const seen: number[] = [];
  const [n, setN] = createSignal(0);
  createEffect(() => {
    seen.push(n());
  });
  setN(1);
  return seen.length > 1;
}

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

/**
 * 实测能力探针：这个 runner 能不能在 signal 变化后重绘？
 *
 * 用**最小**的 Solid 元素（一个 `<text>`）来测 —— 不涉及 RunScreen，
 * 这样探针本身不会因为组件实现而误判。
 */
const REPAINTABLE = await canRepaintWith((value) => <text>{`Z=${value()}`}</text>);

/** 依赖重绘的断言在不能重绘的 runner 里必须跳过（并打印原因）。 */
const describeIfRepaintable = REPAINTABLE ? describeIfClient : describe.skip;

/** 输入行的判据：`👤` 前缀 + `You:` 标签。 */
const INPUT_ROW = /👤\s*You:/;

/** 从渲染帧里找出输入行所在的行号（-1 = 没找到）。 */
function findInputRow(frame: string): number {
  const lines = frame.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (INPUT_ROW.test(lines[i])) return i;
  }
  return -1;
}

/** 帧里最后一个非空行的行号。 */
function lastContentRow(frame: string): number {
  const lines = frame.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return i;
  }
  return -1;
}

/** 挂载并进入「流式中」状态（streamHandleQuery 永不 resolve）。 */
async function mountStreaming(onChunk?: (c: string) => void) {
  const t = await testRender(
    () => (
      <RunScreenSolid
        handleQuery={async () => "ok"}
        streamHandleQuery={async (_msg, chunk) => {
          onChunk?.("hello");
          await new Promise(() => {});
          return "";
        }}
        maxLines={100}
        markdownEnabled={false}
      />
    ),
    { width: 60, height: 24 },
  );

  await t.mockInput.typeText("hi");
  await t.flush();
  t.mockInput.pressEnter();
  await t.flush();

  return t;
}

describeIfRepaintable("tui-solid RunScreen — 输入框锚定（Task #4721 G3）", () => {
  it("keeps the input box visible while streaming", async () => {
    const t = await mountStreaming();
    try {
      const frame = t.captureCharFrame();
      expect(findInputRow(frame)).toBeGreaterThanOrEqual(0);
    } finally {
      await t.dispose();
    }
  });

  it("keeps the input box as the LAST row of the frame (anchored to the bottom)", async () => {
    const t = await mountStreaming();
    try {
      const frame = t.captureCharFrame();
      const inputRow = findInputRow(frame);
      expect(inputRow).toBeGreaterThanOrEqual(0);
      expect(inputRow).toBe(lastContentRow(frame));
    } finally {
      await t.dispose();
    }
  });

  it("keeps the input box visible when the streaming text is long", async () => {
    // 长 streaming 内容 ⇒ 动态区高度暴涨 ⇒ 输入框若被裁掉就消失。
    const long = Array.from({ length: 40 }, (_, i) => `STREAM_LINE_${i}`).join("\n");
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          streamHandleQuery={async (_msg, chunk) => {
            chunk(long);
            await new Promise(() => {});
            return "";
          }}
          maxLines={100}
          markdownEnabled={false}
        />
      ),
      { width: 60, height: 24 },
    );
    try {
      await t.mockInput.typeText("hi");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();

      const frame = t.captureCharFrame();
      expect(findInputRow(frame)).toBeGreaterThanOrEqual(0);
    } finally {
      await t.dispose();
    }
  });

  it("does not move the input row between idle and streaming states", async () => {
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          streamHandleQuery={async (_msg, _chunk) => {
            await new Promise(() => {});
            return "";
          }}
          maxLines={100}
          markdownEnabled={false}
        />
      ),
      { width: 60, height: 24 },
    );
    try {
      const idleRow = findInputRow(t.captureCharFrame());
      expect(idleRow).toBeGreaterThanOrEqual(0);

      await t.mockInput.typeText("hi");
      await t.flush();
      t.mockInput.pressEnter();
      await t.flush();

      const streamingRow = findInputRow(t.captureCharFrame());
      expect(streamingRow).toBeGreaterThanOrEqual(0);
      expect(streamingRow).toBe(idleRow);
    } finally {
      await t.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 不依赖重绘的断言：这些在**任何** runner 下都必须成立。
// ---------------------------------------------------------------------------
describeIfClient("tui-solid RunScreen — 输入框锚定 · 静态不变量（Task #4721 G3）", () => {
  it("renders the input box in the idle state", async () => {
    const t = await testRender(
      () => (
        <RunScreenSolid
          handleQuery={async () => "ok"}
          maxLines={100}
          markdownEnabled={false}
        />
      ),
      { width: 60, height: 24 },
    );
    try {
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(findInputRow(frame)).toBeGreaterThanOrEqual(0);
      // 空闲态：输入行是**最后一行非空行**（贴底）。
      expect(findInputRow(frame)).toBe(lastContentRow(frame));
    } finally {
      await t.dispose();
    }
  });

  it("reports WHY the re-render-dependent assertions are skipped (no silent skip)", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[Task #4721 G3] solid-reactive=${SOLID_REACTIVE} repaintable=${REPAINTABLE} ` +
        `=> re-render-dependent assertions ${REPAINTABLE ? "RUN" : "SKIPPED"}`,
    );
    if (!REPAINTABLE) {
      // eslint-disable-next-line no-console
      console.log(`[Task #4721 G3] skip reason: ${NO_REPAINT_REASON}`);
    }
    expect(typeof REPAINTABLE).toBe("boolean");
  });
});

if (!SOLID_REACTIVE) {
  describe("tui-solid RunScreen — 输入框锚定（Task #4721 G3）[SKIPPED]", () => {
    it("explains why the assertions were skipped", () => {
      expect(SOLID_REACTIVE).toBe(false);
    });
  });
}
