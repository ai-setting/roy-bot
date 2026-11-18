/**
 * @fileoverview Trace 参数瘦身过滤器（paramFilter / resultFilter 共享工具）
 *
 * ## 背景
 *
 * `traces.db` 曾膨胀到 169GB / 1800 万 span。根因不是 span 数量多，而是
 * **单个 span 把全量 messages / tool result 写进了 attributes**：
 *
 * | span name                    | 平均 attributes 体积 |
 * |------------------------------|----------------------|
 * | `llm.component.invoke`       | 473 KB               |
 * | `session.extractRecentMessages` | 878 KB           |
 * | `agent.component.executeTool` | 259 KB               |
 * | `agent.component.buildAdditionInfo` | 158 KB         |
 *
 * 每个 LLM 调用都把「system prompt + 全量对话历史」原样序列化进 DB，
 * 排障价值极低（DB 里只有数字，看不出内容）而体积代价极高。
 *
 * ## 方案：显式白名单 filter
 *
 * 用 `paramFilter` / `resultFilter` 把入参/返回值替换成**摘要**：
 * 条数、长度、模型名 —— 排障时最需要的那几个数字，体积 < 1KB。
 *
 * 相比 `recordParams: false`（黑盒式"全丢"），filter 是**显式白名单**：
 * 读代码就知道存了什么、没存什么；后续要加字段只改一个函数。
 *
 * ## 全量模式
 *
 * `ROY_TRACE_FULL=1` 时，所有 filter 退化为"原样保留"，用于临时全量排查。
 * 这样运维时只需重启进程 + 加环境变量，**不必改代码重新构建**。
 */

/**
 * 是否开启全量模式。
 *
 * 读环境变量而非编译期常量，是为了支持「不改代码、不重新构建」的临时全量排查：
 * `ROY_TRACE_FULL=1 <重启命令>` 即可恢复全量记录。
 *
 * ⚠️ 每次 filter 调用都会读一次 `process.env`（Bun 下开销极小），
 * 但为避免在热路径上重复读取，此处做模块级缓存 —— 进程生命周期内固定。
 * 需要在运行期切换（如测试）请调用 `resetTraceFullModeCache()`。
 */
let traceFullModeCache: boolean | undefined;

/** 强制刷新全量模式缓存（测试用） */
export function resetTraceFullModeCache(): void {
  traceFullModeCache = undefined;
}

/**
 * 是否处于全量模式（`ROY_TRACE_FULL=1`）。
 *
 * 只认 `"1"` / `"true"` / `"yes"`（大小写不敏感），避免 `ROY_TRACE_FULL=0`
 * 这种"看起来像开了其实是关了"的歧义写法被误判为开启。
 */
export function isTraceFullMode(): boolean {
  if (traceFullModeCache !== undefined) return traceFullModeCache;
  const raw = process.env.ROY_TRACE_FULL?.trim().toLowerCase();
  traceFullModeCache = raw === "1" || raw === "true" || raw === "yes";
  return traceFullModeCache;
}

/**
 * 安全地把任意值转成字符串长度（不做拷贝，不做遍历大数组）。
 *
 * 用于「统计体积」而不是「存内容」—— 这是 filter 里最重要的省 CPU 手法。
 */
function safeLen(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) return value.length;
  return 0;
}

/**
 * 统计一组消息的总字符数（只读 length，不做字符串拷贝）。
 *
 * `content` 既可能是字符串，也可能是 **part 数组**（多模态图片、tool-call /
 * tool-result）—— 只统计字符串会在 tool-heavy 历史里严重低估真实体量。
 * 数组形态按每个 part 的文本长度累加（取不到文本按 0 计），不做深遍历。
 */
function totalMessageChars(messages: any[]): number {
  let n = 0;
  for (const m of messages) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === "string") {
      n += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === "string") n += part.length;
        else if (part && typeof part.text === "string") n += part.text.length;
      }
    }
  }
  return n;
}

/** 只量体积、不存内容：对象型的等价字符数。 */
function safeJsonLen(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * toolNames 的双重封顶（Task #5341）。
 *
 * 正常工具数是 10-40，名字都很短（几十字节）—— 全量记下来也只是几百字节。
 * 封顶只为防御病态入参（几百上千个动态工具 / 超长工具名）把 slim 摘要
 * 撑破 2KB 预算。触发封顶时记前缀 + `toolNamesTruncated: true`。
 */
// 两个封顶的优先级：字符预算是主要约束（现实工具名 10-40 个、几十字节，
// 总和远小于 1024），条数封顶只在「大量超短名」时才会先命中 —— 两者都保留
// 是为了让极端入参也一定收敛（review MINOR-3）。
const TOOL_NAMES_COUNT_CAP = 100;
const TOOL_NAMES_CHAR_BUDGET = 1024;
/** 单个工具名的展示上限（实际名字都是 &lt; 64 字符；只为防病态长名） */
const TOOL_NAME_MAX_CHARS = 120;

/**
 * 从入参 tools 数组里抽工具名（防御式：非数组 / 非对象元素一律忽略）。
 *
 * 两级降级（review MINOR-2）：
 *   1. 单个名字过长 → 自身截断 + `…`，**仍然保留该项**（不因为一个病态名字把
 *      整个列表清空 —— 否则排障时「有哪些工具」直接瞎掉）
 *   2. 总字符预算 / 条数封顶用尽 → 返回已收集的前缀 + `toolNamesTruncated: true`
 */
function extractToolNames(tools: unknown): {
  toolNames: string[];
  toolNamesTruncated: boolean;
} {
  if (!Array.isArray(tools)) return { toolNames: [], toolNamesTruncated: false };
  const names: string[] = [];
  let chars = 0;
  for (const t of tools) {
    const raw = (t as { name?: unknown } | null)?.name;
    if (typeof raw !== "string" || raw.length === 0) continue;
    const name =
      raw.length > TOOL_NAME_MAX_CHARS ? `${raw.slice(0, TOOL_NAME_MAX_CHARS)}…` : raw;
    if (names.length >= TOOL_NAMES_COUNT_CAP || chars + name.length > TOOL_NAMES_CHAR_BUDGET) {
      return { toolNames: names, toolNamesTruncated: true };
    }
    names.push(name);
    chars += name.length;
  }
  return { toolNames: names, toolNamesTruncated: false };
}

/**
 * 通用：LLM 调用入参摘要（`llm.component.invoke` / `agent.component.invokeLLM`）。
 *
 * 保留的字段都是**排障时最常问的问题**的答案：
 * - 用的是哪个模型 / provider
 * - 这次塞了多少条消息、多大（判断是不是上下文爆炸）
 * - 带了多少个工具、**具体是哪些工具**（`toolNames`，Task #5341）
 *
 * 为什么要有 `toolNames`：只记数量时，「11 个工具」既可能是
 * 「10 个内置 + wecom_respond」也可能是「11 个内置」，无法从 trace 判断
 * 渠道专用工具（`channelOnly`）是否真的进了 LLM 请求。名称列表体积很小
 * （几十个短字符串，远小于 2KB 预算），换来的是可直接肉眼核对的证据。
 */
export function llmInvokeParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    // 全量模式：原样保留入参（保留旧行为，供临时全量排查）
    return { args } as any;
  }
  const p = (args ?? [])[0] as any;
  // ⚠️ 入参有两种形状，必须都覆盖：
  //   1) LLM 请求对象 —— { messages, model, provider, tools }
  //   2) Agent HookContext —— { messages, tools, context: { model, sessionId } }
  //      （`agent.component.invokeLLM` / `agent.component.buildAdditionInfo` 收到的是这个）
  // 只处理形状 1 会让 HookContext 场景的 model 恒为 null、messageCount 恒为 0 ——
  // 恰恰丢掉用户最关心的「哪个模型 / 塞了多少条消息」。
  const ctx = p?.context ?? p?.ctx ?? null;
  const msgs = Array.isArray(p?.messages) ? p.messages : [];
  const { toolNames, toolNamesTruncated } = extractToolNames(p?.tools);
  return {
    model: p?.model ?? p?.modelId ?? ctx?.model ?? null,
    provider: p?.provider ?? p?.providerId ?? null,
    sessionId: ctx?.sessionId ?? p?.sessionId ?? null,
    messageCount: msgs.length,
    totalChars: totalMessageChars(msgs),
    tools: Array.isArray(p?.tools) ? p.tools.length : 0,
    // Task #5341：名称列表（不止数量）—— 从 trace 可直接核对渠道专用工具是否传入
    toolNames,
    ...(toolNamesTruncated ? { toolNamesTruncated } : {}),
    maxTokens: p?.maxTokens ?? null,
    temperature: p?.temperature ?? null,
  };
}

/**
 * 通用：LLM 调用返回值摘要。
 *
 * 只留 `finishReason` / 输出长度 / 推理长度 / tool call 数 / usage ——
 * 这几个是判断"这次调用是否正常、有没有被截断、烧了多少 token"的关键数字。
 *
 * ⚠️ 真实类型是 `LLMInvokeResult = { output: LLMOutput, ... }`，
 * `LLMOutput = { content, reasoning?, finishReason, toolCalls?, usage? }`，
 * **没有 `text` / `parts`**；`AgentLLMOutput` 也是 `content` 形状。
 * 两种都兼容：`content` 优先。
 */
export function llmInvokeResultFilter(r: any): Record<string, any> {
  if (isTraceFullMode()) {
    return { result: r } as any;
  }
  const output = r?.output ?? r;
  const text = typeof output?.content === "string" ? output.content : "";
  const toolCalls = Array.isArray(output?.toolCalls) ? output.toolCalls : [];
  return {
    finishReason: output?.finishReason ?? r?.finishReason ?? null,
    outputChars: text.length || safeLen(output?.content),
    reasoningChars: typeof output?.reasoning === "string" ? output.reasoning.length : 0,
    toolCallCount: toolCalls.length,
    usage: output?.usage ?? r?.usage ?? null,
    providerId: r?.providerId ?? null,
    model: r?.model ?? output?.model ?? null,
    latencyMs: r?.latencyMs ?? null,
  };
}

/**
 * 通用：消息数组入参摘要（`session.extractRecentMessages` 等）。
 *
 * @param args[0] 通常是消息数组本身，也可能是 `{ messages: [...] }`
 */
export function messagesParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    return { args } as any;
  }
  const a0 = (args ?? [])[0];
  const msgs = Array.isArray(a0) ? a0 : Array.isArray(a0?.messages) ? a0.messages : [];
  return {
    messageCount: msgs.length,
    totalChars: totalMessageChars(msgs),
    roles: msgs.length ? String(msgs[0]?.role ?? "") : null,
  };
}

/**
 * 通用：工具执行入参摘要（`agent.component.executeTool`）。
 *
 * 工具参数可能含大文件内容，所以只留"工具名 + 参数键名列表"，不留参数值。
 */
export function toolExecParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    return { args } as any;
  }
  const ctx = (args ?? [])[0] as any;
  const toolCall = ctx?.currentToolCall ?? ctx?.toolCall ?? ctx;
  const toolName = toolCall?.toolName ?? toolCall?.name ?? toolCall?.tool ?? null;
  // ⚠️ 不要直接读 `toolCall.arguments`：函数对象上的 `arguments` 是**被毒化的属性**，
  // 严格模式下访问会抛 TypeError（"arguments, callee, and caller cannot be
  // accessed in this context"）。这些 filter 是公开导出的，外部直接调用会炸。
  // 所以先取 `args`（正常工具调用都走这个），再退到其它别名。
  const rawArgs = readToolArgs(toolCall);
  let argKeys: string[] = [];
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    argKeys = Object.keys(rawArgs);
  }
  return {
    tool: toolName,
    toolCallId: toolCall?.toolCallId ?? toolCall?.id ?? null,
    argKeys,
    argCount: argKeys.length,
  };
}

/**
 * 安全地读出工具参数对象。
 *
 * 逐个候选属性 try/catch —— 因为候选里可能有「毒化属性」
 * （函数对象的 `arguments` / `caller` / `callee` 在严格模式下访问会抛）。
 */
function readToolArgs(toolCall: any): any {
  if (!toolCall || typeof toolCall !== "object") return undefined;
  for (const key of ["args", "arguments", "input", "parameters"]) {
    try {
      const v = toolCall[key];
      if (v !== undefined && v !== null) return v;
    } catch {
      // 毒化属性 —— 跳过，换下一个候选
    }
  }
  return undefined;
}

/**
 * 通用：embed 入参摘要（`llm.adapter.embed` / `llm.adapter.ai_sdk.embed`）。
 *
 * embed 的 `texts`/`input` 是大字符串数组，**绝对不能入库**。
 */
export function embedParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    return { args } as any;
  }
  const req = (args ?? [])[0] as any;
  const input = req?.input ?? req?.texts ?? req?.value;
  const arr = Array.isArray(input) ? input : input === undefined ? [] : [input];
  let chars = 0;
  for (const s of arr) if (typeof s === "string") chars += s.length;
  return {
    provider: req?.provider ?? null,
    modelId: req?.modelId ?? req?.model ?? null,
    inputCount: arr.length,
    totalChars: chars,
  };
}

/**
 * 通用：embed 返回值摘要 —— 只留维度数，不留向量本身。
 */
export function embedResultFilter(r: any): Record<string, any> {
  if (isTraceFullMode()) {
    return { result: r } as any;
  }
  const embs = Array.isArray(r?.embeddings) ? r.embeddings : [];
  const dims = embs.length && Array.isArray(embs[0]) ? embs[0].length : 0;
  return {
    embeddingCount: embs.length,
    dimensions: dims,
    usage: r?.usage ?? null,
  };
}

/**
 * 工具执行（`tool.bash.execute` / `tool.component.execute`）入参摘要。
 *
 * 工具参数里最常见的「大对象」是 bash 的 command —— 一条 `cat bigfile` 就能
 * 带来几百 KB 到几 MB 的命令文本。命令**原文**在 DB 里排障价值很低
 * （真正想看的是「跑了什么工具、参数键有哪些、有多长」），但体积代价极高。
 *
 * 折中：保留命令的**前若干字符 + 总长度**。短命令（绝大多数）原样保留，
 * 长命令截断 —— 这样常见场景信息不丢，异常大命令又不会撑爆 DB。
 */
const MAX_COMMAND_CHARS = 2000;

/**
 * 工具执行返回值摘要。
 *
 * 返回值里最大的两块是 `output`（stdout）和 `metadata.stdout/stderr` ——
 * 一次 `cat` 一个大文件就能写进几 MB。同样只留长度 + 截断前缀。
 */
export function toolExecResultFilter(r: any): Record<string, any> {
  if (isTraceFullMode()) {
    return { result: r } as any;
  }
  // 两种真实形状都要兼容：
  //   - `ToolResult`            { success, output, error?, metadata? }        （tool.bash.execute / tool.component.execute）
  //   - `ToolCallResult`        { id, name, success, result: ToolResult }     （agent.component.executeTool）
  const inner = r && typeof r === "object" && r.result && typeof r.result === "object"
    ? r.result
    : r;
  const output = inner?.output ?? inner?.content ?? inner?.text;
  const text = typeof output === "string" ? output : "";
  // 对象型 output（如 read 返回的结构化内容）不能靠 length 量，用 JSON 长度量级
  const outputJsonChars = output && typeof output === "object" ? safeJsonLen(output) : 0;
  const metadata = inner?.metadata ?? r?.metadata;
  const stdout = typeof metadata?.stdout === "string" ? metadata.stdout : "";
  const stderr = typeof metadata?.stderr === "string" ? metadata.stderr : "";
  const error = inner?.error ?? r?.error;
  return {
    success: r?.success ?? inner?.success ?? null,
    tool: r?.name ?? r?.toolName ?? null,
    outputChars: text.length || outputJsonChars,
    outputHead: text.slice(0, 500),
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    exitCode: metadata?.exit_code ?? null,
    timedOut: metadata?.timed_out ?? null,
    executionTimeMs: metadata?.execution_time_ms ?? null,
    error: error ? String(error).slice(0, 500) : null,
  };
}

/**
 * 工具执行入参摘要（`tool.bash.execute` 的 command / `tool.component.execute` 的 args）。
 */
export function toolInvokeParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    return { args } as any;
  }
  const a0 = (args ?? [])[0] as any;
  // tool.bash.execute: args[0] = { command, timeout, ... }
  // tool.component.execute: args[0] = { name, args, context, ... }
  const command = typeof a0?.command === "string" ? a0.command : null;
  const toolName = a0?.name ?? a0?.toolName ?? null;
  const rawArgs = a0?.args;
  let argKeys: string[] = [];
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    argKeys = Object.keys(rawArgs);
  }
  return {
    tool: toolName,
    command: command === null ? null : command.slice(0, MAX_COMMAND_CHARS),
    commandChars: command === null ? null : command.length,
    commandTruncated: command !== null && command.length > MAX_COMMAND_CHARS,
    argKeys,
    argCount: argKeys.length,
    timeout: a0?.timeout ?? null,
  };
}

/**
 * 顶层查询入参摘要（`env.handle_query` / `env.handle_workflow_agent_query`）。
 *
 * 入参 `query` 是 `string | ContentPart[]` —— 多模态时是图片/文件的数组，
 * 可能很大。只留长度与类型，不留内容。
 */
/**
 * 环境入口（`env.handle_query` / `env.handle_workflow_agent_query`）入参摘要。
 *
 * ⚠️ **两个调用点的入参形状不同**，不能共用同一套解析：
 * - `env.handle_query(query, context?)`            → args[0] 是 **query**
 * - `env.handle_workflow_agent_query(agentName, query, agentComponent, context?)`
 *                                                    → args[0] 是 **agentName**，args[1] 才是 query
 *
 * 早期版本把 args[0] 一律当 agentName，导致 `handle_query` 的
 * **整条 query 被原样存进 `agentName` 字段** —— 过滤器等于没生效。
 * 现在按「参数个数 + 形状」区分两种入口。
 */
export function envQueryParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    return { args } as any;
  }
  // handle_workflow_agent_query：第一个是 agentName（字符串）且参数 >= 3
  const a = args ?? [];
  const isWorkflowEntry = a.length >= 3 && typeof a[0] === "string";
  const agentName = isWorkflowEntry ? a[0] : null;
  const query = isWorkflowEntry ? a[1] : a[0];
  const context = isWorkflowEntry ? a[3] : a[1];

  const isArray = Array.isArray(query);
  const parts = isArray ? query : [];
  let chars = 0;
  if (typeof query === "string") {
    chars = query.length;
  } else {
    for (const p of parts) {
      if (typeof p === "string") chars += p.length;
      else if (typeof p?.text === "string") chars += p.text.length;
    }
  }
  return {
    agentName,
    queryChars: chars,
    queryParts: isArray ? parts.length : 0,
    isMultimodal: isArray,
    contextKeys: context && typeof context === "object" ? Object.keys(context) : [],
  };
}

/**
 * `agent.component.run` 入参摘要。
 *
 * 入参是 `(agentName, query, context)` —— `query` 可能是多模态数组
 * （base64 图片能到 MB 级）。只留长度与条数。
 */
export function agentRunParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    return { args } as any;
  }
  const a = args ?? [];
  const agentName = typeof a[0] === "string" ? a[0] : null;
  const query = a[1];
  const isArray = Array.isArray(query);
  let chars = 0;
  if (typeof query === "string") chars = query.length;
  else if (isArray) {
    for (const p of query) {
      if (typeof p === "string") chars += p.length;
      else if (typeof p?.text === "string") chars += p.text.length;
    }
  }
  const ctx = a[2];
  return {
    agentName,
    queryChars: chars,
    queryParts: isArray ? query.length : 0,
    isMultimodal: isArray,
    contextKeys: ctx && typeof ctx === "object" ? Object.keys(ctx) : [],
  };
}

/**
 * `agent.component.recordSessionMessages` 入参摘要。
 *
 * ⚠️ 这是**最大的漏网之鱼**：`allMessages` 是**每一轮 ReAct 迭代的全部消息**
 * （含工具输出），实测单 span ~200 KB / 迭代。必须只留条数与长度。
 */
export function recordSessionMessagesParamFilter(args: any[]): Record<string, any> {
  if (isTraceFullMode()) {
    return { args } as any;
  }
  const a = args ?? [];
  const sessionId = typeof a[0] === "string" ? a[0] : null;
  const msgs = Array.isArray(a[1]) ? a[1] : [];
  let chars = 0;
  for (const m of msgs) {
    if (typeof m?.content === "string") chars += m.content.length;
  }
  return {
    sessionId,
    messageCount: msgs.length,
    totalChars: chars,
  };
}
