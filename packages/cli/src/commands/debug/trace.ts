/**
 * @fileoverview Debug Trace Command
 * 
 * Command:
 *   roy debug trace <traceId>             以 tree 方式展示 traceId 的 spans
 *   roy debug trace --list [--limit N]    列出最近的 N 条 trace
 */

import * as path from "path";
import * as os from "os";
import type { CommandModule } from "yargs";
import { SQLiteSpanStorage } from "@ai-setting/roy-bot-core";
import type { Span, TraceInfo } from "@ai-setting/roy-bot-core";

interface TraceOptions {
  traceId?: string;
  db?: string;
  list?: boolean;
  limit?: number;
  json?: boolean;
}

export const TraceCommand: CommandModule<object, TraceOptions> = {
  command: "trace",
  describe: "以 tree 方式查看 trace 的 spans，或用 --list 列出最近的 trace",

  builder: (yargs) =>
    yargs
      .positional("traceId", {
        type: "string",
        describe: "Trace ID（--list 时可省略）",
      })
      .option("list", {
        type: "boolean",
        default: false,
        describe: "列出最近的 trace",
      })
      .option("limit", {
        alias: "n",
        type: "number",
        default: 20,
        describe: "配合 --list 使用，返回最近 N 条 trace",
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        describe: "以 JSON 输出（配合 --list）",
      })
      .option("db", {
        type: "string",
        describe: "SQLite 数据库路径（可选，默认使用配置路径）",
      }),

  async handler(args) {
    const traceId = (args._[2] as string) || args.traceId;
    
    if (!args.list && !traceId) {
      console.error("Error: traceId is required (or use --list)");
      console.error("Usage: roy debug trace <traceId>");
      console.error("       roy debug trace --list [--limit N]");
      process.exit(1);
    }
    
    // 获取数据库路径
    const dbPath = args.db || getDefaultSpanDbPath();
    
    // 创建存储实例并读取数据
    const storage = new SQLiteSpanStorage(dbPath);
    await storage.initialize();
    
    try {
      if (args.list) {
        const limit = args.limit ?? 20;
        const traces = storage.listTraces(limit);

        if (args.json) {
          console.log(JSON.stringify({
            count: traces.length,
            limit,
            traces,
          }, null, 2));
        } else {
          console.log(formatTraceList(traces));
        }
        return;
      }

      // 查询 spans
      const spans = storage.findByTraceId(traceId!);
      
      if (spans.length === 0) {
        console.log(`Trace ${traceId} not found.`);
        return;
      }

      // 格式化输出为 tree
      // 注意：spans 已经是 buildTree() 返回的根节点数组，每个节点有 children
      const treeOutput = formatSpanTree(spans);
      
      // 分段输出到 stderr，避免被 log-trace 的 maxOutput 截断
      const chunkSize = 4000;
      for (let i = 0; i < treeOutput.length; i += chunkSize) {
        console.error(treeOutput.substring(i, i + chunkSize));
      }
    } finally {
      storage.close();
    }
  },
};

/**
 * 格式化 trace 列表为文本视图
 */
export function formatTraceList(traces: TraceInfo[]): string {
  if (traces.length === 0) {
    return "(no traces)";
  }

  const header = ["#", "TRACE ID", "ROOT", "STARTED", "DURATION", "SPANS", "STATUS"].join(" │ ");

  const rows = traces.map((t, i) => {
    const started = new Date(t.startTime).toLocaleString();
    const duration = t.duration !== undefined ? `${t.duration}ms` : "(running)";
    const root = t.rootSpanName.length > 24
      ? t.rootSpanName.slice(0, 21) + "..."
      : t.rootSpanName;
    return [
      (i + 1).toString(),
      t.traceId,
      root,
      started,
      duration,
      t.spanCount.toString(),
      t.status,
    ].join(" │ ");
  });

  return [header, ...rows, "", `Showing ${traces.length} traces`].join("\n");
}

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
 * 格式化 spans 为 tree 视图
 * 
 * spans 是已经构建好的树结构（根节点数组，每个节点有 children）
 * 直接遍历输出即可
 */
export function formatSpanTree(spans: Span[]): string {
  if (spans.length === 0) {
    return "(empty)";
  }

  // spans 已经是根节点数组，直接格式化
  const lines: string[] = [];
  
  for (const root of spans) {
    formatSpanNode(root, 0, lines);
  }

  return lines.join("\n");
}

/**
 * 递归格式化单个 span
 * 
 * 简化输出：只显示 name、duration、error、spanId
 */
function formatSpanNode(span: Span, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  const connector = depth === 0 ? "" : "└── ";
  
  // 计算耗时
  const duration = span.endTime 
    ? `${span.endTime - span.startTime}ms` 
    : "(running)";
  
  // 构建错误信息
  const errorInfo = span.error 
    ? ` ⚠ ${span.error}` 
    : "";

  // 添加 spanId 显示
  const spanIdInfo = `[spanId:${span.spanId}]`;

  lines.push(`${indent}${connector}${span.name} (${duration})${errorInfo} ${spanIdInfo}`);

  // 递归处理子 span
  for (const child of span.children || []) {
    formatSpanNode(child, depth + 1, lines);
  }
}
