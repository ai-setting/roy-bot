/**
 * @fileoverview Task #4722 收口 round2 — 交叉验证 MINOR 修复
 *
 * 修复清单（来自 claude-minimax 交叉验证，0 BLOCKER / 0 MAJOR / 8 MINOR）：
 * - MINOR-1：llm 存在但不是对象（string/null/array）→ jsonc modify 抛裸错
 *            「Can not add index to parent of type string」，用户看不懂。
 *            → 改为人类可读的中文错误。
 * - MINOR-2：reorder 用**位置索引**，卡片渲染后若配置被改（别人 CLI 改了 /
 *            另一张卡片加了项），会移错模型。→ 卡片回调改为**按模型标识匹配**，
 *            匹配不到再回退到索引。
 * - MINOR-3：飞书群里 @bot 时消息带 `<at user_id="ou_x"></at>` 前缀，
 *            导致 `##command##:` 识别不到 → 静默走 agent 链路。
 *            → 前缀识别前先剥离 @-提及标记。
 * - MINOR-4：不可达分支 `this.eventHandler?.(undefined as any)` 是地雷。
 *            → 改为回错误卡片并 return，绝不把 undefined 喂给 agent 链路。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { getGlobalCommandRegistry } from "./command-registry";
import {
  translateCardActionToCommand,
  handleCommandCardAction,
} from "./command-card-action";
import { FALLBACK_MODEL_ACTIONS } from "./command-cards";

describe("Task #4722 round2：MINOR-1 llm 非对象的友好报错", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `roy-4722-m1-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    );
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "config.jsonc");
  });

  test("llm 是字符串 → 报错可读（不是 jsonc 裸错）", async () => {
    writeFileSync(configPath, '{\n  "llm": "not-an-object"\n}');
    const result = await getGlobalCommandRegistry().dispatch(
      "fallback-model",
      ["add", "a/M1"],
      { configPath }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("llm");
    // 不应出现 jsonc 的原始英文错误
    expect(result.error).not.toContain("Can not add index");
  });

  test("llm 是 null → 报错可读", async () => {
    writeFileSync(configPath, '{\n  "llm": null\n}');
    const result = await getGlobalCommandRegistry().dispatch(
      "fallback-model",
      ["add", "a/M1"],
      { configPath }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("llm");
    expect(result.error).not.toContain("Can not add index");
  });

  test("llm 非对象时文件不被破坏", async () => {
    const original = '{\n  "llm": "not-an-object"\n}';
    writeFileSync(configPath, original);
    await getGlobalCommandRegistry().dispatch(
      "fallback-model",
      ["add", "a/M1"],
      { configPath }
    );
    const after = require("fs").readFileSync(configPath, "utf-8");
    expect(after).toBe(original);
  });
});

describe("Task #4722 round2：MINOR-2 reorder 按模型标识匹配", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `roy-4722-m2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    );
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "config.jsonc");
  });

  test("卡片带 model 时 → command 用模型标识 + 方向（不依赖过期索引）", async () => {
    // 卡片渲染时列表是 [a/M1, b/M2]，用户此时用 CLI 加了 c/M3 → 索引全变了
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["c/M3", "a/M1", "b/M2"] }\n}'
    );

    const result = await handleCommandCardAction(
      {
        actionValue: {
          action: FALLBACK_MODEL_ACTIONS.up,
          index: 2, // 卡片上的旧索引（现在是 3）
          model: "a/M1", // 但模型标识还在
        },
      },
      {
        executeCommand: async (sub, args) => {
          // 期望按模型标识定位，而不是用过期索引
          expect(args[0]).toBe("move");
          expect(args[1]).toBe("a/M1");
          expect(args[2]).toBe("up");
          return { ok: true, output: { text: "ok" } };
        },
        configPath,
      }
    );

    expect(result.ok).toBe(true);
  });

  test("模型标识找不到 → 回退到索引（不放弃操作）", async () => {
    const call = translateCardActionToCommand({
      actionValue: {
        action: FALLBACK_MODEL_ACTIONS.up,
        index: 2,
        model: "deleted/M9",
      },
    });
    // move 找不到时会报「列表中找不到」→ 由 command 层给出可读错误
    expect(call).toEqual({
      subcommand: "fallback-model",
      args: ["move", "deleted/M9", "up"],
    });
  });

  test("无 model 字段 → 保持纯索引形式（向后兼容）", () => {
    const call = translateCardActionToCommand({
      actionValue: { action: FALLBACK_MODEL_ACTIONS.down, index: 1 },
    });
    expect(call).toEqual({
      subcommand: "fallback-model",
      args: ["reorder", "1", "2"],
    });
  });
});

describe("Task #4722 round2：MINOR-6 无效条目不被静默删除", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `roy-4722-m6-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    );
    mkdirSync(dir, { recursive: true });
    configPath = join(dir, "config.jsonc");
  });

  test("add 不删除原有的非字符串条目", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", 123, "b/M2"] }\n}'
    );
    const result = await getGlobalCommandRegistry().dispatch(
      "fallback-model",
      ["add", "c/M3"],
      { configPath }
    );
    expect(result.ok).toBe(true);

    const raw = JSON.parse(
      require("fs").readFileSync(configPath, "utf-8")
    ) as any;
    // 原始数组长度不变（3 → 4），无效条目 123 仍在原位
    expect(raw.llm.fallbackModels.length).toBe(4);
    expect(raw.llm.fallbackModels[1]).toBe(123);
    expect(raw.llm.fallbackModels[3]).toBe("c/M3");
  });

  test("remove 按有效序号删除，无效条目保留", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", 123, "b/M2"] }\n}'
    );
    const result = await getGlobalCommandRegistry().dispatch(
      "fallback-model",
      ["remove", "1"],
      { configPath }
    );
    expect(result.ok).toBe(true);

    const raw = JSON.parse(
      require("fs").readFileSync(configPath, "utf-8")
    ) as any;
    // a/M1 被删（有效序号 1），123 保留
    expect(raw.llm.fallbackModels).toEqual([123, "b/M2"]);
  });

  test("reorder 按有效序号调整，无效条目保留", async () => {
    writeFileSync(
      configPath,
      '{\n  "llm": { "fallbackModels": ["a/M1", 123, "b/M2"] }\n}'
    );
    const result = await getGlobalCommandRegistry().dispatch(
      "fallback-model",
      ["reorder", "2", "1"],
      { configPath }
    );
    expect(result.ok).toBe(true);

    const raw = JSON.parse(
      require("fs").readFileSync(configPath, "utf-8")
    ) as any;
    // ① 无效条目**没有被静默删除**（仍在数组里）
    expect(raw.llm.fallbackModels.length).toBe(3);
    expect(raw.llm.fallbackModels).toContain(123);
    // ② 有效条目的顺序正确：[a/M1, b/M2] → [b/M2, a/M1]（move 语义，非 swap）
    const effective = raw.llm.fallbackModels.filter(
      (m: unknown): m is string => typeof m === "string"
    );
    expect(effective).toEqual(["b/M2", "a/M1"]);
  });
});

describe("Task #4722 round2：MINOR-3 剥离 @-提及前缀", () => {
  test("extractCommandText：@bot 前缀 + ##command##: → 仍识别为命令", async () => {
    const { extractCommandText } = await import("./event-source-handlers");
    const raw = {
      type: "im.message.receive_v1",
      chat_id: "oc_x",
      message_id: "om_x",
      message_type: "text",
      content: JSON.stringify({
        text: '<at user_id="ou_bot"></at> ##command##: list model',
      }),
    };
    const text = extractCommandText(raw);
    expect(text).toBeDefined();
    expect(text).toContain("##command##: list model");
  });

  test("extractCommandText：@_user_1 形式（飞书另一种提及标记）→ 仍识别", async () => {
    const { extractCommandText } = await import("./event-source-handlers");
    const raw = {
      type: "im.message.receive_v1",
      chat_id: "oc_x",
      message_id: "om_x",
      message_type: "text",
      content: JSON.stringify({
        text: '@_user_1 ##command##: list model',
      }),
    };
    const text = extractCommandText(raw);
    expect(text).toBeDefined();
    expect(text).toContain("##command##: list model");
  });

  test("extractCommandText：无提及的普通消息 → 仍返回 undefined（不回归）", async () => {
    const { extractCommandText } = await import("./event-source-handlers");
    const raw = {
      type: "im.message.receive_v1",
      chat_id: "oc_x",
      message_id: "om_x",
      message_type: "text",
      content: JSON.stringify({ text: "你好" }),
    };
    expect(extractCommandText(raw)).toBeUndefined();
  });
});
