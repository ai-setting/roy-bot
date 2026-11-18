/**
 * @fileoverview Task #4634 — CLI `--model` / `--fallback-model` → AgentContext 接线。
 *
 * ## 为什么要有这个 helper
 *
 * 四个命令（`act` / `interactive` / `run` / `chat`）都需要把 CLI 的模型相关
 * flag 放进 AgentContext。散落在各命令里写 `...(x ? {x} : {})` 有两个问题：
 *
 * 1. **难测**：`mergedContext` / `handle_query` 的 context 都在深层闭包里，
 *    想断言「fallbackModel 真的到了 agent」只能起真实 env + 挂 Ink。
 * 2. **易漏**：`chat` 就是这么漏的 —— 它声明了 `--model`，却只把 model 传给
 *    ChatScreen（纯显示），`env.handle_query` 的 context 里根本没有 model。
 *
 * 把「flag → context 片段」抽成纯函数后：
 * - 片段的构造规则（未提供的 flag **不产生 key**）可以被单测直接锁住
 * - 各命令只需一行 spread，语义不会漂移
 *
 * ## 语义（与 act.ts / run.ts 保持一致）
 *
 * - `--model` → `AgentContext.model`：主模型。core 层优先级是
 *   `context.model ?? agent.config.model`（`agent-component.ts`），
 *   所以 per-run 覆盖不会写进 agent 注册配置，无状态漂移。
 * - `--fallback-model` → `AgentContext.fallbackModel`：兜底模型。
 *   core 层优先级是 `AgentContext.fallbackModel` > 配置 `llm.fallbackModel`
 *   （`agent-component.ts` 的 `resolveFallbackModel`），CLI 覆盖配置。
 *
 * 两个 flag 都对 **default agent 与 sub agent** 生效（sub agent 经
 * `ToolContext` → `delegate_task` → `env.handle_query` 继承，见 Task #4623）。
 */

/** CLI 的模型相关 flag */
export interface ModelFlagOptions {
  /** `--model`：主模型（providerId/modelId） */
  model?: string;
  /**
   * `--fallback-model`：兜底模型。
   *
   * ★ Task #4724：可以是**单个模型**（向后兼容），也可以是**有序列表**：
   *   - 逗号分隔：`--fallback-model a/M1,b/M2,c/M3`
   *   - 重复传：`--fallback-model a/M1 --fallback-model b/M2`
   * 两种语法可混用。顺序 = 优先级。
   *
   * yargs 侧保持 `type: "string"`（见 FALLBACK_MODEL_DESCRIBE 注释），
   * 逗号拆分统一在这里做。
   */
  fallbackModel?: string | string[];
}

/**
 * AgentContext 里与模型相关的片段。
 *
 * 字段都是可选的 —— 未提供对应 flag 时**字段不存在**（而不是值为 undefined）。
 */
export interface ModelAgentContext {
  model?: string;
  /**
   * Task #4623 — 单值兜底模型（向后兼容）。
   *
   * 只有**一个**兜底模型时用这个字段；多个时用 `fallbackModels` 数组。
   */
  fallbackModel?: string;
  /**
   * Task #4724 — 兜底模型**有序列表**（顺序 = 优先级）。
   *
   * 只有**两个及以上**兜底模型时才有这个字段（单个走 fallbackModel）。
   */
  fallbackModels?: string[];
}

/**
 * ★ Task #4724 — 把 CLI 的 `--fallback-model` 值归一化成**有序模型列表**。
 *
 * 支持的输入形态：
 *   - `undefined` / `""` / `[]` → `[]`（等同未配置）
 *   - `"a/M1"`（单模型）→ `["a/M1"]`
 *   - `"a/M1,b/M2"`（逗号分隔）→ `["a/M1", "b/M2"]`
 *   - `["a/M1", "b/M2"]`（yargs 重复传）→ `["a/M1", "b/M2"]`
 *   - `["a/M1,b/M2", "c/M3"]`（混合）→ `["a/M1", "b/M2", "c/M3"]`
 *
 * 空项与纯空白项被丢弃；每一项两端的空白被裁掉。
 */
export function parseFallbackModelArgs(
  value: string | string[] | undefined,
): string[] {
  const raw: string[] = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // 二次拆分：支持逗号分隔（重复传时其中一项也可能含逗号）
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/**
 * ★ Task #4724 review2 MINOR-1/MINOR-2 — 校验显式兜底值的**合法性**。
 *
 * ## 为什么需要
 *
 * `--fallback-model "provider/"` 这种「只有 provider 前缀、没有 modelId」的
 * 残值，如果静默放行，最终结果是**既不用 CLI 的、也不回落到 config** ——
 * 用户以为配了兜底，实际完全没有兜底，且全程零输出。
 *
 * 更麻烦的是**两层语义相反**：
 *   - `--fallback-model ","` → CLI 层归一化后为空 → 不产生任何 key
 *     → core 层视为「未提供」→ **回落到 config** ✅
 *   - `--fallback-model "provider/"` → CLI 层保留 1 项 → core 层判定残值
 *     → **不回落 config** ❌
 *
 * 同样是「无效显式值」，一个用 config、一个不用。
 *
 * ## 修法
 *
 * 在 **CLI 层**（唯一能给出清晰报错的地方）统一判定并报错退出；
 * core 层保留「显式优先 = 显式决定一切」的语义作为最后一道防线
 * （CLI 之外的调用方，如 sub agent 继承，仍需要这个语义）。
 *
 * @returns 非法项列表（空数组 = 全部合法）
 */
export function findInvalidFallbackModels(models: string[]): string[] {
  return models.filter((m) => {
    const trimmed = m.trim();
    if (!trimmed) return false;
    const slash = trimmed.indexOf("/");
    // 有 "/" 时，前缀是 provider、后缀是 modelId —— modelId 不能为空
    if (slash >= 0) {
      return trimmed.slice(slash + 1).trim() === "";
    }
    // 没有 "/"：裸 modelId 是合法的（core 会用 defaultProvider / fallbackProvider）
    return false;
  });
}

/**
 * 非法显式兜底值的统一报错文案。
 */
export function formatInvalidFallbackModelError(invalid: string[]): string {
  return (
    `❌ --fallback-model 取值非法：${invalid.map((m) => `"${m}"`).join(", ")}\n` +
    `   格式应为 providerId/modelId（例：opencodego/deepseek-v4.1-flash）。\n` +
    `   多模型请用逗号分隔或重复传：--fallback-model a/M1,b/M2`
  );
}

/**
 * ★ Task #4724 review2 MINOR-1/MINOR-2 — yargs `.check()` 校验器。
 *
 * 挂在四个命令的 builder 上，让**非法的显式兜底值在参数解析阶段就报错退出**，
 * 而不是静默放行到 core 层变成「既不用 CLI 的也不回落 config」。
 *
 * ⚠️ 用 `.check()` 而不是 `.coerce()`：`.coerce` 会**改写** argv，
 *   改写后的值会被后续代码看到（等于替用户做了决定）；
 *   `.check()` 只**校验不改写**，非法就抛错 —— 语义更准确。
 *
 * @param argv - yargs 解析出的 argv（类型由各命令的 builder 决定，
 *   这里用 `unknown` 收窄以避免与 yargs 的 `Arguments<...>` 逆变冲突）
 * @returns true 表示通过；抛错表示不通过（yargs 会打印并退出）
 */
export function checkFallbackModelArg(argv: unknown): boolean {
  const raw = (argv as { fallbackModel?: string | string[] } | undefined)?.fallbackModel;
  const models = parseFallbackModelArgs(raw);
  const invalid = findInvalidFallbackModels(models);
  if (invalid.length > 0) {
    throw new Error(formatInvalidFallbackModelError(invalid));
  }
  return true;
}


/**
 * `--fallback-model` 的统一 describe 文案。
 *
 * ★ Task #4634（交叉验证 MINOR 2）：四个命令原本各写各的，中英文混着来
 *   （act 中文 / interactive 中文 / run 英文 / chat 英文），同一个 flag 在
 *   `--help` 里出现三种措辞。抽成常量后**只有一处需要维护**，
 *   也保证「兜底语义」在所有命令的 `--help` 里一致。
 *
 * ★ Task #4724：扩展为多模型列表语法。
 *   ⚠️ 为什么 yargs 侧**不用** `array: true`：
 *   实测 `array: true` 在 **flag 先于位置参数**时会把 `act [message]` 一起吞掉
 *   （`roy-bot act --fallback-model X "hello"` → message 变 undefined、
 *   fallbackModel 变成 ["X","hello"]），破坏这个命令形态。
 *   （flag 在后时 `act "hello" --fallback-model X` 不受影响，但两种形态都得支持。）
 *   所以保持 `type: "string"`，逗号拆分由 `parseFallbackModelArgs` 负责，
 *   两种语法都支持：
 *     --fallback-model a/M1,b/M2      （逗号分隔）
 *     --fallback-model a/M1 --fallback-model b/M2   （重复传）
 */
export const FALLBACK_MODEL_DESCRIBE =
  "兜底模型（providerId/modelId），可传多个按顺序兜底（逗号分隔或重复传）。" +
  "主模型 404/429/额度耗尽/5xx/超时/重试耗尽时按顺序自动降级，" +
  "default agent 与 sub agent 均生效。传空值等同未配置（回落到配置文件）";

/**
 * `--model` 的统一 describe 文案。
 *
 * ★ Task #4634（交叉验证第 2 轮 MINOR-A）：与 FALLBACK_MODEL_DESCRIBE 同理 ——
 *   `--model` 的 describe 在四个命令里也是两种措辞（中文 / 英文），
 *   既然已经在统一 `--fallback-model`，顺手把 `--model` 也统一掉。
 */
export const MODEL_DESCRIBE = "使用的模型（providerId/modelId）";

/**
 * 把 CLI 的 `--model` / `--fallback-model` 转成 AgentContext 片段。
 *
 * @example
 *   buildModelAgentContext({ model: "opencodego/ds" })
 *   // → { model: "opencodego/ds" }
 *
 *   buildModelAgentContext({ fallbackModel: "opencodego/backup" })
 *   // → { fallbackModel: "opencodego/backup" }
 *
 *   buildModelAgentContext({})
 *   // → {}  （两个 flag 都没给 → 空对象，不污染下游 context）
 */
export function buildModelAgentContext(
  options: ModelFlagOptions
): ModelAgentContext {
  const context: ModelAgentContext = {};
  if (options.model) {
    context.model = options.model;
  }
  // ★ Task #4724：兜底模型可能是**有序列表**。
  //   - 0 个 → 两个字段都不产生（等同未配置）
  //   - 1 个 → 走 `fallbackModel`（单值，向后兼容，core 层老逻辑照常工作）
  //   - ≥2 个 → 走 `fallbackModels`（数组，顺序 = 优先级）
  const fallbacks = parseFallbackModelArgs(options.fallbackModel);
  if (fallbacks.length === 1) {
    context.fallbackModel = fallbacks[0];
  } else if (fallbacks.length > 1) {
    context.fallbackModels = fallbacks;
  }
  return context;
}

/**
 * ★ Task #5125 P7.2 —— 运行时模型 override（热切换）。
 *
 * ## 为什么是纯函数
 *
 * 与 `buildModelAgentContext` 同款理由：override 合并规则要能被
 * 单测直接锁住，不藏在 deep closure 里。
 *
 * ## 优先级（「后续操作赢」直觉，对齐 opencode 的
 *   `local.model.set`——用户在会话里选的模型赢过启动参数）
 *
 *   runtime override > 启动 `--model` flag > 无（回落内存层 llm.defaultModel）
 *
 * @param context     `buildModelAgentContext(options)` 的产物
 * @param runtimeModel 会话内热切换的模型（`providerId/modelId`）；
 *                    undefined/空串 = 无 override
 */
export function withRuntimeModelOverride(
  context: ModelAgentContext,
  runtimeModel: string | undefined,
): ModelAgentContext {
  const trimmed = runtimeModel?.trim();
  if (!trimmed) return context;
  return { ...context, model: trimmed };
}
