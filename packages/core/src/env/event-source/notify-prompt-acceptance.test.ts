/**
 * Task #5054：notify prompt 补验收动作
 *
 * 真根因（Task #5042 现场）：default agent 收到「sub-agent 完成」通知后
 * **从不调用 `task_complete`**，任务永远停在 `active`。
 *
 * 机制：`buildNotifyHandlePrompt` 生成的 notify prompt 是**本轮 task-specific
 * 的即时指令**，会压过 system prompt 里的「任务验收职责」章节。
 * 旧版「你要做什么」小节只要求「总结 + 给选项 + 发消息」——
 * 完全没提 `task_complete`、没提验收 ⇒ agent 照着它做，就没去调 task_complete。
 *
 * 本文件锁死：
 *   1. completed → promptText 含 task_complete
 *   2. completed → promptText 含**具体 task id**（不是 <id> 占位符）
 *   3. completed → promptText 提到「验收」/「核对实际产出」（不只是字面量）
 *   4. failed/timeout/stopped → 不含「task_cancel 收尾」类授权措辞
 *   5. started/progress 中间态 → **不含** task_complete（#4105 回归边界）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl } from "./event-store";
import { larkCliHandler } from "./event-source-handlers";
import type {
  BuildNotifyHandlePromptInput,
  TriggerEventInput,
} from "./types";

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "notify-prompt-acceptance-"));
  store = new EventStoreImpl({ dbPath: join(tmpDir, "events.db") });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTriggerInput(): TriggerEventInput {
  return {
    senderId: "ou_sender_5054",
    text: "请帮我完成这个任务",
    metadata: {
      eventType: "im.message.receive_v1",
      appId: "cli_appid_5054",
      chatId: "oc_chat_5054",
      chatType: "group",
      messageId: "om_msg_5054",
      messageType: "text",
      senderId: "ou_sender_5054",
      tenantKey: "tnt_lc_5054",
    },
    rawEvent: { type: "event", v: 1 },
  };
}

/** 构造某个 notify 类型的 promptText。 */
async function promptTextFor(
  type: string,
  taskId?: number,
  subSessionId?: string,
): Promise<string> {
  const id = await larkCliHandler.emitTriggerEvent(makeTriggerInput(), store);
  const triggerEvent = await store.getEventById(id);
  const input: BuildNotifyHandlePromptInput = {
    notifyEvent: {
      type,
      taskId,
      description: "实现 trimAll",
      result: "sub-agent 输出",
      subSessionId,
    },
    triggerEvent: triggerEvent!,
    subAgentResult: { summary: "sub-agent 摘要" },
  };
  return larkCliHandler.buildNotifyHandlePrompt(input).promptText;
}

// =============================================================================
// 1~3：completed → 必须要求验收 + task_complete + 具体 task id
// =============================================================================

describe("notify prompt / task.background.completed → 验收指令", () => {
  test("① promptText 包含 task_complete", async () => {
    const text = await promptTextFor("task.background.completed", 5042);
    expect(text).toContain("task_complete");
  });

  test("② promptText 包含具体 task id（5042），不是 <id> 占位符", async () => {
    const text = await promptTextFor("task.background.completed", 5042);
    // ⚠️ task_complete 调用里必须写死具体 id —— 不允许让 agent 自己猜任务号
    expect(text).toMatch(/task_complete\(task_id=5042/);
    // ⚠️ 不允许出现裸占位符
    expect(text).not.toContain("task_id=<id>");
    expect(text).not.toContain("task_complete(task_id=<id>");
  });

  test("③ promptText 提到「验收」或「核对实际产出」（不只是 task_complete 字面量）", async () => {
    const text = await promptTextFor("task.background.completed", 5042);
    expect(text).toMatch(/验收|核对实际产出/);
  });

  test("③b completed 指令要求先 task_get 核对产出、再逐条对照 goals 子项", async () => {
    const text = await promptTextFor("task.background.completed", 5042);
    expect(text).toContain("task_get");
    expect(text).toMatch(/goals/);
  });

  test("③c completed 指令给出 deliverable_storage_path 参数（落终态需要交付物地址）", async () => {
    const text = await promptTextFor("task.background.completed", 5042);
    expect(text).toContain("deliverable_storage_path");
  });

  test("③d completed 指令写明「只回消息不算完成」的语义", async () => {
    const text = await promptTextFor("task.background.completed", 5042);
    expect(text).toMatch(/只回消息|不算完成|一直挂在|停在 active|挂(active|在 active)/);
  });

  test("③e completed 指令给出验收不通过时的续跑路径（sub_session_id / 重新委托）", async () => {
    const text = await promptTextFor("task.background.completed", 5042, "ses_sub_5054");
    expect(text).toMatch(/sub_session_id|重新委托/);
  });

  test("③g 子 session 行续跑提示必须用 sub_session_id（与 delegate tool schema 一致，Task #5464）", async () => {
    const text = await promptTextFor("task.background.completed", 5042, "ses_sub_5054");
    // 「子 session:」行的续跑示例必须写 sub_session_id="<值>" ——
    // delegate_task tool schema 的参数名是 sub_session_id（snake_case），
    // 旧文案 existingSubSessionId=（camelCase）不在 schema，会被 zod
    // 静默丢弃 → 续跑静默变成新建 session（Task #5456 同类 bug）。
    expect(text).toContain('delegate_task(sub_session_id="ses_sub_5054"');
    expect(text).not.toContain("existingSubSessionId");
  });

  test("③f 「你要做什么」小节标题只出现一次（防重复渲染）", async () => {
    const text = await promptTextFor("task.background.completed", 5042);
    const count = text.split("### 👉 你要做什么").length - 1;
    expect(count).toBe(1);
  });
});

// =============================================================================
// 4：failed / timeout / stopped → 不授权 task_cancel 收尾，要求找根因继续推进
// =============================================================================

describe("notify prompt / 失败类终态 → 不授权 task_cancel 收尾", () => {
  for (const type of [
    "task.background.failed",
    "task.background.timeout",
    "task.background.stopped",
  ]) {
    test(`④ ${type} 不含「task_cancel 收尾」类授权措辞`, async () => {
      const text = await promptTextFor(type, 5042);
      expect(text).not.toMatch(/task_cancel[^。\n]{0,20}收尾/);
      expect(text).not.toMatch(/用 task_cancel 收尾/);
      expect(text).not.toMatch(/task_cancel 收尾/);
    });

    test(`④b ${type} 要求找根因并继续推进`, async () => {
      const text = await promptTextFor(type, 5042);
      // ⚠️ 旧 prompt 里的「继续推进 / 拆小 / 放弃」是**给用户选的下一步选项**，
      //   不是「你要自己找根因继续推进」的指令 —— 必须锁定"根因"这个信号词，
      //   否则断言会被旧文案误判为绿。
      expect(text).toMatch(/根因/);
      expect(text).toMatch(/继续推进|重新委托|续跑/);
    });

    test(`④c ${type} 明确「不要 task_cancel（除非用户明令）」`, async () => {
      const text = await promptTextFor(type, 5042);
      expect(text).toMatch(/不要[^。\n]{0,30}task_cancel|task_cancel[^。\n]{0,30}不要/);
      expect(text).toMatch(/用户明令|用户要求|用户明确/);
    });
  }
});

// =============================================================================
// 5：started / progress 中间态 → 绝不含 task_complete（#4105 回归边界）
// =============================================================================

describe("notify prompt / 中间态 → 不含 task_complete（#4105 回归边界）", () => {
  for (const type of ["task.background.started", "task.background.progress"]) {
    test(`⑤ ${type} 的 promptText 不含 task_complete`, async () => {
      const text = await promptTextFor(type, 5042);
      expect(text).not.toContain("task_complete");
    });
  }
});
