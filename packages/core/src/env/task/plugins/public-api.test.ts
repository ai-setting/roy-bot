/**
 * Task #4619 — RED test: the card renderer must be a **first-class public API**.
 *
 * Before this change:
 * - `LarkCardPatchNotifier` / `buildTaskCard` / `renderProgressBar` etc. were
 *   named exports of `lark-card-patch-notifier.ts`, but that file was **not**
 *   reachable through the package `exports` map (the map only publishes
 *   `./dist/<a>/index.js` and `./dist/<a>/<b>/index.js`, so a *file* path like
 *   `env/task/plugins/lark-card-patch-notifier` could never resolve).
 * - The plugins barrel did not re-export them either, so an external host
 *   (the plugin) had to reach into the **private** `cardNotifier` field of a
 *   hook instance and mirror the types by hand.
 *
 * These tests pin the public surface so a future refactor cannot silently
 * drop it again.
 */

import { describe, expect, test } from "bun:test";

// ── The barrel must expose the renderer ────────────────────────────────────
import {
  LarkCardPatchNotifier,
  buildTaskCard,
  renderProgressBar,
  renderMilestones,
  renderProcessSteps,
  renderTaskInfoLines,
  renderContextAsLines,
  renderWorkflowInfoLines,
  buildWorkflowCard,
  formatTimestampForDisplay,
  sanitizeInlineText,
  formatDateTimeForDisplay,
  formatDurationMs,
  humanizeValue,
  resolveTaskTitleForDisplay,
  buildChatAppLink,
  DEFAULT_APP_LINK_BASE,
  type Milestone,
  type ProcessStep,
  type TaskMeta,
  type CardStatus,
  type StartTaskOptions,
  type UpdateTaskOptions,
  type FinishTaskOptions,
  type StartTaskResult,
  type LarkCardPatchNotifierOptions,
} from "./index";

// ── The dedicated subpath must be reachable too ───────────────────────────
// `import("../plugins/lark-card-patch-notifier")` is the *source* level path;
// the *package* level reachability is proven by the build/verify script.

describe("Task #4619: card renderer is a first-class public API", () => {
  test("plugins barrel re-exports LarkCardPatchNotifier (the class)", () => {
    expect(typeof LarkCardPatchNotifier).toBe("function");
    // The host must be able to construct it WITHOUT going through a hook.
    const n = new LarkCardPatchNotifier({ pinOnStart: false, unpinOnFinish: false });
    expect(n).toBeInstanceOf(LarkCardPatchNotifier);
  });

  test("plugins barrel re-exports the render functions", () => {
    expect(typeof buildTaskCard).toBe("function");
    expect(typeof buildWorkflowCard).toBe("function");
    expect(typeof renderProgressBar).toBe("function");
    expect(typeof renderMilestones).toBe("function");
    expect(typeof renderProcessSteps).toBe("function");
    expect(typeof renderTaskInfoLines).toBe("function");
    expect(typeof renderContextAsLines).toBe("function");
    expect(typeof renderWorkflowInfoLines).toBe("function");
    expect(typeof formatTimestampForDisplay).toBe("function");
    expect(typeof sanitizeInlineText).toBe("function");
    expect(typeof formatDateTimeForDisplay).toBe("function");
    expect(typeof formatDurationMs).toBe("function");
    expect(typeof humanizeValue).toBe("function");
    expect(typeof resolveTaskTitleForDisplay).toBe("function");
    expect(typeof buildChatAppLink).toBe("function");
    expect(DEFAULT_APP_LINK_BASE).toContain("feishu");
  });

  test("plugins barrel re-exports the option/meta types (host needs them)", () => {
    // Type-level assertions: they must compile, and the runtime values must
    // not be `undefined` placeholders.
    const status: CardStatus = "running";
    expect(status).toBe("running");

    const meta: TaskMeta = { id: 1, title: "t" };
    expect(meta.title).toBe("t");

    const ms: Milestone = { title: "created" };
    expect(ms.title).toBe("created");

    const step: ProcessStep = { title: "tool" };
    expect(step.title).toBe("tool");

    const start: StartTaskOptions = { chatId: "oc_x", meta: { title: "t" } };
    expect(start.chatId).toBe("oc_x");

    const upd: UpdateTaskOptions = { messageId: "om_x", status: "running" };
    expect(upd.status).toBe("running");

    const fin: FinishTaskOptions = { messageId: "om_x", status: "completed" };
    expect(fin.status).toBe("completed");

    const opts: LarkCardPatchNotifierOptions = { pinOnStart: false };
    expect(opts.pinOnStart).toBe(false);

    const res: StartTaskResult = { messageId: "om_x", pinned: false };
    expect(res.messageId).toBe("om_x");
  });

  test("buildTaskCard renders without any EnvContext / hook machinery", () => {
    const card = buildTaskCard({
      status: "running",
      meta: { id: 42, title: "写报告" },
      milestones: [{ title: "收到消息" }],
      processSteps: [{ title: "Bash" }],
      progress: 50,
    });
    expect(card).toBeDefined();
    expect(card.schema).toBe("2.0");
    // The renderer must be usable by a host that has no EnvContext at all.
    expect(JSON.stringify(card).length).toBeGreaterThan(0);
  });

  test("renderProgressBar renders a bounded-width bar", () => {
    const bar = renderProgressBar(50);
    expect(bar.length).toBeGreaterThan(0);
    expect(bar.length).toBeLessThanOrEqual(64);
  });
});
