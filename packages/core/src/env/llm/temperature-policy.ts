/**
 * Temperature policy — 端点硬约束 + 优先级解析（Task #4946）
 *
 * ## 为什么需要这个模块
 *
 * 2026-11-04 用户在飞书报告：
 *   `roy-bot act hi --model kimi/k3.1-pro-highspeed`
 *   → `AI_APICallError: invalid temperature: only 1 is allowed for this model`
 *     (`https://api.kimi.com/coding/v1/chat/completions`, requestBody temperature: 0.7)
 *
 * 直打真实端点的实测结论（6 个模型全覆盖）：
 *   - `temperature: 0.7`  → HTTP 400 invalid temperature
 *   - `temperature: 1`    → HTTP 200
 *   - 省略 `temperature`  → HTTP 200
 *   ⇒ Kimi For Coding 端点**只接受 1 或不传**，与模型 id 无关，是端点级约束。
 *
 * ## 为什么不能只靠用户配置
 *
 * `ProviderConfig.temperature`（types.ts 的字段 + Zod schema）此前**没有任何
 * 读取点** —— 用户在 `config.jsonc` 的 provider 块里写 `"temperature": 1` 完全
 * 无效，而全局 `llm.temperature` 又会把同一份值广播给**所有** provider。
 * 于是用户只能在「全局改成 1（污染所有模型）」和「报 400」之间二选一。
 *
 * 本模块做两件事：
 *   1. `FIXED_TEMPERATURE_ENDPOINTS` —— 把「端点硬约束」变成**声明式数据**，
 *      由 baseURL（首选证据）或已知 provider id 识别，避免按用户自定义
 *      provider 名字瞎猜（`kimi` 是用户起的名字，`kimi-coding` 才是 pi-ai 内置 id）。
 *   2. `resolveTemperature()` —— 单一优先级解析函数：
 *        request > 显式全局 `llm.temperature` > provider 级 `temperature` > 内置 0.7
 *      最后再套用端点硬约束。这样 provider 级配置从此是**活的**，
 *      而硬约束端点无论上层传什么都不可能再发出非法值。
 *
 * @module
 */

/** 一条「端点硬约束 temperature」声明。 */
export interface FixedTemperatureEndpoint {
  /** 说明性标识（日志 / 报错用）。 */
  id: string;
  /**
   * 命中用的 baseURL 片段（**首选证据**）。
   *
   * 刻意匹配到域名 + 路径前缀（如 `api.kimi.com/coding`），这样同一家
   * 厂商「编码套餐」和「通用 API」两条线不会互相误伤。
   */
  baseURLIncludes: string;
  /**
   * 已知的 pi-ai 内置 provider id（baseURL 缺失时的兜底证据）。
   *
   * 只在 baseURL 解析不出来时使用，且必须是厂商官方 id，不能是用户自定义
   * 的 provider 别名（用户随时可能把 `kimi` 指向别家网关）。
   */
  providerIds?: readonly string[];
  /** 强制发送的 temperature 值。 */
  temperature: number;
  /** 为什么必须固定（写进文档/日志，避免日后被当成魔法数删掉）。 */
  reason: string;
}

/**
 * 端点硬约束表。
 *
 * 新增条目要求：
 *   - 有**真实请求**证据（curl 过 400 / 200 两组对照，不是看文档猜的）；
 *   - `baseURLIncludes` 足够具体（域名 + 路径前缀），不要只写厂商名片段。
 */
export const FIXED_TEMPERATURE_ENDPOINTS: readonly FixedTemperatureEndpoint[] = [
  {
    id: "kimi-for-coding",
    baseURLIncludes: "api.kimi.com/coding",
    providerIds: ["kimi-coding"],
    temperature: 1,
    reason:
      "Kimi For Coding 端点（api.kimi.com/coding）对所有它服务的模型都只接受 temperature=1 或不传；" +
      "发 0.7 会 400 invalid temperature（Task #4946 实测 6 个模型全覆盖）",
  },
];

/**
 * 在硬约束表里查找匹配项。
 *
 * 匹配顺序：baseURL 优先（真实证据），providerIds 兜底（已知官方 id）。
 * 两者都无命中时返回 `undefined`。
 */
export function findFixedTemperatureRule(input: {
  providerId?: string;
  baseURL?: string;
}): FixedTemperatureEndpoint | undefined {
  const { providerId, baseURL } = input;

  // baseURL 是首选证据（Task #4946 review MINOR-1/2）：
  //   - host 大小写不敏感 → 统一小写比较
  //   - 命中即返回
  if (baseURL) {
    const normalized = baseURL.toLowerCase();
    for (const rule of FIXED_TEMPERATURE_ENDPOINTS) {
      if (normalized.includes(rule.baseURLIncludes.toLowerCase())) return rule;
    }
    // baseURL 存在但未命中任何端点 → 该 provider 明确指向别处
    // （第三方网关/代理），**不得**再用 provider id 兜底误判。
    return undefined;
  }

  // baseURL 解析不出来时的唯一兜底：已知官方 provider id。
  if (providerId) {
    for (const rule of FIXED_TEMPERATURE_ENDPOINTS) {
      if (rule.providerIds?.includes(providerId)) return rule;
    }
  }

  return undefined;
}

/** 未做任何配置时沿用的历史默认值（保持向后兼容）。 */
export const DEFAULT_TEMPERATURE = 0.7;

export interface ResolveTemperatureInput {
  /** 调用方显式指定的 temperature（最高优先级）。 */
  requestTemperature?: number;
  /**
   * 显式配置的全局 `llm.temperature`。
   *
   * 注意：**必须是「用户真的配了」才有值**。不要把 `?? 0.7` 在这里做完 ——
   * 否则 provider 级配置永远不会生效（这正是修复前的死锁）。
   */
  globalTemperature?: number;
  /** provider 块里的 `temperature`（修复前是 dead field）。 */
  providerTemperature?: number;
  /** 解析后的 provider baseURL（硬约束识别的主证据）。 */
  baseURL?: string;
  /** provider id（硬约束识别的兜底证据）。 */
  providerId?: string;
}

export interface ResolveTemperatureResult {
  /** 最终应当放进请求体的 temperature。 */
  temperature: number;
  /** 若命中了端点硬约束，这里是那条规则（调用方可用于日志）。 */
  clampedBy?: FixedTemperatureEndpoint;
}

/**
 * 把配置里可能出现的字符串数字转成 number。
 *
 * 为什么需要：`llm.temperature` 也可以从**环境变量**来（`LLM_TEMPERATURE`），
 * 而 EnvSource 不做类型转换 —— `LLM_TEMPERATURE=0.7` 进到内存层是字符串
 * `"0.7"`。修复前它被原样塞进请求体，pi-ai 侧 zod 校验直接抛
 * `Invalid argument for parameter temperature: temperature must be a number`
 * （Task #4946 实测）。既然这里是所有温度来源的唯一汇聚点，就地归一化最省事。
 *
 * 非数字 / NaN 一律视为「没配」返回 undefined，让上层回落到下一优先级。
 */
function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * 解析最终 temperature。
 *
 * 优先级：request > 显式全局 > provider 级 > {@link DEFAULT_TEMPERATURE}，
 * 最后套用端点硬约束（命中则无条件覆盖，因为端点会直接 400）。
 */
export function resolveTemperature(input: ResolveTemperatureInput): ResolveTemperatureResult {
  const base =
    toNumberOrUndefined(input.requestTemperature) ??
    toNumberOrUndefined(input.globalTemperature) ??
    toNumberOrUndefined(input.providerTemperature) ??
    DEFAULT_TEMPERATURE;

  const rule = findFixedTemperatureRule({
    providerId: input.providerId,
    baseURL: input.baseURL,
  });

  if (rule) {
    return { temperature: rule.temperature, clampedBy: rule };
  }

  return { temperature: base };
}
