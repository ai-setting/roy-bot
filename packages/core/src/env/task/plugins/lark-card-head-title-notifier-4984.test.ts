/**
 * @fileoverview Task #4984 — notifier 层端到端：三个卡片入口的 head 都带任务名称
 *
 * 背景：用户反馈「卡片 head 不只是 task id，还需要有任务名称」。
 *
 * 本文件补上 **notifier 层**（而不只是 buildTaskCard 纯函数层）的覆盖：
 *   - startTask  → 初始卡片 head 含 id + title
 *   - updateTask → patch 卡片 head 含 id + title（meta 不传时沿用缓存的 title）
 *   - finishTask → 终态卡片 head 含 id + title
 *
 * 关键回归点：**patch 时 meta 缺省**（updateTask 不传 meta）也不能丢 title ——
 *   这是「状态变化后 head 退回只有 id」最容易发生的路径。
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  LarkCardPatchNotifier,
  type TaskMeta,
} from "./lark-card-patch-notifier";

function makeMeta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    id: 4984,
    title: "v14：清洗状态捷径 + relabel + 重训 v14",
    description: "卡片 head 带任务名称",
    priority: "high",
    type: "normal",
    ...overrides,
  };
}

/** 解析 send 路径（--content 直接是 card JSON） */
function parseSendCard(argv: string[]): any {
  const i = argv.indexOf("--content");
  return i === -1 ? undefined : JSON.parse(argv[i + 1]);
}

/** 解析 patch 路径（--data = {"content": "<card JSON 字符串>"}） */
function parsePatchCard(argv: string[]): any {
  const i = argv.indexOf("--data");
  if (i === -1) return undefined;
  const body = JSON.parse(argv[i + 1]);
  return typeof body.content === "string" ? JSON.parse(body.content) : body.content;
}

describe("Task #4984 notifier 层 head 带任务名称", () => {
  let runLarkCliSpy: any;
  let originalRunLarkCli: any;

  beforeEach(() => {
    originalRunLarkCli = (LarkCardPatchNotifier.prototype as any).runLarkCli;
    runLarkCliSpy = mock(async (argv: string[], op: string) => {
      if (op === "send") {
        return JSON.stringify({ ok: true, data: { message_id: "om_4984" } });
      }
      return JSON.stringify({ ok: true, data: {} });
    });
    (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;
  });

  afterEach(() => {
    (LarkCardPatchNotifier.prototype as any).runLarkCli = originalRunLarkCli;
  });

  function callsOf(op: string): string[][] {
    return runLarkCliSpy.mock.calls
      .filter((c: any[]) => c[1] === op)
      .map((c: any[]) => c[0] as string[]);
  }

  it("startTask 的初始卡片 head 含 id + 任务名称", async () => {
    const notifier = new LarkCardPatchNotifier();
    await notifier.startTask({ chatId: "oc_x", meta: makeMeta() });

    const card = parseSendCard(callsOf("send")[0]);
    const head = String(card?.header?.title?.content ?? "");
    expect(head).toContain("#4984");
    expect(head).toContain("v14：清洗状态捷径");
  });

  it("updateTask 的 patch 卡片 head 含 id + 任务名称", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_x",
      meta: makeMeta(),
    });
    await notifier.updateTask({ messageId, status: "running" });

    const card = parsePatchCard(callsOf("patch")[0]);
    const head = String(card?.header?.title?.content ?? "");
    expect(head).toContain("#4984");
    expect(head).toContain("v14：清洗状态捷径");
  });

  it("updateTask 不传 meta 时仍保留 startTask 缓存的 title", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_x",
      meta: makeMeta(),
    });
    // 状态更新事件常常拿不到完整 task —— meta 缺省
    await notifier.updateTask({
      messageId,
      status: "running",
      milestones: [{ title: "干到一半", timestamp: new Date().toISOString() }],
    });

    const card = parsePatchCard(callsOf("patch")[0]);
    const head = String(card?.header?.title?.content ?? "");
    expect(head).toContain("v14：清洗状态捷径");
  });

  it("finishTask 的终态卡片 head 含 id + 任务名称", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startTask({
      chatId: "oc_x",
      meta: makeMeta(),
    });
    await notifier.finishTask({ messageId, status: "completed" });

    const card = parsePatchCard(callsOf("patch")[0]);
    const head = String(card?.header?.title?.content ?? "");
    expect(head).toContain("#4984");
    expect(head).toContain("v14：清洗状态捷径");
  });

  it("超长任务名称在 head 里被截断（不撑破布局）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const longTitle = "这是一个非常非常长的任务名称用于测试卡片头部截断行为".repeat(3);
    await notifier.startTask({ chatId: "oc_x", meta: makeMeta({ title: longTitle }) });

    const card = parseSendCard(callsOf("send")[0]);
    const head = String(card?.header?.title?.content ?? "");
    expect(head).toContain("…");
    // 截断后 head 长度受控（CJK 按 2 宽度 → 40 宽度 ≈ 20 个汉字）
    expect(head.length).toBeLessThan(longTitle.length);
    expect(head.length).toBeLessThanOrEqual(60);
  });
});
