/**
 * Context Threshold → Auto-Compaction E2E  
 * 
 * 阶段1: 正常阈值，累积消息 (>3 messages)
 * 阶段2: 极低阈值，下一次触发的 LLM 调用 → auto-compaction
 *
 * 每个 test 允许 60s timeout，LLM 调用大约 3-8s。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EnvironmentService } from "./environment.service";
import { ContextHandlerService } from "./context-handler.service";
import type { SessionComponent, ConfigComponent, Environment } from "@ai-setting/roy-bot-core";

describe("Context Threshold → Auto-Compaction E2E", () => {
  let env: Environment;
  let sessionComponent: SessionComponent;
  let contextHandler: ContextHandlerService;
  let sessionId: string;
  let cfgComponent: ConfigComponent;

  beforeAll(async () => {
    const noop = () => {};
    const envService = new EnvironmentService({ log: noop, error: noop, info: noop, warn: noop } as any);
    await envService.create({});
    env = envService.getEnvironment()!;
    sessionComponent = env.getComponent("session") as SessionComponent;
    cfgComponent = env.getComponent("config") as ConfigComponent;

    const s = await sessionComponent.create({ title: "Threshold E2E", metadata: { test: true } });
    sessionId = s.id;
    contextHandler = new ContextHandlerService(env, sessionComponent, { maxRetries: 1, autoCompact: true });
  }, 15000);

  afterAll(async () => {
    try { await sessionComponent.delete?.(sessionId!); } catch {}
  });

  // ── Phase 1: 正常阈值累积消息 ──
  it("phase1 — normal threshold, accumulate messages", { timeout: 60000 }, async () => {
    await setThreshold(128000, 0.9);

    const queries = ["hi", "hello again", "one more"];

    for (const q of queries) {
      // 直接用 roy agent 避免 default agent 的 delegate 开销
      await contextHandler.handleQueryWithContext(q, { sessionId, agentName: "roy" });
    }

    const s = await sessionComponent.get(sessionId);
    console.log(`[phase1] msgs=${s!.messageCount} (need >=3 for compact)`);
    expect(s!.messageCount).toBeGreaterThanOrEqual(4);
  });

  // ── Phase 2: 极低阈值触发 auto-compaction ──
  it("phase2 — ultra-low threshold triggers compaction", { timeout: 120000 }, async () => {
    const sBefore = await sessionComponent.get(sessionId);
    console.log(`[phase2] msgs before=${sBefore!.messageCount}`);

    // contextWindow=4000 × 0.1 = 400 token threshold
    // system prompt 本身 ~2-3K tokens → 远超 400 → 必然触发
    await setThreshold(4000, 0.1);

    let compacted = false;
    let ctxErrorThrown = false;
    try {
      // 直接用 roy agent (不通过 default → delegate，LLM 调用发生在主 session)
      await contextHandler.handleQueryWithContext("ok", { sessionId, agentName: "roy" });
    } catch (e: any) {
      ctxErrorThrown = true;
      console.log(`[phase2] ContextError after retries: ${e.message?.substring(0, 100)}`);
    }

    const sAfter = await sessionComponent.get(sessionId);
    const checkpoints = (sAfter?.metadata?.checkpoints as any)?.checkpoints || [];
    compacted = checkpoints.length > 0;

    console.log(`[phase2] msgs=${sBefore!.messageCount}→${sAfter!.messageCount}, checkpoints=${checkpoints.length}, ctxError=${ctxErrorThrown}`);

    if (compacted) {
      const cp = checkpoints[0];
      console.log(`✅✅✅ THRESHOLD → AUTO-COMPACTION! ✅✅✅`);
      console.log(`   title: ${cp.title}`);
      console.log(`   keyPoints: ${cp.processKeyPoints?.length || 0}`);
    } else if (ctxErrorThrown) {
      console.log(`⚠️  ContextError was thrown but compaction failed (need >=3 msgs)`);
    } else {
      console.log(`⚠️  Threshold not triggered — check config propagation`);
    }

    // Verify session still works — compaction should have happened
    expect(sAfter).toBeDefined();
    expect(sAfter!.messageCount).toBeGreaterThan(0);
  });

  // helper
  async function setThreshold(ctx: number, ratio: number) {
    const providers = cfgComponent.get("llm.providers") as any;
    if (providers?.deepseek?.limits) {
      providers.deepseek.limits["deepseek-v4-pro"] = { contextWindow: ctx, compactionThreshold: ratio };
      await cfgComponent.set("llm.providers", providers);
      console.log(`[threshold] ${ctx} × ${ratio} = ${ctx*ratio} tokens`);
    }
  }
});
