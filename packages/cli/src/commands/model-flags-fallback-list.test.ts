/**
 * @fileoverview Task #4724 — CLI `--fallback-model` 多模型列表的 TDD 测试。
 *
 * ## 覆盖的 6 个场景（与任务要求一一对应）
 *
 *   1. 单模型向后兼容        —— `--fallback-model xxx` 仍然产生 fallbackModel
 *   2. 多模型顺序 fallback  —— 逗号语法 / 重复传语法都产出**有序数组**
 *   3. config 列表          —— 由 core 层读取（见 core 侧测试）
 *   4. CLI 覆盖 config      —— 显式传入完全覆盖（core 层 resolveFallbackModels）
 *   5. 都未配                —— 不产生任何 key
 *   6. 全部模型失败报错      —— core 层（见 core 侧测试）
 *
 * ## 额外覆盖：#4638 review 亲验的接线覆盖缺口
 *
 * review 指出 act.ts / interactive.ts / run.ts 的 `--fallback-model` 接线
 * **没有被测试锁住** —— 只有 run.ts 的 stream 路径与 chat.ts 能被捕获。
 * 如果将来有人把 `buildModelAgentContext(args)` 改成不传 fallbackModel，
 * 现有测试**不会变红**。本文件补上这些缺口的断言（用源码契约 + 纯函数
 * 行为双重锁定）。
 *
 * @see ./model-flags.ts —— buildModelAgentContext / parseFallbackModelArgs
 */

import { describe, expect, test } from "bun:test";

import {
  buildModelAgentContext,
  parseFallbackModelArgs,
  findInvalidFallbackModels,
  formatInvalidFallbackModelError,
  checkFallbackModelArg,
  FALLBACK_MODEL_DESCRIBE,
  MODEL_DESCRIBE,
} from "./model-flags";

/**
 * 读取同目录下的命令源码（用于「源码契约」类断言）。
 */
async function readSrc(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const testDir = path.dirname(new URL(import.meta.url).pathname);
  return readFile(path.join(testDir, file), "utf8");
}


describe("Task #4724 — parseFallbackModelArgs（CLI 多模型语法解析）", () => {
  test("场景1：单个模型 → 长度 1 的数组", () => {
    expect(parseFallbackModelArgs("opencodego/backup")).toEqual(["opencodego/backup"]);
  });

  test("场景2a：逗号分隔 → 按顺序拆成多个", () => {
    expect(parseFallbackModelArgs("a/M1,b/M2,c/M3")).toEqual(["a/M1", "b/M2", "c/M3"]);
  });

  test("场景2b：重复传（yargs 给数组）→ 保持顺序", () => {
    expect(parseFallbackModelArgs(["a/M1", "b/M2"])).toEqual(["a/M1", "b/M2"]);
  });

  test("场景2c：混合（重复传 + 其中一项含逗号）→ 全部展开且保持顺序", () => {
    expect(parseFallbackModelArgs(["a/M1,b/M2", "c/M3"])).toEqual([
      "a/M1",
      "b/M2",
      "c/M3",
    ]);
  });

  test("场景2d：逗号两侧的空白被裁掉", () => {
    expect(parseFallbackModelArgs(" a/M1 , b/M2 ")).toEqual(["a/M1", "b/M2"]);
  });

  test("场景5：undefined / 空串 / 只有逗号 → 空数组（等同未配置）", () => {
    expect(parseFallbackModelArgs(undefined)).toEqual([]);
    expect(parseFallbackModelArgs("")).toEqual([]);
    expect(parseFallbackModelArgs("   ")).toEqual([]);
    expect(parseFallbackModelArgs(",")).toEqual([]);
    expect(parseFallbackModelArgs([])).toEqual([]);
  });

  test("场景5b：数组里的空项被丢弃", () => {
    expect(parseFallbackModelArgs(["a/M1", "", "  ", "b/M2"])).toEqual(["a/M1", "b/M2"]);
  });
});

describe("Task #4724 — buildModelAgentContext（多模型接线）", () => {
  test("场景1：单模型 → 走 fallbackModel（向后兼容，字段名不变）", () => {
    const ctx = buildModelAgentContext({
      model: "opencodego/primary",
      fallbackModel: "opencodego/backup",
    });
    expect(ctx.model).toBe("opencodego/primary");
    expect(ctx.fallbackModel).toBe("opencodego/backup");
    // 单值不产生数组字段（避免与旧代码语义冲突）
    expect("fallbackModels" in ctx).toBe(false);
  });

  test("场景2：多模型（逗号字符串）→ 产出 fallbackModels 数组", () => {
    const ctx = buildModelAgentContext({
      fallbackModel: "a/M1,b/M2,c/M3",
    });
    expect(ctx.fallbackModels).toEqual(["a/M1", "b/M2", "c/M3"]);
  });

  test("场景2b：多模型（yargs 数组）→ 产出 fallbackModels 数组", () => {
    const ctx = buildModelAgentContext({
      fallbackModel: ["a/M1", "b/M2"] as any,
    });
    expect(ctx.fallbackModels).toEqual(["a/M1", "b/M2"]);
  });

  test("场景2c：多模型时不再产出单值 fallbackModel（避免两处语义打架）", () => {
    const ctx = buildModelAgentContext({ fallbackModel: "a/M1,b/M2" });
    expect("fallbackModel" in ctx).toBe(false);
    expect(ctx.fallbackModels).toEqual(["a/M1", "b/M2"]);
  });

  test("场景5：都不给 → 空对象（不产生 undefined key）", () => {
    const ctx = buildModelAgentContext({});
    expect(ctx).toEqual({});
    expect("model" in ctx).toBe(false);
    expect("fallbackModel" in ctx).toBe(false);
    expect("fallbackModels" in ctx).toBe(false);
  });

  test("场景5b：空字符串视同未提供", () => {
    const ctx = buildModelAgentContext({ model: "", fallbackModel: "" });
    expect(ctx).toEqual({});
  });

  test("场景5c：只有一个逗号 → 等同未提供（不产生空数组 key）", () => {
    const ctx = buildModelAgentContext({ fallbackModel: "," });
    expect("fallbackModels" in ctx).toBe(false);
    expect("fallbackModel" in ctx).toBe(false);
  });
});

describe("Task #4724 — 非法显式兜底值的校验（review2 MINOR-1/MINOR-2）", () => {  test("合法值 → 不报非法", () => {
    expect(findInvalidFallbackModels(["a/M1", "b/M2", "bareModelId"])).toEqual([]);
  });

  test("非法值：只有 provider 前缀、modelId 为空 → 被检出", () => {
    expect(findInvalidFallbackModels(["provider/"])).toEqual(["provider/"]);
    expect(findInvalidFallbackModels(["a/M1", "provider/"])).toEqual(["provider/"]);
  });

  test("报错文案包含非法项与格式提示", () => {
    const msg = formatInvalidFallbackModelError(["provider/"]);
    expect(msg).toContain("provider/");
    expect(msg).toContain("providerId/modelId");
  });

  test("checkFallbackModelArg：合法值 → 返回 true", () => {
    expect(checkFallbackModelArg({ fallbackModel: "a/M1,b/M2" })).toBe(true);
    expect(checkFallbackModelArg({})).toBe(true);
    expect(checkFallbackModelArg({ fallbackModel: "" })).toBe(true);
  });

  test("checkFallbackModelArg：非法值 → 抛错（yargs 会在解析阶段退出）", () => {
    expect(() => checkFallbackModelArg({ fallbackModel: "provider/" })).toThrow(
      /--fallback-model 取值非法/,
    );
    expect(() =>
      checkFallbackModelArg({ fallbackModel: ["a/M1", "provider/"] }),
    ).toThrow(/--fallback-model 取值非法/);
  });

  test("★ 四个命令都挂了 .check(checkFallbackModelArg)（非法值在解析阶段就退出）", async () => {
    // 用真实的 yargs 走一遍：非法值应该让 parse 失败，而不是静默放行。
    //
    // ⚠️ yargs 的 `.check()` 失败时默认调用 `process.exit(1)`（不抛异常），
    //   所以测试里用 `.fail()` 捕获消息，否则进程会直接被杀掉。
    const yargsLib = (await import("yargs")).default as any;
    const { RunCommand } = await import("./interactive.js");
    const { InteractiveCommand } = await import("./run.js");
    const { ChatCommand } = await import("./chat.js");

    // act.ts 的 builder 结构与其它命令不同，用源码契约锁。
    const src = await readSrc("act.ts");
    expect(src).toContain(".check(checkFallbackModelArg)");

    // 其余三个命令：builder 里**已经**挂了 .check，直接用真实 yargs 验证
    // 非法值会让 parse 失败。
    for (const builder of [RunCommand.builder, InteractiveCommand.builder, ChatCommand.builder]) {
      let captured = "";
      const y: any = yargsLib(["cmd", "--fallback-model", "provider/"]);
      const built = y
        .command("cmd", "cmd", (b: any) => builder(b))
        .fail((msg: string, err: Error) => {
          captured = msg || err?.message || "";
        });
      await built.parse();
      expect(captured).toMatch(/--fallback-model 取值非法/);
    }
  });
});

describe("Task #4724 — #4638 review 接线覆盖缺口（四个命令都要锁住）", () => {
  /**
   * act.ts / interactive.ts / run.ts 的接线此前**没有测试覆盖** ——
   * review 亲验过：把 `buildModelAgentContext(args)` 里的 fallbackModel
   * 删掉，现有测试不会变红。这里用「源码契约」把它们锁住。
   */
  test("act.ts：把 fallbackModel 透传给 buildModelAgentContext", async () => {
    const src = await readSrc("act.ts");
    expect(src).toContain("buildModelAgentContext(args)");
  });

  test("interactive.ts：两处接线都透传 options（含 fallbackModel）", async () => {
    const src = await readSrc("interactive.ts");
    expect(src).toContain("buildModelAgentContext(options)");
    // 两处（handleQuery + RunTui 流式路径）都要有
    const occurrences = src.split("buildModelAgentContext(options)").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  test("run.ts：modelFlags 透传 fallbackModel", async () => {
    const src = await readSrc("run.ts");
    expect(src).toContain(
      "modelFlags: { model: args.model, fallbackModel: args.fallbackModel }",
    );
  });

  test("chat.ts：走 buildModelAgentContext(options)", async () => {
    const src = await readSrc("chat.ts");
    expect(src).toContain("buildModelAgentContext(options)");
  });

  test("四个命令的 --fallback-model describe 一致", async () => {
    const { RunCommand } = await import("./interactive.js");
    const { InteractiveCommand } = await import("./run.js");
    const { ChatCommand } = await import("./chat.js");

    function describeOf(builder: any): string {
      let captured = "";
      const yargs: any = {
        option(name: string, config: any) {
          if (name === "fallback-model") captured = config?.describe ?? "";
          return yargs;
        },
        positional(_n: string, _c: any) {
          return yargs;
        },
        // ★ Task #4724：命令 builder 现在多了 .check(checkFallbackModelArg)
        check(_fn: any) {
          return yargs;
        },
      };
      builder(yargs);
      return captured;
    }

    expect(describeOf(RunCommand.builder)).toBe(FALLBACK_MODEL_DESCRIBE);
    expect(describeOf(InteractiveCommand.builder)).toBe(FALLBACK_MODEL_DESCRIBE);
    expect(describeOf(ChatCommand.builder)).toBe(FALLBACK_MODEL_DESCRIBE);
  });

  test("act.ts 用同一份 describe 文案", async () => {
    const src = await readSrc("act.ts");
    expect(src).toContain("describe: FALLBACK_MODEL_DESCRIBE");
    expect(src).toContain("describe: MODEL_DESCRIBE");
  });
});

describe("Task #4724 — yargs 参数解析（真实 argv 形态）", () => {
  /**
   * 用真实的 yargs 解析一遍，确认：
   * - `--fallback-model a,b,c` → 字符串 "a,b,c"（不是数组）
   * - `--fallback-model a --fallback-model b` → 数组 ["a","b"]
   * - 两种形态都被 parseFallbackModelArgs 正确归一
   *
   * ⚠️ 为什么**不用** `array: true`：实测 yargs 的 `array: true` 会把
   * 位置参数 `act [message]` 一起吞掉（`--fallback-model X "hello"` →
   * message 变 undefined、fallbackModel 变成 ["X","hello"]），
   * 直接破坏 `roy-bot act "hi" --fallback-model X` 这个最常用形态。
   * 所以保持 `type: "string"`，由 parseFallbackModelArgs 二次拆分。
   */
  async function parseArgv(argv: string[]): Promise<any> {
    const yargsLib = (await import("yargs")).default as any;
    return yargsLib(argv)
      .command("act [message]", "act", (b: any) =>
        b.positional("message", { type: "string" }).option("fallback-model", {
          type: "string",
        }),
      )
      .parse();
  }

  test("逗号语法：位置参数不丢，fallbackModel 是字符串", async () => {
    const argv = await parseArgv(["act", "hello", "--fallback-model", "a/M1,b/M2"]);
    expect(argv.message).toBe("hello");
    expect(argv["fallback-model"]).toBe("a/M1,b/M2");
    expect(parseFallbackModelArgs(argv["fallback-model"])).toEqual(["a/M1", "b/M2"]);
  });

  test("重复传语法：位置参数不丢，fallbackModel 是数组", async () => {
    const argv = await parseArgv([
      "act",
      "hello",
      "--fallback-model",
      "a/M1",
      "--fallback-model",
      "b/M2",
    ]);
    expect(argv.message).toBe("hello");
    expect(parseFallbackModelArgs(argv["fallback-model"])).toEqual(["a/M1", "b/M2"]);
  });

  test("flag 在位置参数之前：位置参数依然不丢", async () => {
    const argv = await parseArgv(["act", "--fallback-model", "a/M1", "hello"]);
    expect(argv.message).toBe("hello");
    expect(parseFallbackModelArgs(argv["fallback-model"])).toEqual(["a/M1"]);
  });
});
