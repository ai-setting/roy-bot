/**
 * @fileoverview Workflow Run Command
 * 
 * Run a workflow from file or by name
 * 
 * Workflow execution model:
 * - run starts the workflow
 * - if ask_user is triggered, workflow stops with status='paused'
 * - resume with: workflow run <name> -s <runId|sessionId> --input "response"
 *   (Task #1837: workflow runId == sessionId, no derivation needed)
 * 
 * OpenTelemetry W3C TraceContext Support:
 * - Supports TRACEPARENT environment variable for trace context propagation
 * - When running via bash tool from interactive mode, TRACEPARENT is passed
 * - The traceId and parentSpanId are extracted from TRACEPARENT
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderRunResult } from '../renderers';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { createRunWorkflowTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import type { ToolContext } from '@ai-setting/roy-bot-core/env/tool/types';
import type { WorkflowService } from '@ai-setting/roy-bot-core/env/workflow/service';
import type { WorkflowDefinition } from '@ai-setting/roy-bot-core/env/workflow/types';
import { getTracerProvider, propagation, wrapFunction } from '@ai-setting/roy-bot-core';
import { isValidSessionId } from '@ai-setting/roy-bot-core/env/session';

export interface WorkflowRunOptions {
  identifier: string;
  debug?: boolean;
  input?: string;
  parallelLimit?: number;
  timeout?: number;
  watch?: boolean;
  file?: boolean;
  name?: string;
  registerOnly?: boolean;
  config?: string;
  /** Resume from existing session (workflow runId == sessionId, Task #1837) */
  session?: string;
  /**
   * Per-node runtime config overrides (Task #1974).
   *
   * JSON string of shape `{ "<nodeId>": { timeout: 5000, ... } }`. Parsed
   * and forwarded to the engine as `RunOptions.nodeConfig`.
   */
  nodeConfig?: string;
}

/**
 * WorkflowRunCommand - Run a workflow
 * 
 * Supports two modes:
 * 1. Run by name: `roy-bot workflow run my-workflow`
 * 2. Run from file: `roy-bot workflow run workflow.yaml --file`
 *    - Optionally register with custom name: `roy-bot workflow run workflow.yaml --file --name my-workflow`
 *    - Register only without running: `roy-bot workflow run workflow.yaml --file --register-only`
 * 
 * Resume paused workflow (Task #1837: runId == sessionId):
 * `roy-bot workflow run <workflow-name> -s <runId|sessionId> --input "user response"`
 */

/**
 * Run workflow implementation
 */
const runWorkflow = wrapFunction(
  async function runWorkflowImpl(args: WorkflowRunOptions): Promise<void> {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    // ========================================================================
    // Initialize OpenTelemetry Trace Context from Environment Variable
    // 
    // When running via bash tool from interactive mode, the TRACEPARENT is passed
    // as environment variable. We initialize the OTel tracer here so that spans
    // in workflow execution are associated with the parent trace.
    // ========================================================================
    
    // 优先使用 W3C TraceContext (TRACEPARENT)
    const traceparent = process.env.TRACEPARENT;
    let traceId: string | undefined;
    let parentSpanId: string | undefined;
    
    if (traceparent) {
      const extracted = propagation.extract(process.env as Record<string, string | undefined>);
      if (extracted) {
        traceId = extracted.traceId;
        parentSpanId = extracted.spanId; // 发送方 span ID 作为新 span 的 parentSpanId
      }
    }
    
    // 回退到旧的 TRACE_ID 环境变量（向后兼容）
    if (!traceId) {
      traceId = process.env.TRACE_ID;
      parentSpanId = process.env.PARENT_SPAN_ID;
    }
    
    output.info(`[OTel Trace] TRACEPARENT=${traceparent || 'none'}, traceId=${traceId}, parentSpanId=${parentSpanId}`);
    
    // 初始化 OTel tracer 并创建 span
    let workflowSpan: any = undefined;
    try {
      const provider = getTracerProvider();
      await provider.initialize();
      const tracer = provider.getTracer('roy-tracer');
      
      // 获取恢复后的上下文（用于调试）
      const restoredContext = tracer.getCurrentContext();
      output.info(`[OTel Trace] Restored context: ${JSON.stringify(restoredContext)}`);
      
      // 从环境变量恢复上下文后创建 span
      // 注意：调用 getTracer 时会触发 restoreFromEnv，但不会自动创建 span
      // 需要手动调用 startSpan 来创建新的 span
      workflowSpan = tracer.startSpan("workflow.run", {
        attributes: {
          'workflow.name': args.identifier,
          'workflow.file': args.file || false,
          'source': 'workflow-cli',
          'workflow.parentSpanId': parentSpanId || 'none',
        },
      });
      
      output.info(`[OTel Trace] Started span: ${workflowSpan.spanContext.spanId}, traceId: ${workflowSpan.spanContext.traceId}, parentSpanId: ${workflowSpan.spanContext.parentSpanId || 'root'}`);
    } catch (error) {
      output.warn(`[OTel Trace] Failed to initialize tracer: ${error}`);
    }

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const workflowComponent = env.getComponent('workflow');

      if (!workflowComponent) {
        output.error('WorkflowComponent not available');
        process.exit(1);
      }

      // 获取 WorkflowService
      const service = (workflowComponent as any).workflowService as WorkflowService;

      if (!service) {
        output.error('WorkflowService not initialized. Please run "roy-bot workflow init" first.');
        process.exit(1);
      }

      // Parse input - support both JSON and plain string
      // For resume scenarios, plain strings like "Yes" are normalized to { userQuery: "Yes" }
      // by engine.runWithResume
      let input: Record<string, any> | string | undefined;
      if (args.input) {
        try {
          input = JSON.parse(args.input);
        } catch {
          // Plain string: pass through on resume; fresh run expects JSON object
          input = args.session ? args.input : undefined;
        }
      }

      // Task #1974: parse --node-config JSON. We accept a JSON string and
      // forward it as `nodeConfig` to the workflow_run tool. Malformed JSON
      // is reported as a clear CLI error rather than silently ignored —
      // otherwise users get confusing "agent timeout" failures downstream
      // when their override never reached the engine.
      let nodeConfig: Record<string, Record<string, unknown>> | undefined;
      if (args.nodeConfig) {
        try {
          const parsed = JSON.parse(args.nodeConfig);
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
          ) {
            output.error(
              `Invalid --node-config: expected a JSON object mapping nodeId → overrides, got: ${args.nodeConfig}`,
            );
            process.exit(1);
          }
          nodeConfig = parsed as Record<string, Record<string, unknown>>;
        } catch (err) {
          output.error(
            `Invalid --node-config JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
      }

      // Validate --session format: must start with 'workflow_'
      // (No auto-prefix fallback — the prefix is required for unambiguous session identification.)
      if (args.session && !args.session.startsWith('workflow_')) {
        output.error(
          `Invalid session ID: must start with 'workflow_' (got: ${args.session})`,
        );
        process.exit(1);
      }

      // Prepare run options
      const runOptions: any = {
        debug: args.debug,
        parallelLimit: args.parallelLimit,
        timeout: args.timeout,
        // Task #1974: forward nodeConfig so the file-mode path (which calls
        // service.runWorkflow directly instead of going through the
        // workflow_run tool) also honors per-node overrides.
        ...(nodeConfig ? { nodeConfig } : {}),
      };

      // Cross-process parent session propagation (Task #1739).
      // When the CLI is invoked from a parent agent via the bash tool,
      // the parent sets `ROY_PARENT_SESSION_ID` so the spawned workflow
      // run session can be linked in `sessions list --graph`. This is
      // the cross-process fallback for cases where ToolContext.session_id
      // is unavailable.
      //
      // Issue #8: the env-var value crosses a trust boundary. Validate it
      // before letting it influence the session tree.
      // Use bracket notation to dodge any custom NodeJS.ProcessEnv type
      // augmentation that doesn't include this key.
      const rawEnvParentId = (process.env as Record<string, string | undefined>)[
        "ROY_PARENT_SESSION_ID"
      ];
      if (typeof rawEnvParentId === "string" && rawEnvParentId.length > 0) {
        if (isValidSessionId(rawEnvParentId)) {
          runOptions.parentSessionId = rawEnvParentId;
        } else {
          // Non-empty but invalid: log + ignore. Don't fail the command,
          // a corrupt parent id should not block workflow execution.
          output.warn(
            `Ignoring malformed ROY_PARENT_SESSION_ID env value (must match /^[A-Za-z0-9_-]{8,128}$/)`
          );
        }
      }

      // Handle session resume (-s <session>)
      if (args.session) {
        // Resume from existing session via the public WorkflowService.resumeSession()
        // API (Task #1829). Replaces the previous (service as any).engineFactory
        // hack with a stable, typed entry point that mirrors how the
        // `workflow_run` tool re-enters a paused/interrupted workflow.
        const sessionId = args.session;

        output.log(chalk.blue(`🔄 Resuming workflow from session: ${sessionId}`));

        try {
          // When CLI passes a plain string input on resume, wrap it as
          // { userQuery: input } — matches engine.runWithResume convention
          // for ask_user interrupt responses. (JSON input passes through.)
          const resumeInput =
            typeof input === "string"
              ? { userQuery: input }
              : input;

          const result = await service.resumeSession(sessionId, {
            ...runOptions,
            ...(resumeInput !== undefined ? { input: resumeInput } : {}),
          });

          output.log(
            renderRunResult({
              runId: sessionId,
              status: result.status,
              output: result.output,
              error: result.error,
              durationMs: result.durationMs,
              ...(result.pendingNodeId ? { pendingNodeId: result.pendingNodeId } : {}),
              ...(result.query ? { query: result.query } : {}),
              ...(result.agentSessionId ? { agentSessionId: result.agentSessionId } : {}),
            }),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          output.error(`Failed to resume session ${sessionId}: ${msg}`);
        }

        // 结束 OTel span
        if (workflowSpan) {
          workflowSpan.end();
        }

        await envService.dispose();
        process.exit(0);
      }

      // Determine if identifier is a file or workflow name
      const isFile = args.file || 
        args.identifier.endsWith('.yaml') || 
        args.identifier.endsWith('.yml') || 
        args.identifier.endsWith('.json');

      if (isFile) {
        // Run from file - first register, then run
        const filePath = path.resolve(args.identifier);
        if (!fs.existsSync(filePath)) {
          output.error(`File not found: ${filePath}`);
          process.exit(1);
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        
        // 解析 YAML 或 JSON 文件
        let definition: WorkflowDefinition;
        if (filePath.endsWith('.json')) {
          definition = JSON.parse(content);
        } else {
          definition = YAML.parse(content);
        }

        // 如果指定了 --name，覆盖定义中的名称
        const registrationName = args.name || definition.name;
        if (args.name) {
          definition = { ...definition, name: args.name };
        }

        // 注册 workflow
        const workflow = await service.createWorkflow(definition, { force: true });
        output.log(chalk.blue(`📝 Registering workflow: ${registrationName}`));
        output.log(chalk.green(`✅ Workflow registered: ${workflow.name} (${workflow.id})`));

        // 如果是 --register-only 模式，只注册不运行
        if (args.registerOnly) {
          output.log(chalk.gray('ℹ️  Use --register-only, skipping execution'));
          // 结束 OTel span
          if (workflowSpan) {
            workflowSpan.end();
          }
          await envService.dispose();
          process.exit(0);
        }

        // 运行 workflow
        output.log(chalk.blue(`🚀 Running workflow: ${workflow.name}`));
        // `input` can be a string only on resume paths; --file fresh-runs
        // always carry a JSON object (otherwise CLI rejects with an error
        // message). Guard against the union for the file branch explicitly.
        const fileBranchInput = typeof input === "string" ? undefined : input;
        const result = await service.runWorkflow(definition, fileBranchInput, runOptions);

        // Output result
        output.log(renderRunResult({
          runId: result.runId,
          status: result.status,
          output: result.output,
          error: result.error,
          durationMs: result.durationMs,
          ...(result.pendingNodeId ? { pendingNodeId: result.pendingNodeId } : {}),
          ...(result.query ? { query: result.query } : {}),
          ...(result.agentSessionId ? { agentSessionId: result.agentSessionId } : {}),
        }));

        // If paused, show resume hint
        if (result.status === 'paused') {
          output.log(chalk.gray(`\n💡 Resume with: roy-bot workflow run ${result.runId} --session ${result.runId} --input "<your answer>"`));
        }
      } else {
        // Run by name — use workflow_run tool
        const tool = createRunWorkflowTool(service);
        const toolResult = await tool.execute({
          workflow_name: args.identifier,
          input: typeof input === "string" ? undefined : (input || undefined),
          timeout: args.timeout,
          ...(nodeConfig ? { node_config: nodeConfig } : {}),
        }, {} as ToolContext);
        
        if (!toolResult.success) {
          // Task #1840: surface run_id even on failure so the user can
          // query status / resume via `workflow status <runId>` or
          // `workflow run <name> --session <runId>`.
          const outAny = toolResult.output as Record<string, any> | string | undefined;
          const runId =
            typeof outAny === "object" && outAny !== null && "run_id" in outAny
              ? (outAny as any).run_id
              : undefined;
          output.error(toolResult.error || `Failed to run workflow: ${args.identifier}`);
          if (runId) {
            output.error(`Run ID: ${runId}`);
            output.error(
              chalk.gray(
                `\n💡 Use "roy-bot workflow status ${runId}" to check progress, or "roy-bot workflow run ${args.identifier} --session ${runId}" to resume`,
              ),
            );
          }
          process.exit(1);
        }
        
        const runData = toolResult.output as Record<string, any>;
        
        // Output result
        output.log(renderRunResult({
          runId: runData.run_id,
          status: runData.status,
          output: runData.output,
          error: runData.error,
          durationMs: runData.duration_ms,
          ...(runData.pending_node_id ? { pendingNodeId: runData.pending_node_id } : {}),
          ...(runData.query ? { query: runData.query } : {}),
          ...(runData.agent_session_id ? { agentSessionId: runData.agent_session_id } : {}),
        }));

        // If paused, show resume hint
        if (runData.status === 'paused') {
          output.log(chalk.gray(`\n💡 Resume with: roy-bot workflow run ${args.identifier} --session ${runData.run_id} --input "<your answer>"`));
        }
      }
      
      // 结束 OTel span
      if (workflowSpan) {
        workflowSpan.end();
      }
      
      await envService.dispose();
      process.exit(0);
    } catch (error) {
      // 结束 OTel span（带错误）
      if (workflowSpan) {
        workflowSpan.end(undefined, error instanceof Error ? error : new Error(String(error)));
      }
      output.error(`Failed to run workflow: ${error}`);
      await envService.dispose();
      process.exit(1);
    }
  },
  "workflow.cli.run",
  { recordParams: true, recordResult: true, log: true }
);

export const WorkflowRunCommand: CommandModule<object, WorkflowRunOptions> = {
  command: 'run <identifier>',
  describe: '运行 Workflow (支持从文件或名称运行)',

  builder: (yargs) =>
    yargs
      .positional('identifier', {
        describe: 'Workflow 名称或定义文件路径',
        type: 'string',
        demandOption: true,
      })
      .option('debug', {
        alias: 'd',
        describe: 'Debug 模式',
        type: 'boolean',
        default: false,
      })
      .option('input', {
        alias: 'i',
        describe: '输入参数 (JSON 格式用于新运行，字符串用于恢复暂停的 workflow)',
        type: 'string',
      })
      .option('parallel-limit', {
        describe: '并行限制',
        type: 'number',
      })
      .option('timeout', {
        alias: 't',
        describe: '超时时间 (毫秒)',
        type: 'number',
      })
      .option('watch', {
        alias: 'w',
        describe: '实时显示执行进度',
        type: 'boolean',
        default: false,
      })
      .option('file', {
        alias: 'f',
        describe: 'identifier 是文件路径，自动注册后运行',
        type: 'boolean',
        default: false,
      })
      .option('name', {
        alias: 'n',
        describe: '注册时的名称（仅 --file 模式有效）',
        type: 'string',
      })
      .option('register-only', {
        alias: 'r',
        describe: '只注册不运行（仅 --file 模式有效）',
        type: 'boolean',
        default: false,
      })
      .option('config', {
        describe: '配置文件路径',
        type: 'string',
      })
      .option('session', {
        alias: 's',
        describe: '从已有 session 恢复运行（支持 workflow pause/interrupt 恢复；runId == sessionId，传 workflow run 的 runId 即可）',
        type: 'string',
      })
      .option('node-config', {
        describe: 'Per-node runtime config overrides (Task #1974). JSON string: { "<nodeId>": { "timeout": 5000 } }. Shallow-merged into each node\'s effective config; input wins over nodeDef.config.',
        type: 'string',
      }),

  handler: runWorkflow,
};
