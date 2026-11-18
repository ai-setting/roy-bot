/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5116 P7.1 —— Dialog 组件帧级测试（TDD RED 先行）。
 *
 * 与 SlashPalette.test.tsx 同款思路：testRender 首帧断言
 * （bun 急求值 JSX 下 testRender 保证首帧真实渲染）。
 */

import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { Dialog } from "./Dialog.js";
import type { DialogListItem } from "./dialog-state.js";
import {
  isSolidReactive,
  SSR_SKIP_REASON,
} from "./test-utils/solid-test-env.js";

const SOLID_REACTIVE = isSolidReactive();
const describeIfClient = SOLID_REACTIVE ? describe : describe.skip;

const ITEMS: DialogListItem[] = [
  { id: "openai", label: "openai", detail: "••••cdef", badge: "default" },
  { id: "deepseek", label: "deepseek", detail: "••••00d" },
];

async function frameOf(props: {
  visible?: boolean;
  title?: string;
  items?: DialogListItem[];
  selectedIndex?: number;
  hint?: string;
} = {}): Promise<string> {
  const t = await testRender(
    () => (
      <Dialog
        title={props.title ?? "Connect a provider"}
        visible={props.visible ?? true}
        items={props.items ?? ITEMS}
        selectedIndex={props.selectedIndex ?? 0}
        hint={props.hint}
      />
    ),
    { width: 80, height: 12 },
  );
  await t.renderOnce();
  const f = t.captureCharFrame();
  return f;
}

describeIfClient("tui-solid P7.1 Dialog — frame rendering", () => {
  it("renders nothing when not visible", async () => {
    const f = await frameOf({ visible: false });
    expect(f).not.toContain("openai");
  });

  it("renders the title", async () => {
    const f = await frameOf({ title: "Connect a provider" });
    expect(f).toContain("Connect a provider");
  });

  it("renders item labels and details", async () => {
    const f = await frameOf();
    expect(f).toContain("/openai");
    expect(f).toContain("/deepseek");
    // 脱敏 key 直接可见（不再现完整密钥）
    expect(f).toContain("••••cdef");
    expect(f).not.toContain("sk-openai-secret");
  });

  it("marks the selected row with the highlight prefix", async () => {
    const f = await frameOf({ selectedIndex: 0 });
    expect(f).toContain("▶");
    const lines = f.split("\n");
    const sel = lines.find((l) => l.includes("/openai"));
    expect(sel).toContain("▶");
  });

  it("moves the highlight when the index changes", async () => {
    const f = await frameOf({ selectedIndex: 1 });
    const lines = f.split("\n");
    const sel = lines.find((l) => l.includes("/deepseek"));
    expect(sel).toContain("▶");
  });

  it("renders badge text next to the item", async () => {
    const f = await frameOf();
    expect(f).toContain("default");
  });

  it("renders the key hint line", async () => {
    const f = await frameOf({ hint: "↑↓ move · Enter select · Esc close" });
    expect(f).toContain("↑↓ move · Enter select · Esc close");
  });

  it("renders the empty state when there are no items", async () => {
    const f = await frameOf({ items: [] });
    expect(f).toContain("No entries");
  });

  it("renders a form when a form fieldset is provided", async () => {
    const t = await testRender(
      () => (
        <Dialog
          title="Add a provider"
          visible={true}
          items={[]}
          selectedIndex={0}
          form={{
            mode: "form",
            fieldIndex: 1,
            fields: { name: "myprov", apiKey: "sk-x", baseURL: "" },
          }}
        />
      ),
      { width: 80, height: 12 },
    );
    await t.renderOnce();
    const f = t.captureCharFrame();
    expect(f).toContain("Add a provider");
    expect(f).toContain("myprov");
    expect(f).toContain("sk-x");
  });
});

describe("tui-solid P7.1 Dialog — runtime gate", () => {
  it("reports WHY the suite is skipped under the SSR build", () => {
    // eslint-disable-next-line no-console
    console.log(
      `[P7.1] solid-reactive=${SOLID_REACTIVE} ` +
        `=> Dialog suite ${SOLID_REACTIVE ? "RUN" : `SKIPPED: ${SSR_SKIP_REASON}`}`,
    );
    expect(typeof SOLID_REACTIVE).toBe("boolean");
  });
});
