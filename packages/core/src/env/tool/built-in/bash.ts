import { z } from "zod";
import { Effect } from "effect";
import type { Tool, ToolContext, ToolResult } from "../types";
import { propagation } from "../../log-trace/opentelemetry/propagation";
import { wrapFunction } from "../../log-trace/decorator";
import { toolInvokeParamFilter, toolExecResultFilter } from "../../log-trace/trace-filters";
import { BashSpawner, BashSpawnerLayer } from "./bash-effect";

/**
 * 获取当前 Span Context（用于设置父 span）
 */
function getCurrentSpanContext(): { traceId: string; spanId: string; parentSpanId?: string } | undefined {
  try {
    const { getTracerProvider } = require("../../log-trace/opentelemetry/tracer-provider");
    const provider = getTracerProvider();
    if (!provider.isInitialized()) {
      throw new Error("Provider not initialized");
    }
    const tracer = provider.getTracer('roy-tracer');
    const ctx = tracer.getCurrentContext();
    if (ctx && ctx.traceId && ctx.spanId) {
      return ctx;
    }
  } catch {
    // OTel tracer 未初始化或没有当前上下文
  }
  return undefined;
}

/**
 * 获取当前 traceId
 */
function getCurrentTraceId(): string | undefined {
  const ctx = getCurrentSpanContext();
  if (ctx) {
    return ctx.traceId;
  }
  // Fallback: 从环境变量读取
  return process.env.TRACE_ID;
}

/**
 * Bash 工具
 * 
 * 使用 Effect 架构实现，支持正确的 stdin 生命周期管理。
 * 
 * 关键特性：
 * 1. 使用 Effect/Scope 管理进程生命周期
 * 2. stdin 保持打开直到 Effect 完成
 * 3. 支持 OpenTelemetry W3C TraceContext 跨进程追踪
 * 
 * 跨平台兼容：
 * - Windows: 使用 cmd.exe
 * - Linux/macOS: 使用 bash
 */
export const bashTool: Tool = {
  name: "bash",
  description: "Execute shell commands in the terminal. Use this to run system commands, scripts, or interact with the file system.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    workdir: z.string().optional().describe("Working directory for the command"),
    timeout: z.number().int().positive().optional().describe("Timeout in milliseconds"),
    env: z.record(z.string()).optional().describe("Additional environment variables"),
  }),
  sandbox: {
    enabled: true,
    config: {
      filesystem: {
        denyRead: ["/etc/shadow", "/etc/sudoers", "/etc/sudoers.d/*"],
        denyWrite: ["/etc", "/usr/bin", "/usr/sbin", "/bin", "/sbin"],
      },
    },
  },
  permission: {
    requireConfirmation: true,
    level: "dangerous",
  },
  metadata: {
    category: "system",
    tags: ["shell", "command", "terminal", "exec"],
    version: "2.0.0",
  },
  execute: wrapFunction(async (args, ctx: ToolContext): Promise<ToolResult> => {
    const startTime = Date.now();
    const { command, workdir, timeout = 60000, env } = args;

    // 获取当前 span 上下文
    const currentSpanCtx = getCurrentSpanContext();
    const traceId = currentSpanCtx?.traceId || getCurrentTraceId();

    // 确定工作目录
    const cwd = workdir || ctx.workdir;

    // 构建子进程的环境变量
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        childEnv[key] = value;
      }
    }

    // 使用 W3C TraceContext 注入 TRACEPARENT
    if (currentSpanCtx) {
      const carrier: Record<string, string | undefined> = {};
      propagation.inject(carrier, currentSpanCtx);
      if (carrier['TRACEPARENT']) {
        childEnv['TRACEPARENT'] = carrier['TRACEPARENT'];
      }
      // 保留向后兼容的环境变量
      childEnv['TRACE_ID'] = currentSpanCtx.traceId;
      childEnv['PARENT_SPAN_ID'] = currentSpanCtx.spanId;
    } else if (traceId) {
      // 如果没有当前上下文但有 traceId，创建根 span 的 traceparent
      const spanId = Math.floor(Math.random() * 0xFFFFFFFFFFFFFFFF)
        .toString(16)
        .padStart(16, "0");
      childEnv['TRACEPARENT'] = `00-${traceId}-${spanId}-01`;
      childEnv['TRACE_ID'] = traceId;
    }

    // 用户提供的 env 优先级最高
    if (env) {
      Object.assign(childEnv, env);
    }

    // ★ Task #5659：合并 EnvContext.toolEnv（ES config 注入，
    //   解决 #5654 跨组织泄漏）。用户显式传的 env 优先级仍最高
    //   —— toolEnv 先合并，env 后合并（上方代码顺序保证）。
    //   无 EnvContext（交互式 CLI）时为空对象，行为不变。
    try {
      const { getEnvContextOrEmpty } = await import(
        "../../context/env-context"
      );
      Object.assign(childEnv, getEnvContextOrEmpty().toolEnv ?? {});
      if (env) {
        Object.assign(childEnv, env);
      }
    } catch {
      /* context 模块不可用时行为不变 */
    }

    // 使用 OTel tracer 创建 span
    let otelSpan: any = undefined;
    try {
      const { getTracerProvider } = require("../../log-trace/opentelemetry/tracer-provider");
      const provider = getTracerProvider();
      const tracer = provider.getTracer('roy-tracer');
      otelSpan = tracer.startSpan(`bash: ${command.slice(0, 50)}${command.length > 50 ? "..." : ""}`, {
        attributes: {
          'bash.command': command.slice(0, 200),
          'bash.workdir': cwd || '',
          'bash.timeout': timeout,
          'bash.platform': process.platform,
        },
      });
    } catch {
      // OTel tracer 不可用，继续执行
    }

    const spanId = otelSpan?.spanContext?.spanId;

    try {
      // 使用 Effect 架构执行命令
      const program = Effect.gen(function* () {
        const spawner = yield* BashSpawner;
        const result = yield* spawner.run(command, {
          cwd,
          timeout,
          env: childEnv,
        });
        return result;
      });

      const result = await Effect.runPromise(
        program.pipe(
          Effect.scoped,
          Effect.provide(BashSpawnerLayer)
        )
      );

      // 结束 span
      if (otelSpan) {
        if (result.timedOut) {
          const execError = new Error(`Command timed out after ${timeout}ms`);
          execError.name = "BashExecutionError";
          otelSpan.end(undefined, execError);
        } else if (result.exitCode !== 0) {
          const execError = new Error(result.stderr || "Command failed");
          execError.name = "BashExecutionError";
          otelSpan.end(undefined, execError);
        } else {
          otelSpan.end({ stdout: result.stdout, stderr: result.stderr });
        }
      }

      return {
        success: !result.timedOut && result.exitCode === 0,
        output: result.stdout || "(no output)",
        error: result.timedOut 
          ? `Command timed out after ${timeout}ms` 
          : (result.exitCode !== 0 ? result.stderr : undefined),
        metadata: {
          execution_time_ms: Date.now() - startTime,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          trace_id: traceId,
          parent_span_id: currentSpanCtx?.spanId,
          span_id: spanId,
          platform: process.platform,
        },
      };
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 结束 span（带错误）
      const execError = new Error(errorMessage);
      execError.name = "BashExecutionError";

      if (otelSpan) {
        otelSpan.end(undefined, execError);
      }

      return {
        success: false,
        output: "",
        error: errorMessage,
        metadata: {
          execution_time_ms: Date.now() - startTime,
          exit_code: 1,
          timed_out: false,
          trace_id: traceId,
          parent_span_id: currentSpanCtx?.spanId,
          span_id: spanId,
          platform: process.platform,
        },
      };
    }
  }, 'tool.bash.execute', {
    paramFilter: toolInvokeParamFilter,
    resultFilter: toolExecResultFilter,
    logResult: true,
  }),
};
