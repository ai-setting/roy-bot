/**
 * @fileoverview Task #4634 — `buildModelAgentContext` 纯函数单测。
 *
 * 这个 helper 是四个命令（act / interactive / run / chat）共享的
 * 「CLI 模型 flag → AgentContext 片段」接线点，所以它的行为必须被锁死：
 *
 * - 两个 flag 都给 → 两个 key 都在
 * - 只给一个 → 只有那个 key
 * - 都不给 → **空对象**（不产生 `model: undefined` 这种 key）
 * - 空字符串视同未提供（yargs 可能给出 ""）
 *
 * 为什么「不产生 undefined key」重要：
 * core 层 `agent-component.ts` 用 `model: (context?.model) ?? agent.config.model`
 * 取值，`undefined` 与「key 不存在」在这里等价；但保持片段干净能避免
 * 下游 `JSON.stringify` / spread 时出现噪声字段。
 */

import { describe, expect, test } from "bun:test";

import {
  buildModelAgentContext,
  FALLBACK_MODEL_DESCRIBE,
  MODEL_DESCRIBE,
} from "./model-flags";

describe("buildModelAgentContext (Task #4634)", () => {
  test("两个 flag 都给 → 两个 key 都在", () => {
    const ctx = buildModelAgentContext({
      model: "opencodego/primary",
      fallbackModel: "opencodego/backup",
    });
    expect(ctx.model).toBe("opencodego/primary");
    expect(ctx.fallbackModel).toBe("opencodego/backup");
  });

  test("只给 --model → 只有 model key", () => {
    const ctx = buildModelAgentContext({ model: "opencodego/primary" });
    expect(ctx.model).toBe("opencodego/primary");
    expect("fallbackModel" in ctx).toBe(false);
  });

  test("只给 --fallback-model → 只有 fallbackModel key", () => {
    const ctx = buildModelAgentContext({ fallbackModel: "opencodego/backup" });
    expect(ctx.fallbackModel).toBe("opencodego/backup");
    expect("model" in ctx).toBe(false);
  });

  test("都不给 → 空对象（不产生 undefined key）", () => {
    const ctx = buildModelAgentContext({});
    expect(ctx).toEqual({});
    expect("model" in ctx).toBe(false);
    expect("fallbackModel" in ctx).toBe(false);
  });

  test("undefined 值视同未提供", () => {
    const ctx = buildModelAgentContext({
      model: undefined,
      fallbackModel: undefined,
    });
    expect(ctx).toEqual({});
  });

  test("空字符串视同未提供（yargs 可能给出 \"\"）", () => {
    const ctx = buildModelAgentContext({ model: "", fallbackModel: "" });
    expect(ctx).toEqual({});
  });
});

describe("FALLBACK_MODEL_DESCRIBE (Task #4634 交叉验证 MINOR 2)", () => {
  /**
   * 四个命令的 `--fallback-model` 必须用**同一份** describe 文案 ——
   * 否则同一个 flag 在 `--help` 里会出现中英文混杂的多种措辞。
   */
  test("act / run / interactive / chat 四个命令的 --fallback-model 描述一致", async () => {
    const { RunCommand } = await import("./interactive.js");
    const { InteractiveCommand } = await import("./run.js");
    const { ChatCommand } = await import("./chat.js");

    /** 捕获某个命令 builder 里 --fallback-model 的 describe */
    function describeOf(builder: any): string {
      let captured = "";
      const yargs: any = {
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check(_fn: any) {
          return yargs;
        },
        option(name: string, config: any) {
          if (name === "fallback-model") captured = config?.describe ?? "";
          return yargs;
        },
        positional(_n: string, _c: any) {
          return yargs;
        },
      };
      builder(yargs);
      return captured;
    }

    // act.ts 的 describe 在源码里（它的 builder 结构与其它命令不同），
    // 这里用 act 的常量做对照：四个命令都必须等于 FALLBACK_MODEL_DESCRIBE。
    expect(describeOf(RunCommand.builder)).toBe(FALLBACK_MODEL_DESCRIBE);
    expect(describeOf(InteractiveCommand.builder)).toBe(FALLBACK_MODEL_DESCRIBE);
    expect(describeOf(ChatCommand.builder)).toBe(FALLBACK_MODEL_DESCRIBE);
  });

  test("--model 的 describe 在四个命令里也一致（第 2 轮 MINOR-A）", async () => {
    const { RunCommand } = await import("./interactive.js");
    const { InteractiveCommand } = await import("./run.js");
    const { ChatCommand } = await import("./chat.js");

    function describeOf(builder: any, flag: string): string {
      let captured = "";
      const yargs: any = {
        // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
        check(_fn: any) {
          return yargs;
        },
        option(name: string, config: any) {
          if (name === flag) captured = config?.describe ?? "";
          return yargs;
        },
        positional(_n: string, _c: any) {
          return yargs;
        },
      };
      builder(yargs);
      return captured;
    }

    expect(describeOf(RunCommand.builder, "model")).toBe(MODEL_DESCRIBE);
    expect(describeOf(InteractiveCommand.builder, "model")).toBe(MODEL_DESCRIBE);
    expect(describeOf(ChatCommand.builder, "model")).toBe(MODEL_DESCRIBE);
  });

  test("act.ts 也用同一份文案", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const testDir = path.dirname(new URL(import.meta.url).pathname);
    const src = await readFile(path.join(testDir, "act.ts"), "utf8");
    // act.ts 引用共享常量，而不是自己写一份文案
    expect(src).toContain("describe: FALLBACK_MODEL_DESCRIBE");
    expect(src).toContain("describe: MODEL_DESCRIBE");
    expect(src).toContain('from "./model-flags"');
  });
});
