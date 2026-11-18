/**
 * Task #5144 — ES-M1 实跑验证（deepseek-v4-flash-s1：DeepSeek 网关会回缓存字段）
 *
 * 同一 chat-keyed session 连续 3 条飞书事件，对比 legacy vs lean：
 *   - system prompt：lean = agent base + buildLarkChannelSystemPrompt；
 *     legacy = agent base（规则文本在每条 user message 的长模板里）
 *   - prompt_cache_key = sessionId（与生产 invoke.ts 一致）
 *
 * 期望（方案 §3 估算）：
 *   - legacy：turn2/turn3 的 prompt_tokens 每轮多 ~1566 tok（长模板重复）
 *   - lean：turn2/turn3 新增 input 显著更小；若网关回 cached_tokens 则
 *     turn2/turn3 有 cache 命中读数
 *
 * 运行：bun run scripts/m1-cache-verify.ts
 */

import { invoke } from "../packages/core/src/env/llm/invoke";
import {
  buildLarkRecommendedAction,
  buildLarkChannelSystemPrompt,
} from "../packages/core/src/env/event-source/event-source-handlers";

const auth = JSON.parse(await Bun.file(process.env.HOME + "/.roy-bot/auth.json").text());
const tong = auth.providers.tong;

// ★ Task #5144 复测：M1_PROVIDER=minimax 走 MiniMax 官方 API
//   （MINIMAX_CN_API_KEY + api.minimaxi.com，usage 原生回
//   prompt_tokens_details.cached_tokens）。默认仍为 tong。
const useMinimax = (process.env.M1_PROVIDER ?? "") === "minimax";
const MODEL_ID = useMinimax
  ? (process.env.M1_MODEL ?? "MiniMax-M3.1-Flash")
  : (process.env.M1_MODEL ?? "deepseek-v4-flash-s1");
const MODEL = `openai-compatible/${MODEL_ID}`;
const apiKey = useMinimax ? process.env.MINIMAX_CN_API_KEY! : tong.apiKey;
const baseURL = useMinimax ? "https://api.minimaxi.com/v1" : tong.baseURL;
const SESSION_ID = "es_m1_cache_verify_session_fixed_001";

/** 模拟 agent base system prompt（固定行） */
const AGENT_BASE_SYSTEM = [
  "You are Roy, an AI assistant.",
  "## 环境\n- 工作目录 ~/work/demo",
  "## 工具\n- bash: run shell commands",
].join("\n");

/** 构造一条飞书事件的 user message（生产形态 payload.message） */
function buildEventMessage(mode: "legacy" | "lean", i: number): string {
  const rawData = {
    type: "im.message.receive_v1",
    event_id: `evt_${i}`,
    event: {
      header: { event_type: "im.message.receive_v1", app_id: "cli_app123" },
      message: {
        message_id: `om_verify_${i}`,
        chat_id: "oc_verify_chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: `第 ${i} 条测试消息，请简短回复 ok-${i}` }),
      },
      sender: { sender_id: { open_id: "ou_user_001" } },
    },
  };
  const profile = "tong";
  const recommendedAction =
    mode === "legacy"
      ? buildLarkRecommendedAction({
          profile,
          chatType: "group",
          appId: "cli_app123",
          chatId: "oc_verify_chat",
          messageId: `om_verify_${i}`,
        })
      : {
          action:
            `处理飞书群聊消息并回复。回复规范见 system prompt「⭐ 飞书回复规范（system prompt 注入版）」章节。\n` +
            `scope: 群聊消息；回复到 replyTo.chatId。如需 @发件人，用结构化 at 节点 {"tag":"at","user_id":"<senderId>"}（不要写 <at> 文本标签）。\n` +
            `replyTo 的 profile/chatId/messageId 是本轮唯一权威定位；其余回复规则（发送命令模板、长度上限、发送纪律等）全部见 system prompt 上述章节。`,
          replyTo: {
            appId: "cli_app123",
            profile,
            chatId: "oc_verify_chat",
            messageId: `om_verify_${i}`,
          },
          staticRulesInSystemPrompt: true,
        };
  return JSON.stringify({ rawData, recommendedAction });
}

async function runRound(mode: "legacy" | "lean") {
  const systemPrompt =
    mode === "lean"
      ? AGENT_BASE_SYSTEM + "\n\n" + buildLarkChannelSystemPrompt({ profile: "tong" })
      : AGENT_BASE_SYSTEM;

  const usages: any[] = [];
  const history: { role: string; content: string }[] = [];

  for (let i = 1; i <= 3; i++) {
    history.push({ role: "user", content: buildEventMessage(mode, i) });
    const result = await invoke(
      { model: MODEL, apiKey, baseURL },
      {
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
        ],
        temperature: 0.7,
        maxTokens: 50,
        cacheRetention: "long",
        context: { sessionId: SESSION_ID },
      } as any,
      { abort: undefined },
    );
    let parsed: any = {};
    try { parsed = JSON.parse((result as any).result); } catch { /* {} */ }
    usages.push(parsed.usage ?? {});
    history.push({ role: "assistant", content: parsed.content || "ok" });
    await new Promise((r) => setTimeout(r, 400));
  }
  return usages;
}

console.log(`provider: ${useMinimax ? "minimax(official)" : "tong"}/${MODEL_ID}  baseURL=${baseURL}`);
console.log(`prompt_cache_key: ${SESSION_ID}`);
const legacyUsages = await runRound("legacy");
console.log(`=== legacy（旧版：每条事件 4.4KB 长模板进 user message）===`);
legacyUsages.forEach((u, i) => console.log(`  turn ${i + 1}:`, JSON.stringify(u)));

const leanUsages = await runRound("lean");
console.log(`=== lean（ES-M1：规则前置 system prompt + 动态卡片）===`);
leanUsages.forEach((u, i) => console.log(`  turn ${i + 1}:`, JSON.stringify(u)));
