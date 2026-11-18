/**
 * @fileoverview OpenTelemetry 模块统一导出
 * 
 * @example
 * import { getTracerProvider, propagation } from './opentelemetry/mod';
 * 
 * // 初始化
 * const provider = getTracerProvider();
 * await provider.initialize();
 * 
 * // 获取 Tracer
 * const tracer = provider.getTracer('my-service');
 * 
 * // 启动 Span
 * const span = tracer.startSpan('my-operation');
 * 
 * // 注入到环境变量
 * const env: Record<string, string | undefined> = {};
 * tracer.injectToEnv(env);
 * process.env = { ...process.env, ...env };
 */

export { OTelTracerProvider, getTracerProvider, resetTracerProvider, type OTelTracer, type OTelSpan, type SpanOptions } from './tracer-provider';
export { propagation, serialize, parse, type ExtractedContext } from './propagation';
export { injectToEnv, injectToEnvWithContext, injectToEnvFromCarrier, getTraceparentHeader, type EnvCarrier } from './propagation-env';
