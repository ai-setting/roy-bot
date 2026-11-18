/**
 * @fileoverview 回放测试 runner (Task #4933)
 *
 * 建一个**最小但真实**的 Environment（只含 config/llm/agent/prompt 组件），
 * 然后对本仓库的真实 session 做回放压缩。
 *
 * 用法：
 *   cd <worktree>
 *   bun run packages/core/src/env/session/__bench__/run-replay.ts \
 *     --session <sessionId> [--limit N]
 *
 * 也可以一次跑多个：
 *   bun run .../run-replay.ts --sessions id1,id2,id3 --limit 800
 */

import * as path from "path";
import * as fsSync from "fs";
import * as os from "os";

import { BaseEnvironment } from "../../environment";
import { ConfigComponent } from "../../../config/config-component";
import { LLMComponent } from "../../llm/llm";
import { AgentComponent } from "../../agent/agent-component";
import { PromptComponent } from "../../prompt/prompt-component";
import { ToolComponent } from "../../tool/tool-component";
import { SessionComponent } from "../session-component";
import { AgentRegistry } from "../../agent/agent-registry";

import { replay, type ReplayResult } from "./replay-compact";

// ============================================================================
// CLI args
// ============================================================================

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

// ============================================================================
// 构建真实组件栈
// ============================================================================

async function bootstrap(configComponent: ConfigComponent) {
  const env = new BaseEnvironment({ name: "replay-bench", version: "1.0.0" });

  // LLM
  const llmComponent = new LLMComponent();
  const configDir = path.join(process.env.HOME || "/tmp", ".roy-bot");
  await llmComponent.init({
    name: "llm",
    version: "1.0.0",
    enabled: true,
    env,
    options: {
      configComponent,
      configPath: "config.jsonc",
    },
  });

  // Prompt
  const promptComponent = new PromptComponent();
  await promptComponent.init({
    name: "prompt",
    version: "1.0.0",
    enabled: true,
    env,
    options: { configComponent },
  });

  // Tool（compact/compact-hint 现在无工具，但仍需组件存在）
  const toolComponent = new ToolComponent();
  await toolComponent.init({
    name: "tool",
    version: "1.0.0",
    enabled: true,
    env,
    options: { configComponent },
  });

  // Agent
  const agentComponent = new AgentComponent();
  await agentComponent.init({
    name: "agent",
    version: "1.0.0",
    enabled: true,
    env,
    options: { configComponent },
  });

  // ★ 关键：把组件注册到 env，否则 agentComponent.refreshDependencies()
  //   拿不到 llm（env.getComponent("llm") 返回 undefined）→ 走 Mock response 分支。
  //   与 packages/cli/src/services/environment.service.ts:558-562 同序。
  env.registerComponent(configComponent);
  env.registerComponent(llmComponent);
  env.registerComponent(toolComponent);
  env.registerComponent(promptComponent);
  env.registerComponent(agentComponent);

  return agentComponent;
}

// ============================================================================
// main
// ============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = args.limit ? parseInt(args.limit, 10) : undefined;

  const sessionIds = args.sessions
    ? args.sessions.split(",").map((s) => s.trim()).filter(Boolean)
    : args.session
      ? [args.session]
      : [];

  const skipResume = args["skip-resume"] === "true";
  const legacyMode = args.legacy === "true";
  const resumeQuestion = args.question;

  if (sessionIds.length === 0) {
    console.error(
      "usage: bun run run-replay.ts --session <id> | --sessions <id1,id2> " +
      "[--limit N] [--skip-resume] [--legacy] [--question \"...\"]"
    );
    process.exit(1);
  }

  const results: ReplayResult[] = [];
  for (const sid of sessionIds) {
    console.log(`\n=== Replaying session ${sid} (limit=${limit ?? "all"}) ===`);
    const t0 = Date.now();
    try {
      const r = await replay({
        sessionId: sid,
        limit,
        bootstrapAgentComponent: bootstrap,
        skipResume,
        resumeQuestion,
        legacyCheckpoint: legacyMode
          ? {
              title: "旧格式 checkpoint（存量适配验证）",
              summary: "Process: 已完成配置读取与模型选型\nState: 正在做压缩链路改造",
              processKeyPoints: [
                "读取 ~/.roy-bot/config.jsonc 的 session.compactModel = minimax/MiniMax-M3.1-Flash",
                "确认 run option 覆盖 agent yaml model 的优先级路径",
                "发现 compact-hint agent 缺少 model 字段导致落到 GLM 链",
              ],
              currentState:
                "正在改造两阶段压缩：Phase1 hint 纯文本直出、Phase2 整段自然语言 checkpoint。待跑回归测试。",
              nextSteps: [
                "跑 bun test packages/core/src/env/session/ --parallel 4",
                "用真实 session 回放验证压缩后 resume",
              ],
              userIntents: ["把压缩机制改成配置化 + 去结构化 + 可 resume"],
            }
          : undefined,
      });
      results.push(r);
      console.log(
        `  OK  total=${(r.totalMs / 1000).toFixed(1)}s ` +
          `(p1=${(r.phase1Ms / 1000).toFixed(1)}s p2=${(r.phase2Ms / 1000).toFixed(1)}s) ` +
          `msgs=${r.replayedMessages} ` +
          `hint=${r.hintLength}ch ` +
          `cp(title=${r.checkpoint.title ? "Y" : "N"} ` +
          `content=${r.checkpoint.contentLength}ch ` +
          `forgedSections=${r.checkpoint.hasForgedSectionHeaders ? "YES" : "no"})`
      );
    } catch (e) {
      console.error(`  FAIL: ${e instanceof Error ? e.message : String(e)}`);
      results.push({
        sessionId: sid,
        totalMessagesInSession: 0,
        replayedMessages: 0,
        inputChars: 0,
        compactModel: "",
        phase1Ms: 0,
        phase2Ms: 0,
        totalMs: Date.now() - t0,
        hint: "",
        hintLength: 0,
        hintInjected: false,
        hintOverlapTokens: 0,
        checkpoint: {
          title: "",
          contentLength: 0,
          contentPreview: "",
          hasForgedSectionHeaders: false,
        },
        checkpointMessagePreview: "",
        resume: null,
        errors: [e instanceof Error ? e.message : String(e)],
      } as ReplayResult);
    }
  }

  // 输出 JSON
  const outPath = path.join(
    os.tmpdir(),
    `roy-compact-replay-${Date.now()}.json`
  );
  fsSync.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n=== Results written to ${outPath} ===`);
  console.log(JSON.stringify(results, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
