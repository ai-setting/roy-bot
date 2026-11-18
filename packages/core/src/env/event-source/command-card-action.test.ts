/**
 * @fileoverview Task #4722 收口 — command 卡片按钮回调路由
 *
 * 覆盖：
 * 1. 回调识别：fbmodel 命名空间的回调 → 是 command 卡片回调；task 卡片回调 → 不是
 * 2. 动作翻译：上移 / 下移 / 新增 → 对应的 command 调用
 * 3. 执行：翻译后调 command 子系统；成功后用 token patch 新卡片
 * 4. 失败：命令失败 → ok=false + error（不 patch）
 */

import { describe, test, expect } from "bun:test";

import {
  isCommandCardAction,
  translateCardActionToCommand,
  handleCommandCardAction,
} from "./command-card-action";
import { FALLBACK_MODEL_ACTIONS } from "./command-cards";

describe("Task #4722 收口：command 卡片回调识别", () => {
  test("button callback（action_value.action = fbmodel_up）→ 是 command 回调", () => {
    expect(
      isCommandCardAction({ actionValue: { action: FALLBACK_MODEL_ACTIONS.up } })
    ).toBe(true);
  });

  test("form 提交（action_name = fbmodel_add）→ 是 command 回调", () => {
    expect(
      isCommandCardAction({ actionName: FALLBACK_MODEL_ACTIONS.add })
    ).toBe(true);
  });

  test("task 卡片回调（create_group）→ 不是 command 回调", () => {
    expect(
      isCommandCardAction({ actionValue: { action: "create_group", taskId: 1 } })
    ).toBe(false);
    expect(isCommandCardAction({ actionName: "some_task_button" })).toBe(false);
  });
});

describe("Task #4722 收口：动作 → command 翻译", () => {
  test("上移：index=2 → reorder 2 1", () => {
    const call = translateCardActionToCommand({
      actionValue: { action: FALLBACK_MODEL_ACTIONS.up, index: 2 },
    });
    expect(call).toEqual({
      subcommand: "fallback-model",
      args: ["reorder", "2", "1"],
    });
  });

  test("下移：index=1 → reorder 1 2", () => {
    const call = translateCardActionToCommand({
      actionValue: { action: FALLBACK_MODEL_ACTIONS.down, index: 1 },
    });
    expect(call).toEqual({
      subcommand: "fallback-model",
      args: ["reorder", "1", "2"],
    });
  });

  test("新增：form_value 里的模型名 → add", () => {
    const call = translateCardActionToCommand({
      actionName: FALLBACK_MODEL_ACTIONS.add,
      formValue: { fbmodel_model: "tong/GLM-5.3-Flash" },
    });
    expect(call).toEqual({
      subcommand: "fallback-model",
      args: ["add", "tong/GLM-5.3-Flash"],
    });
  });

  test("新增：模型名为空 → 无法翻译（返回 null）", () => {
    const call = translateCardActionToCommand({
      actionName: FALLBACK_MODEL_ACTIONS.add,
      formValue: { fbmodel_model: "   " },
    });
    expect(call).toBeNull();
  });

  test("上移到第 1 位（index=1）→ 目标 0 非法 → null", () => {
    const call = translateCardActionToCommand({
      actionValue: { action: FALLBACK_MODEL_ACTIONS.up, index: 1 },
    });
    expect(call).toBeNull();
  });

  test("未知 action → null", () => {
    expect(
      translateCardActionToCommand({ actionValue: { action: "fbmodel_zzz" } })
    ).toBeNull();
    expect(translateCardActionToCommand({})).toBeNull();
  });
});

describe("Task #4722 收口：执行回调", () => {
  test("成功：调 command 子系统 + 用 token patch 新卡片", async () => {
    const calls: Array<{ sub: string; args: string[] }> = [];
    const patches: Array<{ token: string; profile?: string }> = [];
    const newCard = { schema: "2.0", body: { elements: [] } };

    const result = await handleCommandCardAction(
      {
        actionValue: { action: FALLBACK_MODEL_ACTIONS.down, index: 1 },
        token: "tok-123",
        profile: "default",
      },
      {
        executeCommand: async (sub, args) => {
          calls.push({ sub, args });
          return {
            ok: true,
            output: { text: "已下移", card: newCard },
          };
        },
        configPath: "/tmp/x.jsonc",
        patchCard: async (token, _card, profile) => {
          patches.push({ token, profile });
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sub).toBe("fallback-model");
    expect(calls[0].args).toEqual(["reorder", "1", "2"]);
    // patch 用飞书 token
    expect(patches).toHaveLength(1);
    expect(patches[0].token).toBe("tok-123");
    expect(patches[0].profile).toBe("default");
  });

  test("命令失败 → ok=false + error（不 patch 卡片）", async () => {
    let patched = 0;
    const result = await handleCommandCardAction(
      {
        actionValue: { action: FALLBACK_MODEL_ACTIONS.down, index: 9 },
        token: "tok-456",
      },
      {
        executeCommand: async () => ({ ok: false, error: "序号越界" }),
        patchCard: async () => {
          patched++;
        },
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("序号越界");
    expect(patched).toBe(0);
  });

  test("无 token → 不 patch（但命令已执行成功）", async () => {
    let patched = 0;
    const result = await handleCommandCardAction(
      {
        actionValue: { action: FALLBACK_MODEL_ACTIONS.up, index: 3 },
      },
      {
        executeCommand: async () => ({
          ok: true,
          output: { text: "已上移", card: { schema: "2.0" } },
        }),
        patchCard: async () => {
          patched++;
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(patched).toBe(0);
  });

  test("命令抛异常 → ok=false（不冒泡）", async () => {
    const result = await handleCommandCardAction(
      {
        actionValue: { action: FALLBACK_MODEL_ACTIONS.up, index: 3 },
      },
      {
        executeCommand: async () => {
          throw new Error("boom");
        },
      }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  test("★ 卡片刷新失败 → ok=true 但带 patchError（让上层能回执）", async () => {
    const result = await handleCommandCardAction(
      {
        actionValue: { action: FALLBACK_MODEL_ACTIONS.up, index: 3 },
        token: "tok-789",
      },
      {
        executeCommand: async () => ({
          ok: true,
          output: { text: "已上移", card: { schema: "2.0" } },
        }),
        patchCard: async () => {
          throw new Error("token 已过期");
        },
      }
    );

    // 业务动作成功
    expect(result.ok).toBe(true);
    // 但刷新失败必须被报告出来（否则卡片静默停在旧状态）
    expect(result.patchError).toBeDefined();
    expect(result.patchError).toContain("token 已过期");
  });
});
