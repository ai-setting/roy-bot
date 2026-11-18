import type { LLMConfig, LLMProvider, ProviderConfig, ProviderType } from "./types";

/**
 * Provider 管理器
 * 负责创建和管理 LLM Provider 实例
 */
export class ProviderManager {
  private providers = new Map<string, LLMProvider>();

  /**
   * 从配置初始化所有 Provider
   */
  async initialize(config: LLMConfig): Promise<void> {
    this.providers.clear();

    for (const [id, providerConfig] of Object.entries(config.providers)) {
      const resolvedConfig = await this.resolveProviderConfig(providerConfig);
      const provider = this.createProvider(id, resolvedConfig);
      this.providers.set(id, provider);
    }
  }

  /**
   * 获取 Provider
   */
  getProvider(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * 列出所有 Provider
   */
  listProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * 解析 Provider 配置中的环境变量
   */
  async resolveProviderConfig(config: ProviderConfig): Promise<ProviderConfig> {
    return {
      ...config,
      apiKey: await this.resolveEnvVar(config.apiKey),
      baseURL: config.baseURL ? await this.resolveEnvVar(config.baseURL) : undefined,
    };
  }

  /**
   * 解析环境变量
   * 支持 ${VAR} 格式
   */
  async resolveEnvVar(value: string): Promise<string> {
    // 检查是否包含环境变量模式
    const envVarPattern = /\$\{([^}]+)\}/g;
    const matches = [...value.matchAll(envVarPattern)];

    if (matches.length === 0) {
      return value;
    }

    // 替换所有环境变量
    let result = value;
    for (const match of matches) {
      const varName = match[1];
      const envValue = process.env[varName];

      if (envValue === undefined) {
        throw new Error(`Environment variable ${varName} is not set`);
      }

      result = result.replace(match[0], envValue);
    }

    return result;
  }

  /**
   * 创建 Provider 实例
   * 注意：实际创建需要根据 Provider 类型调用对应的 AI SDK
   * 这里返回占位实现，真正的 Provider 创建需要 AI SDK 依赖
   */
  private createProvider(id: string, config: ProviderConfig): LLMProvider {
    // 实际的 Provider 创建需要 AI SDK
    // 这里返回基本信息，实际的 provider.instance 需要由 AI SDK 创建
    return {
      id,
      provider: null, // 将在实际使用时由 AI SDK 创建
      models: config.models || [],
    };
  }

  /**
   * 根据类型创建实际的 Provider 实例
   * 需要外部传入 AI SDK 的 createProvider
   */
  createAIProvider(
    id: string,
    config: ProviderConfig,
    createFn: (apiKey: string, baseURL?: string) => unknown
  ): LLMProvider {
    const providerInstance = createFn(config.apiKey, config.baseURL);
    return {
      id,
      provider: providerInstance,
      models: config.models || [],
    };
  }
}
