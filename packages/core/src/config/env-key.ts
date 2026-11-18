/**
 * 环境变量键名转换工具
 * 
 * 提供统一的环境变量键名转换逻辑，供 EnvSource 和其他组件使用
 * 
 * 转换规则（toEnvKey）：
 * 1. 将点号替换为下划线
 * 2. 将驼峰命名转换为下划线分隔的大写形式
 * 3. 拼接前缀（如果前缀不以_结尾则自动添加）
 * 
 * 转换规则（fromEnvKey - 用于 EnvSource）：
 * 1. 移除前缀
 * 2. 保持原始格式（大小写）
 * 
 * 转换规则（envKeyToConfigKey - 通用）：
 * 1. 移除前缀
 * 2. 转小写
 * 3. 将下划线替换为点号
 * 4. 拼接组件名前缀
 * 
 * @example
 * // toEnvKey
 * toEnvKey("llm.defaultModel", "LLM") -> "LLM_LLM_DEFAULT_MODEL"
 * toEnvKey("logTrace.level", "LOG") -> "LOG_LOG_TRACE_LEVEL"
 * 
 * // fromEnvKey (用于 EnvSource.list)
 * fromEnvKey("LLM_LLM_DEBUG", "LLM_") -> "DEBUG"
 * 
 * // envKeyToConfigKey (通用，支持任意组件)
 * envKeyToConfigKey("LLM_LLM_DEFAULT_MODEL", "LLM", "llm") -> "llm.default.model"
 * envKeyToConfigKey("LOG_LOG_TRACE_LEVEL", "LOG", "logTrace") -> "logTrace.level"
 */

/**
 * 将点号路径转换为环境变量名（带前缀）
 *
 * 规则：
 * - `.` 和 `-` 都替换为路径分隔符 `_`
 * - 驼峰转为下划线大写
 * - 如果 key 规范化后的首段与 prefix 的去下划线大写形式一致，
 *   则不再重复添加前缀（避免 "LLM_LLM_DEFAULT_PROVIDER" 这种双重前缀）
 *
 * 转换示例（Bug #2186 Bug 1 修复后）：
 * - `llm.defaultModel` + `LLM` -> `LLM_DEFAULT_MODEL`（无双 LLM 前缀）
 * - `logTrace.level` + `LOG` -> `LOG_LEVEL`
 * - `log-trace.logging.dir` + `LOG_TRACE` -> `LOG_TRACE_LOGGING_DIR`
 * - `DEBUG` + `LLM` -> `LLM_DEBUG`（首段不匹配 prefix，正常前缀化）
 *
 * @example
 * toEnvKey("llm.defaultModel", "LLM") -> "LLM_DEFAULT_MODEL"
 * toEnvKey("log-trace.logging.dir", "LOG_TRACE") -> "LOG_TRACE_LOGGING_DIR"
 * toEnvKey("DEBUG", "MY_APP_") -> "MY_APP_DEBUG"
 */
export function toEnvKey(key: string, prefix: string): string {
  // 1. 将点号和连字符替换为下划线
  let keyNormalized = key.replace(/[.-]/g, "_");

  // 2. 将驼峰命名转换为下划线分隔的大写形式
  keyNormalized = keyNormalized
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/_+/g, "_")
    .toUpperCase();

  // 3. 拼接前缀
  if (prefix) {
    // 去前缀两端的下划线，得到纯大写 prefix 形式，用于"首段是否已经包含 prefix"的判定
    const prefixCore = prefix.toUpperCase().replace(/^_+|_+$/g, "");
    const prefixCoreWithSep = `${prefixCore}_`;

    // 如果 key 规范化后已经以 prefixCore 开头（带分隔符），
    // 则跳过添加 prefix，避免出现 "LLM_LLM_DEFAULT_PROVIDER" 这种双前缀
    // 也支持多段 prefix（如 "LOG_TRACE"），保证 "LOG_TRACE_LOGGING_DIR" 不变成 "LOG_TRACE_LOG_TRACE_LOGGING_DIR"
    if (prefixCore && keyNormalized.startsWith(prefixCoreWithSep)) {
      return keyNormalized;
    }

    // 如果前缀已以下划线结尾，不要重复添加
    const separator = prefix.endsWith("_") ? "" : "_";
    return `${prefix}${separator}${keyNormalized}`;
  }
  return keyNormalized;
}

/**
 * 从环境变量名提取内部键名（移除前缀，保持原始格式）
 * 
 * 用于 EnvSource.list() 等需要保持原始格式的场景
 */
export function fromEnvKey(envKey: string, prefix: string): string {
  if (!prefix) {
    return envKey;
  }
  
  // 检查前缀匹配
  if (envKey.startsWith(prefix)) {
    const afterPrefix = envKey.slice(prefix.length);
    // 移除开头的下划线（如果有）
    if (afterPrefix.startsWith("_")) {
      return afterPrefix.slice(1);
    }
    return afterPrefix;
  }
  return envKey;
}

/**
 * 将环境变量名转换为配置键名（通用，支持任意组件）
 * 
 * 规则：
 * - `_` 转换为 `.` 作为键路径分隔符
 * - 组件名中的 `-` 在环境变量中也会是 `_`（因为 toEnvKey 会转换）
 * 
 * 环境变量格式约定:
 * - PREFIX_KEY: 如 LLM_DEFAULT_MODEL -> llm.default.model
 * - PREFIX_COMPONENT_KEY: 如 LLM_LLM_DEFAULT_MODEL -> llm.default.model
 * - 对于带连字符的组件名: 如 LOG_TRACE_LOGGING_LEVEL -> log-trace.logging.level (当组件名为 log-trace)
 * 
 * @param envKey - 环境变量名（如 LLM_LLM_DEFAULT_MODEL 或 LOG_TRACE_LOGGING_LEVEL）
 * @param prefix - 环境变量前缀（如 LLM 或 LOG）
 * @param componentName - 组件名（如 llm, logTrace, log-trace）
 * @returns 配置键名（如 llm.default.model 或 log-trace.logging.level）
 * 
 * @example
 * // 格式1: PREFIX_KEY
 * envKeyToConfigKey("LLM_DEFAULT_MODEL", "LLM", "llm") -> "llm.default.model"
 * 
 * // 格式2: PREFIX_COMPONENT_KEY
 * envKeyToConfigKey("LLM_LLM_DEFAULT_MODEL", "LLM", "llm") -> "llm.default.model"
 * 
 * // 格式3: 连字符组件名（环境变量中 - 会被转成 _）
 * envKeyToConfigKey("LOG_TRACE_LOGGING_LEVEL", "LOG", "log-trace") -> "log-trace.logging.level"
 */
export function envKeyToConfigKey(envKey: string, prefix: string, componentName: string): string | undefined {
  const prefixUpper = prefix.toUpperCase();
  
  if (!envKey.startsWith(prefixUpper)) {
    return undefined;
  }
  
  // 将组件名转换为下划线大写格式用于比较
  const componentUpperNormalized = componentName
    .replace(/-/g, "_")
    .toUpperCase();
  
  // 移除前缀
  let keyPart = envKey.slice(prefixUpper.length);
  
  // 移除前缀后的分隔符
  if (keyPart.startsWith("_")) {
    keyPart = keyPart.slice(1);
  }
  
  if (!keyPart) {
    return undefined;
  }
  
  // 找出第一个下划线的位置
  const firstUnderscore = keyPart.indexOf("_");
  let restPart: string;
  
  if (firstUnderscore === -1) {
    // 没有下划线，整个作为 rest
    restPart = keyPart;
  } else {
    const firstPart = keyPart.slice(0, firstUnderscore);
    const remaining = keyPart.slice(firstUnderscore + 1);
    
    // 检查第一段是否等于组件名的大写形式
    if (firstPart === componentUpperNormalized) {
      // 匹配成功，移除组件名前缀
      restPart = remaining;
    } else {
      // 第一段不是组件名，整个 keyPart 作为 rest
      restPart = keyPart;
    }
  }
  
  if (!restPart) {
    return undefined;
  }
  
  // 将下划线转换为点号，转小写，拼接组件名
  const restPartConverted = restPart.replace(/_/g, ".");
  
  return `${componentName}.${restPartConverted.toLowerCase()}`;
}

/**
 * 从环境变量键名提取组件名
 * 
 * 用于自动发现所有以 prefix 开头的环境变量
 * 
 * @param envKey - 环境变量名
 * @param prefix - 前缀
 * @returns 组件名和剩余部分（如 ["llm", "default.model"]）
 */
export function extractComponentFromEnvKey(envKey: string, prefix: string): [string, string] | undefined {
  const prefixUpper = prefix.toUpperCase();
  
  if (!envKey.startsWith(prefixUpper)) {
    return undefined;
  }
  
  // 移除前缀
  let keyPart = envKey.slice(prefixUpper.length);
  // 移除前缀后的下划线（如果有）
  if (keyPart.startsWith("_")) {
    keyPart = keyPart.slice(1);
  }
  
  if (!keyPart) {
    return undefined;
  }
  
  // 提取组件名（第一段下划线之前的部分）
  const underscoreIndex = keyPart.indexOf("_");
  if (underscoreIndex === -1) {
    // 只有一个部分，如 LLM_DEFAULT_MODEL -> llm.default_model
    return [keyPart.toLowerCase().replace(/_/g, "."), ""];
  }
  
  const component = keyPart.slice(0, underscoreIndex).toLowerCase();
  const rest = keyPart.slice(underscoreIndex + 1);
  
  return [`${component}.${rest.replace(/_/g, ".")}`, rest];
}
