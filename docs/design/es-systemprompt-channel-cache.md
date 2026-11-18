# [ES-P1] ES 渠道信息前置 system prompt：调研 + 整改方案

> Task #5139 · review-only 调研（未改任何 src）· 2026-11-07
>
> 需求来源（用户 2026-11-07 10:35）：
> > 特定 eventsource handler 处理对应 es event 时，可以支持往要调用的 agent 的
> > systemprompt 添加特定的渠道信息。后续同一渠道的 event 进来 handle 时，
> > 可以 cache 住，不用重新构建 systemprompt，保持 LLM cache。
> > 好处：飞书 event 构建的 recommendedAction 每次重复注入这些 token 有效率问题。
> > 共通部分可以提前注入 system prompt。

---

## 1. 目标形态（一句话）

**渠道级「共通静态规则」（回复命令模板、结构约定、禁令）一次性注入
systemPrompt 并随 session-scope cacheSnapshot 冻结；per-event 只留
「动态定位信息」（chatId / messageId / senderId / 消息正文），
体量从 ~1566 tok/event 压到 ~100 tok/event。**

---

## 2. 现状证据（file:line）

### 2.1 ES event → agent 调用链（lark-cli 渠道）

```
lark-cli event consume (子进程 stdout 行)
  └─ LarkCliInstance.handleEvent()          event-source-handlers.ts:1681
      ├─ extractMetadata()                  :396   ← 生成 metadata + replyChannel
      │   └─ buildLarkRecommendedAction()   :225   ← ~4486 chars 模板（见 §2.3）
      ├─ message = JSON.stringify({ rawData, recommendedAction, triggerEventId })
      │                                     :1904  ← 整包进 user message
      ├─ EnvEvent = { type: "event-source.event.lark-cli", payload, metadata }
      └─ this.eventHandler?.(evt)           :2035
          └─ EventHandler.handleEvent()     cli/event-handler.ts:757
              └─ formatEvent() → enqueue → onEventWithEnv
                  └─ handleEventMessageWithEnv()   run.ts:1119 / run-headless-dispatch.ts:117
                      ├─ agentContext.systemPrompt = envEvent.metadata?.systemPrompt
                      │                                run.ts:1213 / run-headless-dispatch.ts:198
                      └─ executeInternal → QueryExecutor.execute
                          └─ context.metadata.systemPrompt    query-executor.ts:592-600
                              （优先级：event-time > --es preload > 无）
                              └─ AgentComponent._run
                                  ├─ ES prompt 追加      agent-component.ts:1560-1571
                                  └─ cacheSnapshot 冻结  :2564-2680 (Task #2744)
```

### 2.2 systemPrompt 现在怎么拼（两条来源）

| 来源 | 注入点 | 内容 | 现状 |
|---|---|---|---|
| **A. 用户配置** `EventSourceConfig.systemPrompt` | bounty-im：`getCurrentSystemPrompt()` bounty-im-handler.ts:452-460，每次消息事件调用 `resolveBountyIMSystemPrompt()` (:759) | 用户 prompt 或 `buildDefaultBountyIMSystemPrompt()` 默认模板（~15 行，含 email/imServerUrl 插值） | 每次事件**重建**字符串，但内容对同一渠道是稳定的 |
| **A'. lark-cli 渠道** | **没有** event-time systemPrompt。metadata.systemPrompt 恒 undefined（event-source-handlers.ts 中 grep systemPrompt 仅出现在 bounty-im 相关注释） | — | lark 渠道信息全靠 recommendedAction 塞 user message |
| **B. `--es` preload** | `collectEventSourceSystemPrompts()` collect-event-source-system-prompts.ts:65 + `joinResolvedSystemPrompts()` :84 | 同一 resolve 逻辑，启动时收集一次 | run.ts:2896 / interactive.ts:470，已在启动时做了一次（Phase 3） |

### 2.3 per-event 重复 token 在哪、多大体量

**① recommendedAction（lark，最大头）**

- 生成：`buildLarkRecommendedAction()` event-source-handlers.ts:225-375
- 量化（对模板字面量实测）：
  - **4486 chars / 模板**；其中静态（与事件无关）4381 chars，插值只有
    `profile / chatType(chatId/messageId/appId 用于 replyTo 结构)`
  - 粗略 token 估算：1271 个 CJK × ~0.6 + ASCII × ~0.25 ≈ **1566 tokens/条事件**
- 进入 LLM 的路径：`JSON.stringify({ rawData, recommendedAction, triggerEventId })`
  （:1904）→ payload.message → `EventMessageFormatter.formatEventSourceEvent()`
  （event-message-formatter.ts:463，`[${sourceType}] ${message}`）→ user message。
- **每条飞书消息都全量重复注入**，且作为历史消息**永久占据**后续每轮的
  上下文（历史前缀虽可被 cache 覆盖，但：
  1. 多 session（chat-keyed session，不同群不同 session）每 session 冷启动一次
  2. prompt_cache_key 是 per-session（invoke.ts:597），跨 session 无效
  3. provider cache 通常有 TTL（如 24h/5min），长间隔重推重复计费）

**② notify 链路模板（task.background.* → 主 agent）**

- 生成：`buildNotifyHandlePrompt()` event-source-handlers.ts:2949-3040
- 量化：模板 ~936 chars ≈ **270 tokens/条通知**（其中 chatId/messageId/sender/
  profile/subSessionId 是动态的，静态章节约 60%）
- 特点：这模板**已经**按「渠道静态 + 动态定位」两段写，但全部进 user message。

**③ bounty-im recommendedAction（小头）**

- bounty-im-handler.ts:715-730：`action` 字符串含 server/email 插值 + 回复
  命令模板，~200-300 chars/条。

**④ rawData 原始事件 JSON**

- :1904 与 recommendedAction 一起 stringify。飞书事件本身（header/sender/
  message_id/content）约 500-1500 chars，其中真正有用的只有
  `chat_id / message_id / chat_type / sender / content`，
  header（app_id/tenant_key/event_id/…）对决策无贡献。

### 2.4 LLM prompt cache 机制（provider 端怎么命中）

roy-bot 已有的 cache 基建（Task #2748 §5.3-5.5 + Task #2744）：

| 机制 | 位置 | 说明 |
|---|---|---|
| Anthropic `cache_control` 断点 | invoke.ts:572-660 `convertToSDKMessages`：**system 消息** + **last user message** 各挂一个 ephemeral 断点 | 前缀 ≥1024 tok 才可 cache；≤4 断点 |
| OpenAI-compatible `prompt_cache_key` | llm-cache.ts:43-51（=sessionId，clamp 64 chars），invoke.ts:597 接入 | DeepSeek/GLM/minimax 靠这个 + 隐式前缀匹配 |
| session-scope cacheSnapshot | agent-component.ts:2564-2680（Task #2744）：primary agent 的 `resolvedSystemPrompt`（**含 ES prompt 追加后的最终值**）first-run 拍快照存 `session.metadata.cacheSnapshot`，后续 `_run` 字节级复用 | **systemPrompt 稳定性已经由 snapshot 保证**（含 {{memory}} 替换；Task #4813 mtime 失效检测） |

**命中条件的推论（方案的理论基础）**：

1. Cache 命中的充要条件是**前缀字节级一致**。system prompt 在消息序列最前，
   它稳定 → 所有轮次共享最长可 cache 前缀。
2. **ES prompt 已随 snapshot 冻结**：agent-component.ts:1560-1571 的追加发生在
   `_loadOrCreateCacheSnapshot` **之前**（:1608）→ 同一 session 内
   preload/event-time prompt 天然字节级稳定。**「同一渠道 event 进来不要重新
   构建 systemprompt」这一半需求，session-scope 已经满足了**——前提是
   prompt 内容确实不变（见 §4 失效边界）。
3. per-event 的大 token（recommendedAction）在 **user message** 位置：
   - 它前面只有 system + 历史 → 它自己是「本轮新增 token」，不可被前缀 cache
   - 它**写进历史后**，下一轮它变成历史前缀的一部分（可被 cache），但
     **冷启动 session / cache 过期后**全部重算计费
4. 把静态部分前移到 system prompt → 从「每事件重复的可变 user 尾巴」变成
   「一次性的 system 前缀」→ 在 cache 视角是纯收益。

### 2.5 现有资产盘点（方案可直接复用）

| 资产 | 位置 | 复用方式 |
|---|---|---|
| `collectEventSourceSystemPrompts` / `joinResolvedSystemPrompts` | collect-event-source-system-prompts.ts | **直接复用**；把渠道静态规则并入 resolve 函数 |
| `resolveBountyIMSystemPrompt` | bounty-im-handler.ts:266 | 已是「渠道静态 prompt」的正确形态 |
| cacheSnapshot 冻结 + mtime 失效 | agent-component.ts:2564 | 不动；渠道 prompt 走同一管道 |
| cache_control / prompt_cache_key 接线 | invoke.ts / llm-cache.ts | 不动 |
| lark 事件 metadata / replyChannel | extractMetadata :396 | 动态定位信息仍从这里来 |

---

## 3. 拆分规则（静态 vs 动态）

对每个渠道把 prompt 拆成两段：

### 渠道级静态（进 systemPrompt，每渠道一份，内容跨事件稳定）

| 内容 | 现在在哪 | 目标 |
|---|---|---|
| lark 回复结构规范（「关键 0/1/2」章节：只发一条结构化 post、30KB 上限、禁分段、禁 --reply-in-thread、--as bot、mktemp+jq 模板） | recommendedAction 模板主体（event-source-handlers.ts:225-375 的静态 4381 chars） | `buildLarkChannelSystemPrompt()` 新函数；字符数与现模板一致（这些规则与具体事件无关，插值只出现在开头 2-3 行） |
| lark profile 约定（openId per-app 隔离、「必须用 profile=X」） | profileWarn 插值 | 同上（profile 是**渠道配置**不是事件属性，per-channel 常量） |
| bounty-im 回复命令模板 + email 身份 + server URL | buildDefaultBountyIMSystemPrompt（已经是静态形态） | 已达标，不迁 |
| notify 处理的通用规范（怎么读 sub-agent 输出、回执语义、「不要 fallback 到 lastReplyChannel」） | buildNotifyHandlePrompt 静态章节 | 可选二期（见 §7 分期） |

### per-event 动态（留 user message / payload）

| 内容 | 目标体量 |
|---|---|
| 消息正文（rawData.content / sender / 时间） | 原样，~200-800 tok |
| 定位四元组：chatId / messageId / chatType / senderId（replyTo 结构） | **保留**，~50-100 tok。chatType 决定 p2p/群差异（at 节点），必须 per-event |
| triggerEventId（delegate_task 反查） | 保留 |
| notify 的 headline / sub-agent result / task id | 保留（本来就是动态） |

**具体建议的 recommendedAction 动态瘦身形态**（M1 落地时的目标形态示意）：

```jsonc
// 现在：action = 4381 静态 chars + profile/chatType 插值，整包 JSON.stringify
// 目标：action 压缩为动态小卡片（静态规则已进 system prompt）：
{
  "recommendedAction": {
    "action": "处理飞书群聊消息并回复。回复规范见 system prompt「飞书回复规范」章节。",
    "replyTo": { appId, profile, chatId, messageId }   // 原结构不动
  }
}
```

静态章节标题固定（如「⭐ 飞书回复规范（system prompt 注入版）」），
system prompt 里写清「recommendedAction.replyTo 给出的
profile/chatId/messageId 是本轮唯一权威定位，其余规则全部在此」。

### 量化收益估算

| 场景 | 现状 | 方案后 | 节省 |
|---|---|---|---|
| 每条飞书事件 prompt | 正文(~300 tok) + recommendedAction(1566 tok) + rawData 冗余(~300 tok) | 正文(~300) + 动态卡片(~120) | **~1700 tok/条**（user 侧） |
| 群日均 100 条事件（活跃群） | 100 × 1566 = 15.7 万 tok 全计费（冷启动/cache 过期部分按 provider 计价） | 15.7 万 → 1.2 万 + system 一次性 1566×session数 | **>90% 事件侧 token** |
| 新 session 冷启动（每群一个 session） | system(约 2-3K) + 首条事件 1566 | 同左 | 不变（system 本来就要付一次） |
| system prompt 增量 | — | +1566 tok（一次性/渠道/session） | 事件越多摊销越薄 |

盈亏平衡点：**同一 session 收到 ≥2 条飞书消息即回本**（1566×2 > 1566+2×120）。

---

## 4. cache 保持策略（逐字节稳定 + 失效边界）

### 4.1 同一渠道 systemPrompt 逐字节稳定的保证

1. **单点构造**：渠道静态 prompt 只在 `resolveChannelSystemPrompt(config)`
   一个函数里构造，handler 每次 `getCurrentSystemPrompt()` **不再重新模板化**，
   而是读一份构造结果（构造结果缓存在 instance 字段，构造入参只来自
   config，不来自事件）。
   - bounty-im 现状反例：`getCurrentSystemPrompt()` 每条消息调一次
     `resolveBountyIMSystemPrompt()`（:759）——虽然输出确定，但一旦模板里
     混入任何事件级变量（如 senderEmail）就会字节漂移。**规则：渠道 prompt
     构造函数禁止读 event/rawEvent**。
2. **cacheSnapshot 兜底**：即使实例层重算，AgentComponent 的 snapshot
   （Task #2744）也保证同 session 内字节级复用。双保险。
3. **禁止在渠道 prompt 里放**：messageId、chatId、senderId、时间戳、
   计数器、随机数。定位信息一律走 replyTo/动态卡片。

### 4.2 渠道信息变化时的 cache 失效边界

| 变化 | 影响面 | 处理 |
|---|---|---|
| 用户改 `EventSourceConfig.systemPrompt`（eventsource update） | 该渠道所有 session 的 snapshot 内容变旧 | snapshot 是 per-session 的：老 session 复用旧 prompt（字节稳定，cache 继续命中但语义旧）；**新 session** 用新 prompt。如需立即生效，提供 `roy-bot sessions <id>` 层面的 snapshot 失效（现有 `_isMemorySnapshotStale` 只查 memory mtime，**不查渠道 prompt 变化**——这是已知边界，一期文档化即可，不必实现 watcher） |
| lark profile / appId 变化 | 渠道 prompt 里 profile 相关句子变 | 同上；且不同 profile 本来就是不同 EventSourceConfig → 不同 sourceId → 独立渠道 prompt，天然隔离 |
| bounty-im email/imServerUrl 变化 | 默认模板插值变 | 同 systemPrompt 变化路径 |
| {{memory}} 更新 | 已有 Task #4813 mtime 失效检测自动重拍 | 不动 |

**边界结论**：失效粒度 = per-session。渠道配置变化不会（也不需要）
全量失效 cache——老 session 的旧行为是「稳定的旧语义」，直到自然过期/压缩。

### 4.3 与 provider cache 的配合（不新增机制）

- system 前缀稳定 → Anthropic cache_control（system 断点）直接受益；
- OpenAI-compatible 的 prompt_cache_key=sessionId 维持不变；
- **新增收益点**：history 里的旧 recommendedAction 巨块消失后，
  「system + 历史」可 cache 前缀中「每条 1566 tok 的重复噪声」被正文替代，
  同样 token 预算下能容纳更多轮有效历史（间接提升 compact 阈值利用率）。

---

## 5. 兼容性与改动范围

### 5.1 改动面（M1）

| 文件 | 改动 | 性质 |
|---|---|---|
| `packages/core/src/env/event-source/event-source-handlers.ts` | 新增 `buildLarkChannelSystemPrompt(profile)`（把 buildLarkRecommendedAction 的静态章节迁入）；`extractMetadata` 的 recommendedAction 换成动态小卡片（action 一句话 + replyTo 原结构） | 核心，~+120/-30 行 |
| `packages/core/src/env/event-source/event-source-handlers.ts` (LarkCliInstance) | 新增 `getChannelSystemPrompt()`；仿 bounty-im 在 metadata.systemPrompt 注入 | +15 行 |
| `packages/core/src/env/event-source/bounty-im-handler.ts` | `getCurrentSystemPrompt()` 结果缓存为实例字段（构造一次） | ~+8 行 |
| `packages/core/src/env/event-source/types.ts` | （可选）`RecommendedAction` 加 `staticRulesInSystemPrompt?: true` 标记，供旧 consumer 识别 | 可选 |
| `collect-event-source-system-prompts.ts` | lark-cli 类型分支接入 channel prompt resolve（现在 lark 返回 config.systemPrompt 原值） | +10 行 |
| 测试 | single-message-reply-prompt.test.ts 守护组 (A)/(D)/(G) 迁到 channel prompt 函数；新增「事件两次 resolve 字节一致」「replyTo 结构不变」「动态卡片无规则文本」用例 | RED→GREEN |

### 5.2 兼容性风险与对策

| 风险 | 对策 |
|---|---|
| sub-agent / 其他 consumer 直接读 `payload.message` 里 JSON 的 `recommendedAction.action` 找命令模板 | M1 保留 `replyTo` 结构与 `action` 字段（只是变短）；system prompt 中规则文本开头写「命令模板在本节」；灰度期观察 delegate_task 派生的 sub-agent 失败率 |
| 旧 ESPlugin / 第三方 handler 依赖 recommendedAction 长模板 | 加 config 开关 `channelPromptMode: "legacy" \| "lean"`（默认 lean，per-source 可回退 legacy） |
| prompt_cache_key=sessionId 与 chat-keyed session 组合下多群并发 | 无影响：不同 session 不同 key，本方案不碰 session 机制 |
| run headless（Task #5117）新链路 | 无需改动：headless-dispatch 已透传 `systemPrompt: envEvent.metadata?.systemPrompt`（run-headless-dispatch.ts:198），与 interactive 同构；preload 逻辑在 run.ts:2896 对两模式共用 |

### 5.3 明确不做（本任务边界）

- 不动 `convertToSDKMessages` / cache_control / prompt_cache_key；
- 不实现「渠道配置变化 → 自动失效 snapshot」的 watcher（文档化边界即可）；
- 不动 notify 模板的动态部分（M2 再评估）。

---

## 6. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 规则文本从事件搬到 system prompt 后，**短 session**（只处理 1 条消息就结束）反而多付 1566 tok | 低 | 系统性收益场景是长驻群聊；单发场景损失可接受，可后续按 chatType 门控 |
| R2 | LLM 对「system 里的规则 + user 里的动态定位」组合出现指令丢失（历史上规则在眼前时遵从性好） | 中 | 保留动态卡片里一句话指回规则章节；single-message-reply-prompt 测试组全部迁移守护；灰度跑真实群观察分段违规率 |
| R3 | 双份规则（迁移期 legacy/lean 并存）导致测试矩阵膨胀 | 低 | 开关默认 lean，legacy 只保留一个回归测试 |
| R4 | prompt_cache_key 前缀含 systemPrompt hash？否——key 是 sessionId，与内容无关，无风险 | — | — |

---

## 7. 分期

### M1 — lark 渠道 recommendedAction 静态规则前置（核心收益，先做）

1. `buildLarkChannelSystemPrompt()`（静态规则 + profile 句）
2. LarkCliInstance 在 metadata.systemPrompt 注入渠道 prompt
3. recommendedAction 瘦身为「一句话 action + replyTo 四元组」
4. collect-event-source-system-prompts 接入 lark-cli 分支
5. 测试迁移 + 新增字节稳定性用例
6. `channelPromptMode` 开关（legacy 回退）

**验收**：同渠道连发 3 条消息 → LLM 请求的 system prompt 字节级一致；
单条事件 user payload 中不含「关键 0/1/2」规则文本；replyTo 结构与现状逐字段一致；
全量 TUI/core 测试零新增 fail。

### M2 — bounty-im prompt 构造缓存 + notify 模板瘦身（可选跟进）

1. bounty-im `getCurrentSystemPrompt()` 实例缓存
2. buildNotifyHandlePrompt 静态章节（回执语义、发送纪律）评估前置到主 agent
   system prompt（注意：notify 走的是 sub-agent notify → 主 agent 轮次，
   静态章节前置要确认与「任务验收职责」章节不冲突——Task #5054 的教训：
   即时指令压过 system 章节，前置可能反向削弱本轮 actionability，**需先
   做 A/B 实测再动**）
3. rawData 冗余字段剔除（header/tenant 等）→ 只留决策有用字段

### M3 —（远期）渠道配置变化 → snapshot 主动失效

仅在用户反馈「改了渠道 prompt 但老 session 行为不更新」成为真实痛点时做。

---

## 8. 结论

- 「同一渠道 systemprompt cache 住不重建」**一半已经存在**：Task #2744 的
  session-scope cacheSnapshot 已把（含 ES prompt 的）system prompt 字节级
  冻结在 session 上；缺的是 lark 渠道根本没有 systemPrompt 可冻结。
- 真正的痛点是 **recommendedAction ~1566 tok/条** 的静态规则文本每条事件
  重复进 user message（且历史永久占位、冷启动重复计费）。
- 方案：静态规则前置到渠道 systemPrompt（复用现有 preload + snapshot 管道），
  事件只留动态定位四元组；同一 session ≥2 条消息即回本，活跃群事件侧
  token 收益 >90%。
