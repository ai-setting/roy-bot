/**
 * @fileoverview Log & Trace 模块导出
 * 
 * OpenTelemetry 标准接口
 */

// Types
export {
  type Span,
  type SpanContext,
  type SpanAttributes,
  type TraceInfo,
  type SpanStorage,
  type ITraceContext,
  type LogLevel,
  type LoggerConfig,
  type ILogger,
  type TraceContextOptions,
} from "./types";

export { SpanKind, SpanStatus } from "./types";

// Storage
export { SQLiteSpanStorage } from "./span-storage";

// Component
export {
  LogTraceComponent,
  type LogTraceConfig,
  type LogTraceComponentOptions,
  LogTraceConfigSchema,
  getDefaultLogDir,
  getDefaultSpanDbPath,
} from "./log-trace-component";

// OpenTelemetry Tracer Provider
export {
  OTelTracerProvider,
  getTracerProvider,
  resetTracerProvider,
  type OTelTracer,
  type OTelSpan,
  type SpanOptions,
} from "./opentelemetry/tracer-provider";

// OpenTelemetry Propagation
export {
  propagation,
  serialize,
  parse,
  type ExtractedContext,
} from "./opentelemetry/propagation";

export {
  injectToEnv,
  injectToEnvWithContext,
  injectToEnvFromCarrier,
  getTraceparentHeader,
  type EnvCarrier,
} from "./opentelemetry/propagation-env";

// Logger
export {
  createLogger,
  setQuietMode,
  isQuietMode,
  // Task #4619: stdout-strict mode — for stdio hosts (MCP) whose stdout
  // carries the protocol and nothing else.
  setStdoutStrictMode,
  isStdoutStrictMode,
  setConfigComponent as setLoggerConfigComponent,
  getLogLevel,
  getLogLevels,
  getLogDir,
  getLogFile,
  setLogDirOverride,
  getLogDirOverride,
  simplifyFilePath,
  getMaxOutput,
} from "./logger";

// Decorator
export { TracedAs, Traced, TracedLightweight, wrapFunction, type TracedOptions } from "./decorator";

// Trace 参数瘦身过滤器（Task #4479）
// 这些 filter 是「共享」的 —— CLI / plugin / 外部 harness 也可能想用同一套摘要逻辑，
// 所以必须从模块入口导出，而不是只能在包内 import 相对路径。
export {
  isTraceFullMode,
  resetTraceFullModeCache,
  llmInvokeParamFilter,
  llmInvokeResultFilter,
  messagesParamFilter,
  toolExecParamFilter,
  toolInvokeParamFilter,
  toolExecResultFilter,
  envQueryParamFilter,
  agentRunParamFilter,
  recordSessionMessagesParamFilter,
  embedParamFilter,
  embedResultFilter,
} from "./trace-filters";
