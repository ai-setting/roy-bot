/**
 * @fileoverview Task #5125 P7.2 —— /model 热切换测试。
 *
 * ## 三层验证（对应摸底报告 docs/task-5125-p72-hot-model-recon.md）
 *
 * 1. **纯函数层**：`withRuntimeModelOverride` —— 运行时 override 赢过
 *    启动 `--model` flag；无 override 时 flag 原样透传。
 * 2. **接线层**：`createStreamHandleQuery` 的新可选参数 `runtimeModel`
 *    （getter 闭包）—— 每轮 execute 时**实时**求值 ⇒ 弹窗选择后
 *    下一条消息即用新模型。
 * 3. **内存层**：ConfigComponent.set("llm.defaultModel") → get() 立即
 *    读到新值 + watcher 收到事件（复用组件既有理念，core 零改动）。
 *
 * ⚠️ **隔离铁律**：第 3 层用 mkdtemp 临时 configPath，绝不触碰真实
 * ~/.roy-bot；event db 全部走 /tmp 注入口（Task #4588 契约）。
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { withRuntimeModelOverride } from "./model-flags.js";
import { createStreamHandleQuery, type RunOptions } from "./interactive.js";

// ---------------------------------------------------------------------------
// 1. 纯函数层 —— withRuntimeModelOverride
// ---------------------------------------------------------------------------

describe("P7.2 — withRuntimeModelOverride（纯函数）", () => {
  test("override 存在 ⇒ 赢过启动 --model flag", () => {
    const r = withRuntimeModelOverride(
      { model: "flag/old-model", fallbackModel: "flag/backup" },
      "hot/new-model",
    );
    expect(r.model).toBe("hot/new-model");
    // fallback 等其余字段原样保留
    expect(r.fallbackModel).toBe("flag/backup");
  });

  test("override 为 undefined ⇒ 原样透传（flag 生效）", () => {
    const r = withRuntimeModelOverride({ model: "flag/only" }, undefined);
    expect(r.model).toBe("flag/only");
  });

  test("无 flag 且无 override ⇒ 不产生 model key（不污染 context）", () => {
    const r = withRuntimeModelOverride({}, undefined);
    expect("model" in r).toBe(false);
    const r2 = withRuntimeModelOverride({}, "hot/new-model");
    expect(r2.model).toBe("hot/new-model");
  });
});

// ---------------------------------------------------------------------------
// 2. 接线层 —— createStreamHandleQuery 的 runtimeModel getter
// ---------------------------------------------------------------------------

function makeContextCapturingExecutor() {
  const captured: { context: any } = { context: undefined };
  return {
    captured,
    setChunkCallback() {},
    async execute(
      _message: string,
      _sessionId: string,
      _opts: any,
      _traceId: any,
      agentContext: any,
    ) {
      captured.context = agentContext;
      return "reply";
    },
  };
}

describe("P7.2 — createStreamHandleQuery 每轮实时读 runtimeModel", () => {
  const baseOptions = {
    model: "flag/old-model",
    reasoning: false,
    // Task #4588 测试注入口：绝不写真实 event-store.db
    triggerEventDbPath: "/tmp/task5125-event-store-test.db",
  } as unknown as RunOptions;

  test("弹窗选择后（getter 返回新值）⇒ 下一轮 context.model = 新模型", async () => {
    const exec = makeContextCapturingExecutor();
    let current = "hot/new-model";
    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      baseOptions,
      undefined,
      undefined,
      () => current,
    );
    await query("hi", () => {});
    expect(exec.captured.context?.model).toBe("hot/new-model");
  });

  test("getter 返回 undefined ⇒ 回落启动 --model flag", async () => {
    const exec = makeContextCapturingExecutor();
    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      baseOptions,
      undefined,
      undefined,
      () => undefined,
    );
    await query("hi", () => {});
    expect(exec.captured.context?.model).toBe("flag/old-model");
  });

  test("不传 runtimeModel（旧调用方）⇒ 行为与 main 完全一致", async () => {
    const exec = makeContextCapturingExecutor();
    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      baseOptions,
      undefined,
      undefined,
    );
    await query("hi", () => {});
    expect(exec.captured.context?.model).toBe("flag/old-model");
    expect(exec.captured.context?.fallbackModel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. 内存层 —— ConfigComponent.set 立即生效 + watcher 收到事件
// ---------------------------------------------------------------------------

describe("P7.2 — config 内存层热更新（core 既有理念，隔离 HOME）", () => {
  test("config.set('llm.defaultModel') ⇒ get() 立即读到 + watcher 触发", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "p72-mem-"));
    const configPath = path.join(tmp, "config.jsonc");
    await fs.writeFile(
      configPath,
      JSON.stringify({ llm: { defaultModel: "old/m1", defaultProvider: "old" } }),
    );
    try {
      const { EnvironmentService } = await import("../services/environment.service.js");
      const { OutputService } = await import("../services/output.service.js");
      const output = new OutputService();
      output.configure({ quiet: true });
      const envService = new EnvironmentService(output);
      await envService.create({ configPath, sessionStorage: { type: "memory" } });
      try {
        const env = envService.getEnvironment();
        const config = env?.getComponent("config") as any;
        expect(config).toBeDefined();

        // watcher 注册（llm.* 通配 —— 与 llm.ts:553 同款）
        const events: any[] = [];
        const unwatch = config.watch("llm.*", (e: any) => events.push(e));

        // 内存层写入（不重启、不重读文件）
        await config.set("llm.defaultModel", "hot/new-model");
        await config.set("llm.defaultProvider", "hot");

        expect(config.get("llm.defaultModel")).toBe("hot/new-model");
        expect(config.get("llm.defaultProvider")).toBe("hot");

        const keys = events.map((e) => e.key);
        expect(keys).toContain("llm.defaultModel");
        expect(keys).toContain("llm.defaultProvider");
        unwatch?.();
      } finally {
        await envService.dispose();
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
