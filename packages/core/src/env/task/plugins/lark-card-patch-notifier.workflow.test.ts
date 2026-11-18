/**
 * @fileoverview LarkCardPatchNotifier — workflow 卡片泛化测试（RED/GREEN）
 *
 * Part 2 要求：把 task 卡片的样式与逻辑**泛化**给 workflow run 复用，而不是新写
 * 一个 lark-cli 封装。本测试锁定：
 *
 * 1. `buildWorkflowCard` 卡片形状（schema 2.0 + header + body.elements）
 * 2. workflow 字段都渲染成可读 markdown（workflow 名 / runId / 状态 / 进度 /
 *    节点进度 / 耗时 / 失败原因 / 触发输入摘要），绝不出现 JSON 原文
 * 3. 生命周期：startWorkflow（发卡 + pin）→ updateWorkflow（patch 同一 messageId）
 *    → finishWorkflow（终态 patch + unpin + 清理跟踪）
 * 4. 终态 template：completed=green / failed=red / stopped=grey
 * 5. lark-cli 参数契约与 task 卡片一致（复用同一套 build*Args）
 *
 * 所有 lark-cli 调用被 mock，不真的 spawn。
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  LarkCardPatchNotifier,
  buildWorkflowCard,
  renderProgressBar,
  type WorkflowMeta,
} from "./lark-card-patch-notifier";

// ============================================================================
// helpers
// ============================================================================

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

function parseSendCard(args: string[]): any {
  const raw = flagValue(args, "--content");
  return raw ? JSON.parse(raw) : undefined;
}

function parsePatchCard(args: string[]): any {
  const raw = flagValue(args, "--data");
  if (!raw) return undefined;
  const body = JSON.parse(raw);
  return typeof body.content === "string" ? JSON.parse(body.content) : body.content;
}

function allMarkdown(card: any): string {
  const parts: string[] = [];
  const walk = (els: any[]): void => {
    for (const e of els ?? []) {
      if (e?.tag === "markdown" && typeof e.content === "string") {
        parts.push(e.content);
      } else if (e?.tag === "collapsible_panel" && Array.isArray(e.elements)) {
        walk(e.elements);
      }
    }
  };
  walk(card?.body?.elements ?? []);
  return parts.join("\n");
}

function callsOf(spy: any, op: string): string[][] {
  return spy.mock.calls.filter((c: any) => c[1] === op).map((c: any) => c[0]);
}

function makeMeta(overrides: Partial<WorkflowMeta> = {}): WorkflowMeta {
  return {
    runId: "workflow_run_42",
    workflowId: "wf-def-42",
    workflowName: "发版流程",
    input: { branch: "main", pr: 123 },
    ...overrides,
  };
}

// ============================================================================
// buildWorkflowCard — 卡片形状
// ============================================================================

describe("buildWorkflowCard — workflow 卡片形状", () => {
  it("生成 Card 2.0 骨架（schema/header/body.elements）", () => {
    const card = buildWorkflowCard({
      status: "running",
      meta: makeMeta(),
      totalNodes: 3,
      completedNodes: 1,
      updateCount: 2,
      spinner: "🔄",
    });

    expect(card.schema).toBe("2.0");
    expect(card.header.title.tag).toBe("plain_text");
    expect(card.header.title.content).toContain("发版流程");
    expect(card.header.subtitle.tag).toBe("plain_text");
    expect(card.header.template).toBe("blue");
    expect(Array.isArray(card.body.elements)).toBe(true);
    expect(card.body.elements.length).toBeGreaterThan(0);
  });

  it("渲染 workflow 名 / runId / 状态 / 节点进度 / 耗时（可读 markdown，无 JSON 原文）", () => {
    const card = buildWorkflowCard({
      status: "running",
      meta: makeMeta(),
      totalNodes: 3,
      completedNodes: 2,
      durationMs: 6500,
    });
    const md = allMarkdown(card);

    expect(md).toContain("发版流程");
    expect(md).toContain("workflow_run_42");
    expect(md).toContain("2/3");
    expect(md).toContain("6.5s");
    // 触发输入摘要渲染成可读文本，不出现 JSON 原文
    expect(md).toContain("触发输入");
    expect(md).not.toContain('"branch"');
    expect(md).not.toContain("{\"");
  });

  it("completed 进度条置 100%；failed/stopped 不强行置 100%", () => {
    const completed = buildWorkflowCard({
      status: "completed",
      meta: makeMeta(),
      totalNodes: 3,
      completedNodes: 2,
    });
    expect(allMarkdown(completed)).toContain(renderProgressBar(100));
    expect(completed.header.template).toBe("green");

    const stopped = buildWorkflowCard({
      status: "stopped",
      meta: makeMeta(),
      totalNodes: 4,
      completedNodes: 1,
    });
    expect(allMarkdown(stopped)).toContain(renderProgressBar(25));
    expect(stopped.header.template).toBe("grey");

    const failed = buildWorkflowCard({
      status: "failed",
      meta: makeMeta(),
      totalNodes: 4,
      completedNodes: 1,
    });
    expect(failed.header.template).toBe("red");
    expect(allMarkdown(failed)).toContain(renderProgressBar(25));
  });

  it("失败原因渲染进卡片", () => {
    const card = buildWorkflowCard({
      status: "failed",
      meta: makeMeta(),
      error: "节点 n2 崩溃",
    });
    expect(allMarkdown(card)).toContain("节点 n2 崩溃");
  });

  it("含 里程碑序列 / 操作记录 / 进度 三个区块", () => {
    const card = buildWorkflowCard({
      status: "running",
      meta: makeMeta(),
      milestones: [{ title: "Workflow 启动", timestamp: "2026-10-16T05:00:00.000Z" }],
      processSteps: [{ title: "n1 完成", timestamp: "2026-10-16T05:00:01.000Z" }],
      totalNodes: 2,
      completedNodes: 1,
    });
    const md = allMarkdown(card);
    expect(md).toContain("里程碑");
    // ★ Task #4889：过程信息区拆成「操作记录」/「执行轨迹（工具调用）」两区。
    expect(md).toContain("操作记录");
    expect(md).toContain("Workflow 启动");
    expect(md).toContain("n1 完成");
    expect(md).toContain("进度");
  });
});

// ============================================================================
// 生命周期
// ============================================================================

describe("LarkCardPatchNotifier — workflow 生命周期", () => {
  let runLarkCliSpy: any;
  let originalRunLarkCli: any;
  let ops: string[];

  beforeEach(() => {
    ops = [];
    originalRunLarkCli = (LarkCardPatchNotifier.prototype as any).runLarkCli;
    runLarkCliSpy = mock(async (argv: string[], op: string) => {
      ops.push(op);
      if (argv.includes("+messages-send")) {
        return JSON.stringify({ ok: true, data: { message_id: "om_wf_001" } });
      }
      return JSON.stringify({ ok: true, data: {} });
    });
    (LarkCardPatchNotifier.prototype as any).runLarkCli = runLarkCliSpy;
  });

  afterEach(() => {
    (LarkCardPatchNotifier.prototype as any).runLarkCli = originalRunLarkCli;
  });

  it("startWorkflow: 发初始卡片 + pin，返回 messageId", async () => {
    const notifier = new LarkCardPatchNotifier();
    const res = await notifier.startWorkflow({
      chatId: "oc_chat",
      profile: "prof",
      meta: makeMeta(),
      totalNodes: 3,
    });

    expect(res.messageId).toBe("om_wf_001");
    expect(res.pinned).toBe(true);

    const sendArgs = callsOf(runLarkCliSpy, "send")[0];
    expect(sendArgs).toContain("im");
    expect(sendArgs).toContain("+messages-send");
    expect(flagValue(sendArgs, "--msg-type")).toBe("interactive");
    expect(sendArgs).toContain("--as");
    expect(flagValue(sendArgs, "--as")).toBe("bot");
    const card = parseSendCard(sendArgs);
    expect(card.header.title.content).toContain("发版流程");

    // pin 契约：--data '{"message_id":"om_wf_001"}'
    const pinArgs = callsOf(runLarkCliSpy, "pin")[0];
    expect(pinArgs).toContain("im");
    expect(pinArgs).toContain("pins");
    expect(pinArgs).toContain("create");
    expect(JSON.parse(flagValue(pinArgs, "--data")!).message_id).toBe("om_wf_001");
  });

  it("updateWorkflow: patch 同一 messageId，进度条反映节点进度", async () => {
    const notifier = new LarkCardPatchNotifier();
    const { messageId } = await notifier.startWorkflow({
      chatId: "oc_chat",
      meta: makeMeta(),
      totalNodes: 3,
    });

    await notifier.updateWorkflow({
      messageId,
      status: "running",
      currentNode: "n2",
      currentNodeType: "tool",
      completedNodes: 2,
      totalNodes: 3,
    });

    const patchArgs = callsOf(runLarkCliSpy, "patch");
    expect(patchArgs).toHaveLength(1);
    expect(flagValue(patchArgs[0], "--message-id")).toBe(messageId);
    const card = parsePatchCard(patchArgs[0]);
    const md = allMarkdown(card);
    expect(md).toContain(renderProgressBar(Math.round((2 / 3) * 100)));
    expect(md).toContain("n2");
  });

  it("finishWorkflow(completed): 终态 patch + unpin（显式开启时）+ 清理跟踪", async () => {
    // ★ Task #5164 R2a：默认不 unpin；本契约测显式 unpinOnFinish=true 的 argv 形态
    const notifier = new LarkCardPatchNotifier({ unpinOnFinish: true });
    const { messageId } = await notifier.startWorkflow({
      chatId: "oc_chat",
      meta: makeMeta(),
      totalNodes: 2,
    });
    await notifier.finishWorkflow({
      messageId,
      status: "completed",
      totalNodes: 2,
      completedNodes: 2,
      durationMs: 900,
    });

    const patchArgs = callsOf(runLarkCliSpy, "patch");
    const card = parsePatchCard(patchArgs[patchArgs.length - 1]);
    expect(card.header.template).toBe("green");
    expect(allMarkdown(card)).toContain(renderProgressBar(100));

    // unpin 契约
    expect(ops).toContain("unpin");
    const unpinArgs = callsOf(runLarkCliSpy, "unpin")[0];
    expect(unpinArgs.slice(0, 3)).toEqual(["im", "pins", "delete"]);
    expect(flagValue(unpinArgs, "--message-id")).toBe(messageId);
    expect(unpinArgs).toContain("--yes");

    expect(notifier.trackedWorkflowCardCount()).toBe(0);
  });

  it("pin 失败非致命（pinned=false），卡片仍返回 messageId", async () => {
    const notifier = new LarkCardPatchNotifier();
    (LarkCardPatchNotifier.prototype as any).runLarkCli = mock(
      async (argv: string[], op: string) => {
        if (op === "pin") throw new Error("pin boom");
        if (argv.includes("+messages-send")) {
          return JSON.stringify({ ok: true, data: { message_id: "om_wf_002" } });
        }
        return "{}";
      }
    );

    const res = await notifier.startWorkflow({
      chatId: "oc_chat",
      meta: makeMeta(),
      totalNodes: 1,
    });
    expect(res.messageId).toBe("om_wf_002");
    expect(res.pinned).toBe(false);
    expect(res.pinError).toContain("pin boom");
  });
});
