/**
 * @fileoverview Debug Span Command
 * 
 * Command: roy debug span <spanId>
 * 
 * 通过 spanId 从 SQLite 中查询详细的 span 信息
 */

import * as path from "path";
import * as os from "os";
import type { CommandModule } from "yargs";
import { SQLiteSpanStorage } from "@ai-setting/roy-bot-core";
import type { Span } from "@ai-setting/roy-bot-core";

interface SpanOptions {
  spanId?: string;
  db?: string;
}

export const SpanCommand: CommandModule<object, SpanOptions> = {
  command: "span",
  describe: "通过 spanId 查询详细的 span 信息",

  builder: (yargs) =>
    yargs
      .positional("spanId", {
        type: "string",
        describe: "Span ID",
        demandOption: true,
      })
      .option("db", {
        type: "string",
        describe: "SQLite 数据库路径（可选，默认使用配置路径）",
      }),

  async handler(args) {
    const spanId = args._[2] as string || args.spanId;
    
    if (!spanId) {
      console.error("Error: spanId is required");
      console.error("Usage: roy debug span <spanId>");
      process.exit(1);
    }
    
    // 获取数据库路径
    const dbPath = args.db || getDefaultSpanDbPath();
    
    // 创建存储实例并读取数据
    const storage = new SQLiteSpanStorage(dbPath);
    await storage.initialize();
    
    try {
      // 查询 span
      const span = storage.findBySpanId(spanId);
      
      if (!span) {
        console.log(`Span ${spanId} not found.`);
        return;
      }

      // 格式化输出详细信息
      const output = formatSpanDetail(span);
      console.log(output);
    } finally {
      storage.close();
    }
  },
};

/**
 * 获取默认的 span 数据库路径
 */
export function getDefaultSpanDbPath(): string {
  // 支持环境变量覆盖
  if (process.env.LOG_TRACE_TRACING_DB_PATH) {
    return process.env.LOG_TRACE_TRACING_DB_PATH;
  }
  
  // 使用 XDG 标准路径
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(dataHome, "roy-bot", "traces.db");
}

/**
 * 安全序列化对象，处理循环引用和其他异常
 */
function safeStringify(obj: unknown, indent: number = 2): string {
  // 处理非对象类型
  if (obj === null) return "null";
  if (obj === undefined) return "undefined";
  if (typeof obj !== "object") return String(obj);
  
  // 如果已经是字符串，可能是已经 stringify 过的
  if (typeof obj === "string") {
    // 尝试检测是否是 JSON 字符串
    try {
      const parsed = JSON.parse(obj);
      return safeStringify(parsed, indent);
    } catch {
      return obj;
    }
  }
  
  // 处理数组
  if (Array.isArray(obj)) {
    try {
      const items = obj.map(item => safeStringify(item, 0));
      return `[${items.join(", ")}]`;
    } catch {
      return "[Array - cannot stringify]";
    }
  }
  
  // 使用 WeakSet 检测循环引用
  const seen = new WeakSet<object>();
  
  const stringify = (value: unknown, depth: number): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value !== "object") return JSON.stringify(value);
    
    if (typeof value === "string") {
      // 可能是已经 stringify 过的 JSON 字符串
      try {
        const parsed = JSON.parse(value);
        return JSON.stringify(parsed);
      } catch {
        return JSON.stringify(value);
      }
    }
    
    if (Array.isArray(value)) {
      if (seen.has(value)) return '"[Circular]"';
      seen.add(value);
      const items = value.map(item => stringify(item, depth + 1));
      return `[${items.join(", ")}]`;
    }
    
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    
    const entries = Object.entries(value as Record<string, unknown>);
    const props = entries.map(([k, v]) => `"${k}": ${stringify(v, depth + 1)}`);
    return `{${props.join(", ")}}`;
  };
  
  try {
    return stringify(obj, 0);
  } catch (e) {
    return `[Object - cannot stringify: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

/**
 * 格式化 span 为详细输出
 */
export function formatSpanDetail(span: Span): string {
  const lines: string[] = [];
  
  // 基本信息
  lines.push(`Span ID:    ${span.spanId}`);
  lines.push(`Trace ID:   ${span.traceId}`);
  lines.push(`Name:       ${span.name}`);
  lines.push(`Kind:       ${span.kind}`);
  lines.push(`Status:     ${span.status}`);
  
  // 时间信息
  const duration = span.endTime 
    ? `${span.endTime - span.startTime}ms` 
    : "(running)";
  lines.push(`Duration:   ${duration}`);
  lines.push(`Start:      ${span.startTime} (${new Date(span.startTime).toISOString()})`);
  if (span.endTime) {
    lines.push(`End:        ${span.endTime} (${new Date(span.endTime).toISOString()})`);
  }
  
  // 父子关系
  if (span.parentSpanId) {
    lines.push(`Parent:     ${span.parentSpanId}`);
  }
  
  // 错误信息
  if (span.error) {
    lines.push(`Error:      ${span.error}`);
  }
  
  // 属性
  if (span.attributes && Object.keys(span.attributes).length > 0) {
    lines.push("");
    lines.push("Attributes:");
    for (const [key, value] of Object.entries(span.attributes)) {
      lines.push(`  ${key}: ${safeStringify(value, 0)}`);
    }
  }
  
  // 结果
  if (span.result !== undefined) {
    lines.push("");
    lines.push("Result:");
    // 如果是字符串，尝试解析为 JSON 显示；如果是已损坏的数据，显示提示
    const resultStr = typeof span.result === "string"
      ? (span.result.includes("[Object with circular reference") 
          ? "[Circular reference - original data contained circular structures]" 
          : span.result)
      : safeStringify(span.result);
    lines.push(`  ${resultStr}`);
  }
  
  return lines.join("\n");
}
