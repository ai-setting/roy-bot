import { BaseComponent, type ComponentConfig } from "../component";
import { type LLMConfig, type LLMInvokeRequest, type LLMInvokeResult, type LLMMessage, type ModelLimits, type UsageInfo } from "./types";
import { invoke, type InvokeConfig } from "./invoke";
import { createLLMAdapter } from "./factory";
import type { ChatRequest, ChatResponse, StreamHandle, LLMAdapter } from "./adapter";
import type { ConfigComponent } from "../../config/config-component";
import { EnvSource } from "../../config/env-source";
import { createLogger } from "../log-trace/logger";
import { TracedAs } from "../log-trace/decorator";
import { llmInvokeParamFilter, llmInvokeResultFilter } from "../log-trace/trace-filters";
import { toEnvKey, envKeyToConfigKey } from "../../config/env-key";
import { ContextError, ErrorCodes } from "../errors";
import { randomUUID } from "crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseJSONC } from "../../config/config-parser";
import { resolveTemperature } from "./temperature-policy";

// 创建 llm 模块日志器
const logger = createLogger("llm");

/**
 * Task #4373: Normalize a `UsageInfo` so cache fields survive re-packing.
 *
 * Background — why this helper exists:
 *
 *   Before this fix, both the adapter success path and the AI-SDK fallback
 *   path in `LLMComponent.invoke()` rebuilt the usage object from scratch:
 *
 *     finishUsage = {
 *       promptTokens: resp.usage.promptTokens ?? 0,
 *       completionTokens: resp.usage.completionTokens ?? 0,
 *       totalTokens: resp.usage.totalTokens ?? 0,
 *     };
 *
 *   `adapter-pi-ai.ts::fromAssistantMessage()` had ALREADY populated
 *   `cacheRead` / `cacheWrite` on `ChatResponse.usage`, but the literal
 *   rebuild silently dropped them. Result: 86,922 production
 *   `llm.component.invoke` spans carried a 3-field usage and **zero** of them
 *   exposed cache metrics — which is exactly why the user could not observe
 *   roy-bot's own cache hit rate.
 *
 * Semantics guarded here:
 *
 *   - `undefined` means "provider did not report the field" and MUST stay
 *     `undefined`. `0` means "the provider checked and nothing hit". We never
 *     coerce `undefined` → `0`, because that erases the distinction.
 *   - `promptTokensTotal` is the cache-aware INPUT denominator:
 *     `promptTokens + cacheRead + cacheWrite` for pi-ai-shaped usage.
 *     pi-ai reports `promptTokens` as the *non-cached remainder* only
 *     (`input = prompt_tokens - cacheRead - cacheWrite`), so consumers
 *     computing `cacheRead / promptTokens` would exceed 100% by orders of
 *     magnitude on warm traffic. `normalizeUsage` detects which convention a
 *     provider used (see the invariant check below) rather than assuming one.
 *   - `totalTokens` is passed through untouched.
 */
function normalizeUsage(usage: UsageInfo | undefined): UsageInfo | undefined {
  if (!usage) return undefined;

  const normalized: UsageInfo = {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };

  // Preserve the "not reported" vs "reported as 0" distinction.
  if (usage.cacheRead !== undefined) normalized.cacheRead = usage.cacheRead;
  if (usage.cacheWrite !== undefined) normalized.cacheWrite = usage.cacheWrite;
  if (usage.cacheMiss !== undefined) normalized.cacheMiss = usage.cacheMiss;

  // ---------------------------------------------------------------------
  // Derive the cache-aware input denominator — but only when the provider
  // actually reported cache information.
  //
  // ⚠️ Two incompatible `promptTokens` semantics flow through this method:
  //
  //   pi-ai adapter (default path)
  //     promptTokens = input = prompt_tokens - cacheRead - cacheWrite  (non-cached)
  //     totalTokens  = input + output + cacheRead + cacheWrite
  //
  //   AI SDK fallback path
  //     promptTokens = inputTokens.total                              (fully inclusive)
  //     totalTokens  = inputTokens.total + outputTokens
  //
  // Rather than trusting either, detect which invariant holds using the
  // provider's own `totalTokens`. Added tolerance of 1 token absorbs the
  // occasional off-by-one from providers that round counts.
  // ---------------------------------------------------------------------
  if (usage.cacheRead !== undefined || usage.cacheWrite !== undefined) {
    const reads = usage.cacheRead ?? 0;
    const writes = usage.cacheWrite ?? 0;
    const cacheSum = reads + writes;
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;

    // pi-ai shape: total already includes the cached tokens on top of prompt.
    const nonCachedTotal = prompt + completion + cacheSum;
    const aiSdkTotal = prompt + completion;
    const isPiAiShape = Math.abs(usage.totalTokens - nonCachedTotal) <= 1;

    if (isPiAiShape) {
      normalized.promptTokensTotal = prompt + cacheSum;
    } else if (Math.abs(usage.totalTokens - aiSdkTotal) <= 1) {
      // AI SDK shape: promptTokens already covers the cache, don't double count.
      normalized.promptTokensTotal = Math.max(prompt, cacheSum);
    } else {
      // Unknown shape — prefer the inclusive reading (matches OpenAI/Anthropic
      // documented `prompt_tokens` which counts cache hits inside it).
      normalized.promptTokensTotal = Math.max(prompt, cacheSum);
    }
  }

  return normalized;
}

// ============================================================================
// Fallback config resolution (Task #2888 follow-up)
// ============================================================================

/**
 * Resolve fallback provider config by reading `~/.roy-bot/auth.json` and
 * `~/.roy-bot/config.jsonc` directly (Task #2888 follow-up).
 *
 * Why this exists:
 *   When PiAiAdapter.stream() fails (e.g. finishReason=error, MIME 400, etc.),
 *   LLMComponent.invoke() falls back to AI SDK invoke(). The fallback must
 *   NOT reuse ctx.invokeConfig blindly — for some custom providers (e.g.
 *   minimax) that combination produces the wrong URL and HTTP 404. Reading
 *   config-driven per-provider baseURL/apiKey from auth.json is the
 *   user-controlled source of truth.
 *
 * Returned shape is just enough for the fallback path:
 *   - baseURL: from auth.json.providers.{name}.baseURL
 *   - apiKey:  from auth.json.providers.{name}.apiKey
 *   - providerType: from config.jsonc.llm.providers.{name}.provider
 *                   (defaults to "openai-compatible" if missing)
 *
 * @throws  Error when auth.json has no entry for `providerId`
 */
export interface FallbackProviderConfig {
  baseURL: string;
  apiKey: string;
  providerType: string;
}

export async function resolveFallbackProviderConfig(
  providerId: string,
): Promise<FallbackProviderConfig> {
  const home = os.homedir();
  const authPath = path.join(home, ".roy-bot", "auth.json");
  const configPath = path.join(home, ".roy-bot", "config.jsonc");

  // 并行读两个文件（独立 IO）
  let authText: string;
  let configText: string;
  try {
    [authText, configText] = await Promise.all([
      fs.readFile(authPath, "utf-8"),
      fs.readFile(configPath, "utf-8"),
    ]);
  } catch (err) {
    throw new Error(
      `resolveFallbackProviderConfig: cannot read ${authPath} or ${configPath}: ` +
        (err as Error).message,
    );
  }

  // auth.json 是纯 JSON（设计如此）
  const auth = JSON.parse(authText) as {
    providers?: Record<string, { apiKey?: string; baseURL?: string }>;
  };
  const authEntry = auth.providers?.[providerId];
  if (!authEntry?.apiKey || !authEntry?.baseURL) {
    throw new Error(
      `resolveFallbackProviderConfig: no config found for provider "${providerId}" ` +
        `in ${authPath}. Add it under "providers.${providerId}".`,
    );
  }

  // config.jsonc 是 JSONC（带注释） — 用 config-parser 的 parseJSONC（基于 jsonc-parser）
  const config = parseJSONC(configText) as {
    llm?: { providers?: Record<string, { provider?: string }> };
  };
  const configEntry = config.llm?.providers?.[providerId];
  const providerType = configEntry?.provider ?? "openai-compatible";

  return {
    baseURL: authEntry.baseURL,
    apiKey: authEntry.apiKey,
    providerType,
  };
}

/**
 * LLM 调用上下文（共享数据）
 */
interface InvokeContext {
  providerId: string;
  model: string;
  invokeConfig: InvokeConfig;
  messages: LLMMessage[];
  temperature: number;
  maxTokens: number;
  topP: number;
  abortSignal: AbortSignal | undefined;
}

/**
 * LLMComponent 配置（通过 options.config 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 * 
 * 环境变量转换规则：
 * - 驼峰命名会被转换为下划线分隔的大写形式
 * - 例如: "llm.defaultModel" + prefix "LLM" -> "LLM_LLM_DEFAULT_MODEL"
 */
export interface LLMComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "LLM"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<LLMConfig>;
}

/**
 * LLMComponent
 * 管理 LLM 调用，使用 AI SDK 进行实际调用
 * 
 * 配置通过 ConfigComponent 实时获取，支持配置热更新
 * 
 * @example
 * // 通过 ConfigComponent 加载配置
 * const configComponent = new ConfigComponent();
 * configComponent.setXdgDataHome(__dirname);
 * 
 * const llmComponent = new LLMComponent();
 * await llmComponent.init({
 *   env,  // Environment 实例（必填）
 *   options: {
 *     configComponent,  // ConfigComponent 实例
 *     configPath: "config.jsonc"  // 配置文件路径
 *   }
 * });
 * 
 * // 配置更新后，下次调用会自动获取最新配置
 * configComponent.set("llm.temperature", 0.5);
 */
export class LLMComponent extends BaseComponent {
  readonly name = "llm";
  readonly version = "2.0.0";

  private configComponent?: ConfigComponent;
  
  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;

  /**
   * P1-3: Cached LLM adapter instance.
   *
   * Instead of calling createLLMAdapter() on every invoke(), we cache the
   * adapter here. The adapter is created lazily on first use and rebuilt
   * only when the provider environment variable changes (via
   * invalidateAdapterCache()).
   */
  private cachedAdapter?: LLMAdapter;

  /** The provider name that was used to create the cached adapter */
  private cachedAdapterProvider?: string;

  /**
   * Test-only adapter override (see `__setAdapterForTest`).
   *
   * Kept as an instance field rather than a module mock so the override is
   * scoped to a single LLMComponent instance and cannot leak into other test
   * files sharing the same Bun process.
   */
  private adapterOverride?: LLMAdapter;

  constructor() {
    super();
  }

  /**
   * 初始化组件
   * 
   * 配置加载优先级（从高到低）：
   * 1. Object - 直接传入的 config 对象
   * 2. Env - 环境变量（通过 envPrefix 配置前缀）
   * 3. File - 配置文件（通过 configPath 指定）
   */
  async init(config: ComponentConfig): Promise<void> {
    // 调用基类 init，注入 env
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config.options as unknown as LLMComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for LLMComponent initialization");
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    this.setStatus("running");
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. FileSource - 从配置文件加载（最低）
   * 2. EnvSource - 从环境变量加载（中等）
   * 3. MemorySource - 直接配置对象（最高）
   */
  private async registerConfig(options: LLMComponentOptions): Promise<void> {
    const configComponent = options.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;
    const prefix = envPrefix !== undefined ? envPrefix : "LLM";

    // 获取所有已注册的 keys
    const llmKeys = [
      "llm.defaultModel",
      "llm.defaultProvider",
      "llm.fallbackModel",
      // ★ Task #4722 round3（交叉验证第 2 轮 MAJOR M1）：
      //   `llm.fallbackModels`（有序数组）必须进这个白名单 ——
      //   否则 file source 虽然能读到，但**不会被复制进 ConfigComponent 内存层**，
      //   而 `ConfigComponent.get()` 只读内存层 →
      //   agent 侧 `configComponent.get("llm.fallbackModels")` 恒为 undefined，
      //   卡片/CLI 改的 fallback 列表在运行时**毫无效果**（假功能）。
      //
      // ★ Task #4724：兜底模型**有序列表**（顺序 = 优先级）。
      //   与 llm.fallbackModel（单值，向后兼容）共存，数组优先（见
      //   agent-component.ts 的 resolveFallbackModels）。
      "llm.fallbackModels",
      "llm.fallbackProvider",
      "llm.temperature",
      "llm.maxTokens",
      "llm.topP",
      "llm.stream",
      "llm.providers",
      "llm.limits",
      "llm.capabilities",
    ];

    // 1. 注册并加载 FileSource（如果提供了 configPath）
    let fileSource: any = null;
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
      
      // 确保 source 已创建
      (configComponent as any).ensureSourcesCreated?.();
      
      // 获取 file source
      const sources = configComponent.getSources?.() || [];
      fileSource = sources.find((s: any) => s.name === "file");
      
      // 加载 file 配置到 memory
      if (fileSource) {
        for (const key of llmKeys) {
          const value = fileSource.read?.(key);
          if (value !== undefined) {
            await configComponent.set(key, value);
          }
        }
      }
    }

    // 2. 注册并加载 EnvSource
    configComponent.registerSource({
      type: "env",
      envPrefix: prefix,
      priority: 20,
      watch: false
    });
    
    // 确保 source 已创建
    (configComponent as any).ensureSourcesCreated?.();
    
    // 获取 env source
    const sourcesAfterEnv = configComponent.getSources?.() || [];
    const envSource = sourcesAfterEnv.find((s: any) => s.name === "env");
    
    // 加载 env 配置到 memory（覆盖 file）
    if (envSource) {
      for (const key of llmKeys) {
        const value = envSource.read?.(key);
        if (value !== undefined) {
          await configComponent.set(key, value);
        }
      }
    }
    
    // 后备方案：直接读取环境变量
    // 1. 先检查预定义的 llmKeys
    for (const key of llmKeys) {
      const envKey = toEnvKey(key, prefix);
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(key, value);
      }
    }

    // 2. 自动发现并加载所有以 prefix 开头的 llm.* 环境变量
    const loadedKeys = new Set(llmKeys); // 记录已加载的 keys，避免重复
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "llm");
      if (!configKey) continue;

      // 避免重复加载
      if (loadedKeys.has(configKey)) continue;
      loadedKeys.add(configKey);

      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 2.5 Bug #2186 Bug 2: 警告未识别的 LLM 环境变量
    //   （如拼写错误 LLM_DEAFAULT_PROVIDER=typo 静默生效 → 现在触发 warning）
    //   调用 EnvSource.validateUnrecognizedEnvVars 校验 process.env 中所有 LLM_* 环境变量
    //   只对未匹配"已知 config key 模式"的 env var 报警告。
    //   knownKeys 包含：预定义 key（如 llm.defaultProvider）+ 父级前缀（如 llm.default 覆盖
    //   envKeyToConfigKey 产生的 llm.default.<...>）+ 嵌套配置（如 llm.providers.*）。
    if (envSource instanceof EnvSource) {
      const knownKeys = new Set<string>([
        // Predefined keys (camelCase)
        "llm.defaultModel",
        "llm.defaultProvider",
        // Task #4623 review P2-8：不加这里会触发 Unrecognized env var 误报警告
        // （envKeyToConfigKey("LLM_FALLBACK_MODEL") 产出 "llm.fallback.model"）。
        "llm.fallbackModel",
        // ★ Task #4722/#4724：兜底模型有序列表（顺序 = 优先级）。
        //   加入 knownKeys → 避免 LLM_FALLBACK_MODELS 环境变量被误报为
        //   「未识别」；注意该变量经 envKeyToConfigKey 会产出
        //   "llm.fallback.models"（下划线→点号），"llm.fallback"
        //   父级前缀已覆盖它，此条目为防御性声明。
        "llm.fallbackModels",
        "llm.fallbackProvider",
        "llm.temperature",
        "llm.maxTokens",
        "llm.topP",
        "llm.stream",
        "llm.options",
        // Parent prefixes that match envKeyToConfigKey's dotted snake_case form
        // (e.g. LLM_DEFAULT_PROVIDER → "llm.default.provider" via envKeyToConfigKey)
        "llm.default",     // 覆盖 llm.default.* 自动发现键
        "llm.fallback",    // 覆盖 llm.fallback.* 自动发现键
        // Nested config (covers llm.<name>.<id>.<...>)
        "llm.providers",
        "llm.limits",
        "llm.capabilities",
      ]);
      envSource.validateUnrecognizedEnvVars({
        componentName: "llm",
        knownKeys,
        logger: {
          warn: (msg: string) => logger.warn(msg),
        },
      });
    }

    // 3. 如果有直接配置对象，覆盖到 MemorySource（优先级最高）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 3.5 Bug #2186 Bug 3: 校验 defaultProvider 是否在已知 providers 列表中
    //   （如 LLM_DEFAULT_PROVIDER=volcengine2 配置了 providers 时应在 init 时立即抛错，
    //    而不是延迟到第一次 LLM 调用才失败）
    //   back-compat 行为：当 llm.providers 未配置（或为空）时，跳过校验，
    //   允许任意 defaultProvider 值（不破坏 minimal config 用例）
    const configuredProviders = configComponent.get("llm.providers");
    const configuredDefaultProvider = configComponent.get("llm.defaultProvider") as string | undefined;
    if (
      typeof configuredDefaultProvider === "string" &&
      configuredProviders &&
      typeof configuredProviders === "object" &&
      Object.keys(configuredProviders as Record<string, unknown>).length > 0
    ) {
      const providerKeys = Object.keys(configuredProviders as Record<string, unknown>);
      if (!providerKeys.includes(configuredDefaultProvider)) {
        throw new Error(
          `[LLM] Invalid llm.defaultProvider: "${configuredDefaultProvider}". ` +
          `Known providers: ${providerKeys.join(", ")}. ` +
          `Add it to llm.providers first, or remove the env var / config entry.`
        );
      }
    }

    // 4. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);
  }

  /**
   * 将配置对象展平为点号路径
   * 
   * @example
   * flattenConfig({ providers: { openai: { apiKey: "xxx" } } })
   * -> { "llm.providers.openai.apiKey": "xxx" }
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "llm"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(
          result,
          this.flattenConfig(value as Record<string, unknown>, fullKey)
        );
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  }
  
  /**
   * 注册配置热更新监听
   */
  private registerConfigWatcher(configComponent: ConfigComponent): void {
    // 检查 watch 方法是否存在
    if (typeof configComponent.watch !== "function") {
      logger.debug("ConfigComponent does not support watch, hot reload disabled");
      return;
    }
    
    // 注册热更新监听
    this.configWatcher = configComponent.watch("llm.*", (event) => {
      this.onConfigChange(event);
    });
    
    logger.debug("Config hot reload watcher registered for llm.*");
  }
  
  /**
   * 处理配置变更（支持热更新）
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`LLM config changed: ${event.key}`);
    
    // 根据变更的 key 类型进行处理
    if (event.key === "llm.providers" || event.key.startsWith("llm.providers.")) {
      // Provider 配置变更，记录日志
      // 注意：getProvider/getLLMConfig 会实时从 configComponent 读取，所以不需要显式重新加载
      logger.info(`LLM provider config changed, will use new config on next call`);
    } else if (event.key === "llm.defaultModel") {
      logger.info(`LLM default model changed to: ${event.newValue}`);
    } else if (event.key === "llm.defaultProvider") {
      logger.info(`LLM default provider changed to: ${event.newValue}`);
    } else {
      logger.debug(`LLM config updated: ${event.key}`);
    }
  }

  /**
   * 启动组件
   */
  async onStart(): Promise<void> {
    if (this._status === "stopped") {
      this.setStatus("running");
    }
  }

  /**
   * 停止组件
   */
  async onStop(): Promise<void> {
    // 清理配置热更新 watcher
    this.configWatcher?.();
    this.configWatcher = undefined;
    
    this.setStatus("stopped");
  }

  /**
   * 从配置源获取配置值
   * 优先从 ConfigComponent 获取（支持热更新），否则返回默认值
   */
  private getLLMConfig<T>(key: string, defaultValue?: T): T {
    // 优先从 ConfigComponent 获取（实时）
    if (this.configComponent) {
      const value = this.configComponent.get(key);
      if (value !== undefined) {
        return value as T;
      }
    }
    
    return defaultValue!;
  }

  /**
   * 解析请求，构建调用上下文（invoke 和 invokeStream 共享）
   */
  private resolveRequest(request: LLMInvokeRequest): InvokeContext {
    // 实时获取配置
    const defaultModel = this.getLLMConfig<string>("llm.defaultModel", "gpt-4o");
    const defaultProvider = this.getLLMConfig<string>("llm.defaultProvider", "openai");
    // ★ Task #4946: 这里**不**用 `?? 0.7` 兜底 —— 必须区分「用户显式配了
    //   llm.temperature」和「没配」。否则 provider 级 `temperature` 永远是
    //   dead field（修复前的真实 bug）。最终兜底值由 resolveTemperature() 负责。
    const configuredGlobalTemperature = this.getLLMConfig<number | undefined>("llm.temperature");
    const defaultMaxTokens = this.getLLMConfig<number>("llm.maxTokens", 4096);
    const defaultTopP = this.getLLMConfig<number>("llm.topP", 1.0);

    // 确定模型
    // ★ 解析模型字符串：如果 model 包含 "/"（格式 "providerId/modelId"），提取 providerId
    const rawModel = request.model || defaultModel;
    let model: string;
    let providerId: string;

    const slashIndex = rawModel.indexOf("/");
    if (slashIndex >= 0) {
      // 格式: "providerId/modelId"
      providerId = rawModel.substring(0, slashIndex);
      model = rawModel.substring(slashIndex + 1);
    } else {
      // 无 provider 前缀: 使用 request.providerId 或 defaultProvider
      providerId = request.providerId || defaultProvider;
      model = rawModel;
    }

    // 获取 API Key
    const apiKey = this.getApiKey(providerId);
    if (!apiKey) {
      throw new Error(`API key not found for provider ${providerId}. Set providers.${providerId}.apiKey in config, or use \${env://...} protocol in config file.`);
    }

    // 构建消息
    const messages: LLMMessage[] = request.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      name: msg.name,
      toolCallId: (msg as any).toolCallId,  // 保留 toolCallId 字段
      toolCalls: (msg as any).toolCalls,     // 保留 toolCalls 字段
    }));

    const provider = this.getProvider(providerId);
    const capabilities = provider?.capabilities;
    const thinkingInText = capabilities?.thinkingInText;

	    // 仅在 provider 显式配置 thinkingInText 时启用。
	    // 不通过 capabilities.reasoning 自动推断——DeepSeek 等模型通过 SDK 原生
	    // reasoning-delta 事件输出思考过程，text-delta 中不含 <think> 标签，
	    // 无需剥离。仅 MiniMax 等模型的 text-delta 内嵌 <think> 标签的需要此配置。
	    const effectiveThinkingInText = thinkingInText !== undefined
	      ? thinkingInText
	      : undefined;

    // ★ Task #4946: 统一温度解析（provider 级配置接线 + 端点硬约束钳制）。
    //   修复前：`request.temperature ?? 0.7` —— provider 级 temperature 是
    //   dead field，且 Kimi For Coding 端点（只接受 1）拿到 0.7 直接 400。
    const temperatureResolution = resolveTemperature({
      requestTemperature: request.temperature,
      globalTemperature: configuredGlobalTemperature,
      providerTemperature: provider?.temperature,
      providerId,
      baseURL: provider?.baseURL,
    });
    if (temperatureResolution.clampedBy) {
      // Task #4946 review MINOR-3：命中钳制通常意味着该 provider
      // 的**每一个**请求都会被钳（端点级约束，不是请求级），逐请求
      // 打 info 是纯噪音 → 降为 debug。
      logger.debug(
        `[LLMComponent] temperature 被端点硬约束钳制：${providerId} → ${temperatureResolution.temperature}`,
        {
          provider: providerId,
          requested: request.temperature ?? configuredGlobalTemperature ?? provider?.temperature,
          forced: temperatureResolution.clampedBy.temperature,
          reason: temperatureResolution.clampedBy.reason,
        },
      );
    }

    return {
      providerId,
      model,
      invokeConfig: {
        model: `${providerId}/${model}`,  // 确保格式统一: "providerId/modelId"
        apiKey,
        baseURL: provider?.baseURL,
        // Task #4403: carry the provider capabilities through to the adapter.
        // `resolvePiModel()` needs them to decide `reasoning` from config
        // instead of the old hardcoded `false`.
        ...(capabilities ? { capabilities } : {}),
        ...(effectiveThinkingInText?.enabled
          ? {
              options: {
                thinkingInText: {
                  enabled: effectiveThinkingInText.enabled,
                  tags: effectiveThinkingInText.tags,
                  removeFromOutput: effectiveThinkingInText.removeFromOutput,
                },
              },
            }
          : {}),
      },
      messages,
      temperature: temperatureResolution.temperature,
      maxTokens: request.maxTokens ?? defaultMaxTokens,
      topP: request.topP ?? defaultTopP,
      abortSignal: request.abortSignal,
    };
  }

  /**
   * 调用 LLM
   *
   * 路由策略（Task 6 实现）：
   * - 读取 ROY_LLM_PROVIDER 环境变量（默认 pi-ai）
   * - 通过 createLLMAdapter().chat() 统一接入
   * - 若 PiAiAdapter 失败（如 model 不支持），保留 fallback 路径
   *
   * 流式事件通过 env.pushEnvEvent() 发布
   */

  /**
   * P1-3: Get or create the cached LLM adapter.
   *
   * The adapter is created once and cached. If the ROY_LLM_PROVIDER
   * environment variable changes, call invalidateAdapterCache() to force
   * a rebuild on the next invoke().
   */
  private getAdapter(): LLMAdapter {
    // Test-only override. Using an explicit instance field instead of
    // `mock.module("./factory")` keeps the mock scoped to this component
    // instance — a module-level mock leaks into every other test file that
    // shares the Bun process (observed as 4 unrelated
    // `llm.adapter-integration.test.ts` failures).
    if (this.adapterOverride) return this.adapterOverride;

    const currentProvider = process.env.ROY_LLM_PROVIDER || "pi-ai";
    if (this.cachedAdapter && this.cachedAdapterProvider === currentProvider) {
      return this.cachedAdapter;
    }
    this.cachedAdapter = createLLMAdapter();
    this.cachedAdapterProvider = currentProvider;
    return this.cachedAdapter;
  }

  /**
   * Test-only: inject a fake adapter for this component instance.
   *
   * Preferred over `mock.module("./factory")` because it does not leak across
   * test files in the same Bun process. Call `__setAdapterForTest(undefined)`
   * to restore normal factory behaviour.
   */
  __setAdapterForTest(adapter: LLMAdapter | undefined): void {
    this.adapterOverride = adapter;
  }

  /**
   * P1-3: Invalidate the cached adapter.
   *
   * Call this when the LLM provider environment variable changes to force
   * the adapter to be recreated on the next invoke().
   */
  invalidateAdapterCache(): void {
    this.cachedAdapter = undefined;
    this.cachedAdapterProvider = undefined;
  }

  /**
   * ★ 2026-10-22：**入参/返回值只存摘要**（Task #4479）。
   *
   * 改造前本 span 平均 473KB —— 因为 `request.messages`（全量 system prompt +
   * 对话历史）被原样序列化进 DB attributes，完整模型响应又存了两遍
   * （`attributes.result` + `result` 列）。
   *
   * 现在只存摘要：模型名 / provider / 消息条数 / 总字符数 / 工具数 /
   * finishReason / output 长度 / usage —— 排障时最常问的问题的答案，
   * 体积 < 1KB。
   *
   * 需要临时全量排查时：`ROY_TRACE_FULL=1` 重启即可恢复全量（不改代码）。
   */
  @TracedAs("llm.component.invoke", {
    paramFilter: llmInvokeParamFilter,
    resultFilter: llmInvokeResultFilter,
    logResult: true,
    log: true,
  })
  async invoke(request: LLMInvokeRequest): Promise<LLMInvokeResult> {
    const startTime = Date.now();

    if (this._status !== "running") {
      throw new Error("LLMComponent is not running");
    }

    const ctx = this.resolveRequest(request);

    // P1-3: Use cached adapter instead of creating a new one on every invoke()
    const adapter = this.getAdapter();
    const chatReq: ChatRequest = {
      provider: ctx.providerId,
      modelId: ctx.model,
      messages: ctx.messages,
      tools: request.tools as any,
      systemPrompt: undefined,
      temperature: ctx.temperature,
      maxTokens: ctx.maxTokens,
      apiKey: (ctx.invokeConfig as any).apiKey || "",
      baseURL: (ctx.invokeConfig as any).baseURL,
      signal: ctx.abortSignal,
      // Forward the conversation id so providers that need a stable
      // per-conversation identifier (OpenCode Go → x-opencode-session) work on
      // the default PiAiAdapter path, not only via the AI SDK fallback.
      sessionId: request.context?.sessionId,
      // Task #4403: thread the configured provider capabilities into the
      // adapter so `resolvePiModel()` can build the model descriptor from
      // reality instead of the old hardcoded `reasoning: false`. This is the
      // broken link that made `capabilities.reasoning: true` a no-op.
      capabilities: ctx.invokeConfig.capabilities,
      // Task #4465: carry the cache-retention preference through to whichever
      // path ends up serving this request. Sourced from the request when the
      // caller provides one; otherwise left undefined and each path applies its
      // own protocol-aware default (both default to "long" for OpenAI-family).
      cacheRetention: (request as { cacheRetention?: "none" | "short" | "long" }).cacheRetention,
    };

    let output: { content: string; reasoning?: string; finishReason: "length" | "stop" | "content-filter" | "tool-calls" | "function-call"; toolCalls?: any[]; usage?: UsageInfo } = {
      content: "",
      reasoning: undefined,
      finishReason: "stop",
    };
    let finishUsage: UsageInfo | undefined;

    let resp: ChatResponse;
    try {
      // Task #2719: prefer adapter.stream() so pi-ai emits incremental text_delta
      // events that we publish as llm.text (interactive gets character-by-character
      // streaming). Fall back to AI SDK invoke() on any failure to preserve the
      // compatibility path for providers / endpoints that do not implement stream.
      const streamHandle = await adapter.stream(chatReq);
      resp = await this.consumeStreamAndGetResult(
        streamHandle,
        request,
        ctx,
      );
      // pi-ai can encode provider failures as an error response rather than throwing;
      // route those through the same compatibility fallback.
      if (resp.finishReason === "error") {
        throw new Error((resp.raw as any)?.errorMessage || "adapter returned an error response");
      }
    } catch (adapterErr) {
      // PiAiAdapter 失败时 fallback 到 AI SDK invoke()（保持向后兼容）
      //
      // Task #2888 follow-up: don't blindly reuse ctx.invokeConfig.baseURL/apiKey —
      // for some custom providers (e.g. minimax) that combination produces the
      // wrong URL and HTTP 404. Instead, re-resolve per-provider baseURL/apiKey
      // from ~/.roy-bot/config.jsonc + auth.json (the user-controlled source
      // of truth). The adapter just failed with a config-driven URL; the fallback
      // deserves the same config-driven URL, not whatever the adapter cached.
      logger.warn(
        `[LLMComponent.invoke] adapter(${adapter.name}) failed, falling back to AI SDK invoke: ${(adapterErr as Error).message}`,
      );

      let fallbackInvokeConfig: InvokeConfig = ctx.invokeConfig;
      try {
        const fallback = await resolveFallbackProviderConfig(ctx.providerId);
        fallbackInvokeConfig = {
          ...ctx.invokeConfig,
          apiKey: fallback.apiKey,
          baseURL: fallback.baseURL,
        };
        logger.warn(
          `[LLMComponent.invoke] fallback re-resolved baseURL from auth.json: ${fallback.baseURL}`,
        );
      } catch (configErr) {
        // Config-driven fallback unavailable — proceed with ctx.invokeConfig as-is.
        // This preserves the original behavior when ~/.roy-bot/config.jsonc
        // is unreadable, so the fallback still has a chance to work.
        logger.warn(
          `[LLMComponent.invoke] resolveFallbackProviderConfig failed, using ctx.invokeConfig as-is: ${(configErr as Error).message}`,
        );
      }

      const result = await invoke(
        fallbackInvokeConfig,
        {
          messages: ctx.messages,
          model: fallbackInvokeConfig.model,
          temperature: ctx.temperature,
          maxTokens: ctx.maxTokens,
          tools: request.tools,
          env: this.env,
          context: {
            sessionId: request.context?.sessionId,
            messageId: request.context?.messageId,
          },
          toolChoice: request.toolChoice,
          // Task #4465: forward the caller's cache-retention preference to the
          // AI SDK fallback so it matches path A. `chatReq.cacheRetention` is
          // already forwarded shape-identically; when it is undefined the
          // outbound middleware defaults to "long", which is exactly what
          // buildPiCacheOptions() does for openai-completions on path A.
          cacheRetention: chatReq.cacheRetention,
        },
        { abort: ctx.abortSignal }
      );

      if (result.isError) {
        // Task #4625: carry the structured error through via `cause`.
        // `result.result` is a flat redacted string; the AI SDK's
        // `APICallError.responseHeaders["retry-after"]` lives on the original
        // object, and `classifyReactFailure()` / `extractRetryAfterSeconds()`
        // can only reach it through `cause`.
        // Guard the cause (review MINOR-3): `originalError` is optional, and
        // `{cause: undefined}` still sets the property — which makes
        // `'cause' in err` true while offering nothing to walk.
        throw result.originalError
          ? new Error(result.result, { cause: result.originalError })
          : new Error(result.result);
      }

      // 解析 ToolResult（沿用现有逻辑）
      try {
        const parsed = JSON.parse(result.result);
        output.content = parsed.content || "";
        output.reasoning = parsed.reasoning || undefined;
        output.finishReason = parsed.tool_calls?.length ? "tool-calls" : "stop";
        output.toolCalls = parsed.tool_calls || [];
        if (parsed.usage) {
          finishUsage = normalizeUsage({
            promptTokens: parsed.usage.promptTokens ?? parsed.usage.inputTokens ?? 0,
            completionTokens: parsed.usage.completionTokens ?? parsed.usage.outputTokens ?? 0,
            totalTokens: parsed.usage.totalTokens ?? 0,
            cacheRead: parsed.usage.cacheRead,
            cacheWrite: parsed.usage.cacheWrite,
            cacheMiss: parsed.usage.cacheMiss,
          });
        }
        output.usage = finishUsage;
      } catch {
        output.content = result.result;
        output.finishReason = "stop";
      }

      return this.finalizeOutput(
        request,
        ctx,
        output,
        finishUsage,
        startTime,
        `adapter-fallback:${adapter.name}`,
      );
    }

    // Adapter 成功路径：将 ChatResponse 转为 LLMInvokeResult
    output.content = resp.text || "";
    output.finishReason = resp.finishReason as any;
    output.toolCalls = (resp.toolCalls as any) || [];
    if (resp.usage) {
      // Task #4373: pass the WHOLE usage through normalizeUsage() instead of
      // rebuilding a 3-field literal. The adapter layer already resolved
      // cacheRead / cacheWrite / cacheMiss — re-listing only
      // {promptTokens, completionTokens, totalTokens} silently discarded them,
      // which is why no production span ever exposed cache metrics.
      finishUsage = normalizeUsage(resp.usage);
    }
    output.usage = finishUsage;

    return this.finalizeOutput(
      request,
      ctx,
      output,
      finishUsage,
      startTime,
      adapter.name,
    );
  }

  /**
   * Task #2719: 消费 adapter.stream() 返回的事件流，把 pi-ai AssistantMessageEvent
   * 转成 llm.text / llm.reasoning env 事件（这样 Ink interactive 可以逐字渲染），
   * 然后调用 streamHandle.result() 拿到最终 ChatResponse。
   *
   * 处理的事件类型（pi-ai AssistantMessageEvent）：
   * - text_delta → llm.text (delta + 累计 content)
   * - thinking_delta → llm.reasoning (delta + 累计 content)
   * - 其他事件（start/text_start/text_end/thinking_start/thinking_end/toolcall_xxx/done/error）跳过
   *
   * AiSdkAdapter.stream() 会 yield 单个完整 output 对象（不包含 type 字段），
   * 不属于以上任意类型，所以不会被错误识别为流式事件。
   */
  private async consumeStreamAndGetResult(
    streamHandle: StreamHandle,
    request: LLMInvokeRequest,
    ctx: InvokeContext,
  ): Promise<ChatResponse> {
    let accumulatedText = "";
    let accumulatedReasoning = "";
    let capturedResult: ChatResponse | undefined;

    const emitEnvEvent = (fullType: string, payload: Record<string, unknown>) => {
      try {
        this.env?.pushEnvEvent?.({
          id: randomUUID(),
          type: fullType,
          timestamp: Date.now(),
          metadata: {
            source: "llm.adapter.stream",
            sessionId: request.context?.sessionId,
            messageId: request.context?.messageId,
            provider: ctx.providerId,
            model: ctx.model,
          },
          payload,
        });
      } catch (err) {
        logger.warn(`Failed to push env event ${fullType}`, { error: String(err) });
      }
    };

    try {
      for await (const rawEvent of streamHandle.events) {
        const event = rawEvent as { type?: string; delta?: string; contentIndex?: number } | null;
        if (!event || typeof event !== "object") continue;
        switch (event.type) {
          case "text_delta": {
            if (typeof event.delta === "string" && event.delta.length > 0) {
              accumulatedText += event.delta;
              emitEnvEvent("llm.text", {
                type: "text",
                content: accumulatedText,
                delta: event.delta,
                contentIndex: event.contentIndex,
              });
            }
            break;
          }
          case "thinking_delta": {
            if (typeof event.delta === "string" && event.delta.length > 0) {
              accumulatedReasoning += event.delta;
              emitEnvEvent("llm.reasoning", {
                type: "reasoning",
                content: accumulatedReasoning,
                delta: event.delta,
                contentIndex: event.contentIndex,
              });
            }
            break;
          }
          // 其他事件类型（start/text_start/text_end/thinking_start/thinking_end/
          // toolcall_xxx/done/error）暂不直接转发，
          // 等 result() 返回后由 finalizeOutput 统一处理 usage / finishReason。
          default:
            break;
        }
      }
    } finally {
      // P1-6: Always call .result() to ensure resource cleanup, even if the
      // for-await loop was interrupted by an abort or exception. This is the
      // safety net that releases any underlying resources held by the stream.
      try {
        capturedResult = await streamHandle.result();
      } catch (resultErr) {
        // result() itself failed — if we already have accumulated text, return
        // a best-effort aborted response; otherwise rethrow so the caller
        // can fall back to the AI SDK path.
        if (accumulatedText) {
          capturedResult = {
            text: accumulatedText,
            finishReason: "aborted",
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          };
        } else {
          throw resultErr;
        }
      }
    }

    return capturedResult!;
  }

  /**
   * 公共收尾逻辑：threshold check + return LLMInvokeResult
   */
  private finalizeOutput(
    request: LLMInvokeRequest,
    ctx: InvokeContext,
    output: {
      content: string;
      reasoning?: string;
      finishReason: "length" | "stop" | "content-filter" | "tool-calls" | "function-call";
      toolCalls?: any[];
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    },
    finishUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined,
    startTime: number,
    adapterName: string,
  ): LLMInvokeResult {
    const latencyMs = Date.now() - startTime;

    // 检测上下文阈值（除非 skipThresholdCheck 为 true）
    if (!request.skipThresholdCheck) {
      const sessionId = request.context?.sessionId;
      const contextError = this.checkContextThreshold(
        finishUsage,
        ctx.providerId,
        ctx.model,
        sessionId
      );

      if (contextError) {
        (contextError as { llmOutput?: unknown }).llmOutput = {
          content: output.content,
          reasoning: output.reasoning,
          toolCalls: output.toolCalls,
          usage: output.usage,
          adapter: adapterName,
        };
        throw contextError;
      }
    }

    // Task #4396: publish `llm.completed` with this call's usage.
    //
    // Why here: `finalizeOutput()` is the single place where every successful
    // `LLMComponent.invoke()` path converges AFTER `normalizeUsage()` has
    // reconciled the cache-aware usage (`cacheRead` / `cacheWrite` /
    // `promptTokensTotal`). Before this, the component only emitted
    // `llm.text` / `llm.reasoning`, so `StreamOutputService.handleCompleted()`
    // was unreachable on the interactive-TUI path (its only producer lived in
    // `invoke.ts::invokeNonStream()`, which the TUI never calls) — which is
    // exactly why no cache metrics could reach the Ink layer.
    //
    // Note: this fires only on the success path (finalizeOutput throws before
    // reaching here when the context threshold is exceeded, and any adapter
    // error propagates before the call), so a failed call emits no
    // `llm.completed`.
    this.emitCompletedEvent(
      request,
      `${ctx.providerId}/${ctx.model}`,
      output.content,
      output.usage,
      adapterName,
    );

    return {
      output,
      providerId: ctx.providerId,
      model: ctx.model,
      latencyMs,
    };
  }

  /**
   * Task #4396: publish the `llm.completed` env event.
   *
   * Payload shape must match what `StreamOutputService.handleCompleted()`
   * reads (`payload.metadata.usage` + `payload.metadata.model`), otherwise the
   * TUI footer silently degrades to nothing.
   */
  private emitCompletedEvent(
    request: LLMInvokeRequest,
    model: string,
    content: string,
    usage: LLMInvokeResult["output"]["usage"],
    adapterName: string,
  ): void {
    try {
      this.env?.pushEnvEvent?.({
        id: randomUUID(),
        type: "llm.completed",
        timestamp: Date.now(),
        metadata: {
          source: "llm.component.invoke",
          sessionId: request.context?.sessionId,
          messageId: request.context?.messageId,
        },
        payload: {
          type: "completed",
          content,
          metadata: {
            model,
            usage,
            adapter: adapterName,
          },
        },
      });
    } catch (err) {
      // Never let observability break the LLM call.
      logger.warn("Failed to push llm.completed event", { error: String(err) });
    }
  }

  /**
   * 获取 Provider API Key
   */
  private getApiKey(providerId: string): string | undefined {
    const providers = this.getLLMConfig<LLMConfig["providers"]>("llm.providers", {});
    return providers?.[providerId]?.apiKey;
  }

  /**
   * 获取 Provider
   */
  getProvider(id: string) {
    const providers = this.getLLMConfig<LLMConfig["providers"]>("llm.providers", {});
    return providers?.[id];
  }

  /**
   * 列出所有 Provider
   */
  listProviders() {
    const providers = this.getLLMConfig<LLMConfig["providers"]>("llm.providers", {});
    return Object.keys(providers || {});
  }

  /**
   * 获取模型的限制配置
   * 
   * @param providerId - Provider ID
   * @param modelId - 模型 ID（可选，默认使用 provider 的 defaultModel）
   * @returns 模型限制配置，如果没有配置则返回 undefined
   */
  getModelLimits(providerId: string, modelId?: string): ModelLimits | undefined {
    const provider = this.getProvider(providerId);
    if (!provider?.limits) return undefined;

    // 如果没有指定 modelId，尝试获取 provider 的默认模型
    const targetModel = modelId || provider.defaultModel;
    if (!targetModel) return undefined;

    return provider.limits[targetModel];
  }

  /**
   * 获取上下文窗口阈值配置
   * 
   * @param providerId - Provider ID
   * @param modelId - 模型 ID
   * @returns 包含 contextWindow 和 thresholdRatio 的对象
   */
  getContextThresholdConfig(providerId: string, modelId?: string): { contextWindow: number; thresholdRatio: number } {
    // 默认值
    const defaults = {
      contextWindow: 128000,  // 默认 128K 上下文窗口
      thresholdRatio: 0.9,    // 默认 90% 时触发
    };

    const limits = this.getModelLimits(providerId, modelId);
    if (!limits) return defaults;

    return {
      contextWindow: limits.contextWindow || defaults.contextWindow,
      thresholdRatio: limits.compactionThreshold ?? defaults.thresholdRatio,
    };
  }

  /**
   * 检测上下文阈值是否超过
   * 
   * @param usage - LLM 使用量信息
   * @param providerId - Provider ID
   * @param modelId - 模型 ID
   * @param sessionId - Session ID（用于错误信息）
   * @returns 如果超过阈值，返回 ContextError；否则返回 undefined
   */
  checkContextThreshold(
    usage: { totalTokens: number; promptTokens?: number; completionTokens?: number } | undefined,
    providerId: string,
    modelId: string | undefined,
    sessionId?: string
  ): ContextError | undefined {
    if (!usage) return undefined;

    const config = this.getContextThresholdConfig(providerId, modelId);
    const threshold = config.contextWindow * config.thresholdRatio;

    if (usage.totalTokens >= threshold) {
      return new ContextError(
        `Context threshold exceeded: ${usage.totalTokens}/${config.contextWindow} (${(usage.totalTokens / config.contextWindow * 100).toFixed(1)}%)`,
        ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
        sessionId,
        {
          promptTokens: usage.promptTokens ?? 0,
          completionTokens: usage.completionTokens ?? 0,
          totalTokens: usage.totalTokens,
        },
        config.contextWindow
      );
    }

    return undefined;
  }
}
