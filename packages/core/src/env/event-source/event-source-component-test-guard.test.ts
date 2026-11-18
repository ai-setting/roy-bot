/**
 * EventSourceComponent.saveConfig() 测试环境守卫测试（Task #5181）
 *
 * 背景（11-07 事故）：测试中实例化 EventSourceComponent 并触发 saveConfig()
 * 会覆盖生产 ~/.roy-bot/event-sources.json（10 个真实事件源配置差点丢失）。
 *
 * 守卫设计：
 *   - 测试环境（NODE_ENV=test 或 BUN_TEST_WORKER_ID 存在）⇒ persistenceEnabled=false
 *     （只内存不落盘），除非显式设置 ROY_AGENT_ES_PERSISTENCE=1 opt-out
 *   - 守卫自身可测：opt-out 后落盘行为恢复
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventSourceComponent } from "./event-source-component";
import type { EventSourceConfig } from "./types";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

describe("EventSourceComponent.saveConfig() 测试环境守卫 (Task #5181)", () => {
  let tempHome: string;
  let origHome: string;
  let origNodeEnv: string | undefined;
  let origOptOut: string | undefined;

  beforeEach(() => {
    // 隔离 HOME：saveConfig 落盘路径 = $HOME/.roy-bot/event-sources.json
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "roy-es-guard-5181-"));
    origHome = process.env.HOME ?? "";
    process.env.HOME = tempHome;
    origNodeEnv = process.env.NODE_ENV;
    origOptOut = process.env.ROY_AGENT_ES_PERSISTENCE;
    delete process.env.ROY_AGENT_ES_PERSISTENCE;
    // 模拟 bun test 环境（守卫触发条件之一）
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origOptOut === undefined) delete process.env.ROY_AGENT_ES_PERSISTENCE;
    else process.env.ROY_AGENT_ES_PERSISTENCE = origOptOut;
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  function makeComponent(): EventSourceComponent {
    const component = new EventSourceComponent();
    (component as any).registerBuiltInHandlers();
    return component;
  }

  const config: EventSourceConfig = {
    id: "es-guard-1",
    name: "Guard Timer",
    type: "timer",
    enabled: true,
    interval: 1000,
  };

  test.skipIf(isParallelRun)(
    "测试环境(NODE_ENV=test)下 register→saveConfig 不落盘",
    async () => {
      const component = makeComponent();
      component.register(config); // register 内部触发 saveConfig
      // 等待 fire-and-forget 的 saveConfig promise
      await new Promise((r) => setTimeout(r, 50));

      const target = path.join(tempHome, ".roy-bot", "event-sources.json");
      expect(fs.existsSync(target)).toBe(false);
      // 内存中仍然存在（守卫不影响内存行为）
      expect(component.get("es-guard-1")).toBeDefined();
      expect((component as any).persistenceEnabled).toBe(false);
    },
  );

  test.skipIf(isParallelRun)(
    "BUN_TEST_WORKER_ID 存在时同样不落盘",
    async () => {
      process.env.NODE_ENV = "production";
      (process.env as any).BUN_TEST_WORKER_ID = "1";
      try {
        const component = makeComponent();
        component.register(config);
        await new Promise((r) => setTimeout(r, 50));
        const target = path.join(tempHome, ".roy-bot", "event-sources.json");
        expect(fs.existsSync(target)).toBe(false);
      } finally {
        delete (process.env as any).BUN_TEST_WORKER_ID;
      }
    },
  );

  test.skipIf(isParallelRun)(
    "显式 opt-out（ROY_AGENT_ES_PERSISTENCE=1）时守卫放行，正常落盘",
    async () => {
      process.env.ROY_AGENT_ES_PERSISTENCE = "1";
      const component = makeComponent();
      component.register(config);
      await new Promise((r) => setTimeout(r, 50));
      const target = path.join(tempHome, ".roy-bot", "event-sources.json");
      expect(fs.existsSync(target)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
      expect(parsed.sources).toHaveLength(1);
      expect(parsed.sources[0].id).toBe("es-guard-1");
      expect((component as any).persistenceEnabled).toBe(true);
    },
  );

  test.skipIf(isParallelRun)(
    "非测试环境（NODE_ENV=production）守卫不介入，正常落盘",
    async () => {
      process.env.NODE_ENV = "production";
      const component = makeComponent();
      component.register(config);
      await new Promise((r) => setTimeout(r, 50));
      const target = path.join(tempHome, ".roy-bot", "event-sources.json");
      expect(fs.existsSync(target)).toBe(true);
      expect((component as any).persistenceEnabled).toBe(true);
    },
  );
});
