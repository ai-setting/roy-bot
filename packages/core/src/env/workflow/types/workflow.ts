import { z } from 'zod';

// ==================== Schema 定义 ====================

// Import EdgeDefinition schema
import { EdgeDefinitionSchema } from './edge';

// 节点依赖配置
export const DependsOnSchema = z.array(z.string());
export type DependsOn = z.infer<typeof DependsOnSchema>;

// 重试配置
export const RetryConfigSchema = z.object({
  max_attempts: z.number().min(1).default(1),
  backoff: z.enum(['fixed', 'exponential']).default('exponential'),
  initial_delay: z.number().min(0).default(1000),
});
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

// ==================== Loop Guard 配置 ====================
//
// Task #2283 — Engine-side back-edge progress guard (generalized).
//
// A loop_guard declares a "previous progress signal" (any TemplateResolver
// path, e.g. `{{nodes.tdd-implement.commits[-1]}}`) and a "current progress
// command" (any shell command, e.g. `git rev-parse HEAD`). Before re-entering
// a node via a back-edge, the engine compares the two values; if they match
// for `max_consecutive_no_progress` consecutive re-entries, the node is
// short-circuited and marked FAIL with `fail_message`.
//
// Single type `value_unchanged` keeps the engine API orthogonal: any
// comparison (git HEAD, test count, file list length, etc.) is expressed
// purely by `previous_signal` and `current_signal_command`.

export const LoopGuardConfigSchema = z.object({
  /** Detection type — only `value_unchanged` is supported. */
  type: z.literal('value_unchanged'),

  /**
   * Previous progress signal — any TemplateResolver path.
   * Examples:
   *   "{{nodes.tdd-implement.commits[-1]}}"
   *   "{{nodes.code-review.severity.blocking.length}}"
   *   "{{nodes.bug-fix.test_count_passing}}"
   */
  previous_signal: z.string().min(1, 'previous_signal must be a non-empty template path'),

  /**
   * Current progress signal — any shell command. The stdout (trimmed) is
   * compared to the resolved `previous_signal` via JSON.stringify equality.
   * Examples:
   *   "git rev-parse HEAD"
   *   "pytest --collect-only -q 2>/dev/null | wc -l"
   *   "ls -1 tests/test_*.py | wc -l"
   */
  current_signal_command: z.string().min(1, 'current_signal_command must be a non-empty shell command'),

  /** Optional working directory for `current_signal_command`. */
  cwd: z.string().optional(),

  /** Consecutive no-progress re-entries before the engine forces FAIL (default 1). */
  max_consecutive_no_progress: z.number().int().min(1).default(1),

  /** Custom fail message injected when the guard trips. */
  fail_message: z.string().optional(),
});

export type LoopGuardConfig = z.infer<typeof LoopGuardConfigSchema>;

// 节点定义 Schema
export const NodeDefinitionSchema = z.object({
  id: z.string().min(1, 'Node ID is required'),
  type: z.string().min(1, 'Node type is required'),
  name: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional().default({}),
  depends_on: z.array(z.string()).optional(),
  condition: z.string().optional(),
  retry: RetryConfigSchema.optional(),
  timeout: z.number().optional(),
}).superRefine((value, ctx) => {
  // Validate `config.loop_guard` if present. Other config keys are
  // node-type-specific and intentionally not constrained here.
  const config = (value.config ?? {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(config, 'loop_guard')) {
    const parsed = LoopGuardConfigSchema.safeParse(config.loop_guard);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'loop_guard', ...(issue.path ?? [])],
          message: issue.message,
        });
      }
    }
  }
}).transform((value) => {
  // Materialize LoopGuardConfig defaults into config so downstream engine
  // code can read `config.loop_guard.max_consecutive_no_progress` directly
  // without re-applying defaults. Other config keys are passed through.
  const config = (value.config ?? {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(config, 'loop_guard')) {
    const parsed = LoopGuardConfigSchema.safeParse(config.loop_guard);
    if (parsed.success) {
      value.config = { ...config, loop_guard: parsed.data };
    }
  }
  return value;
});

export type NodeDefinition = z.infer<typeof NodeDefinitionSchema>;

// ==================== Node Interface ====================

/**
 * Node interface - base interface for all workflow nodes
 */
export interface Node {
  /** Node type identifier */
  readonly type: string;
  /** Node unique identifier */
  readonly id: string;
  /** Execute the node with the given context */
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

// Import types needed for Node interface (avoid circular dependency by using inline types)
// These will be resolved at runtime via NodeExecutionContext import
import type { NodeExecutionContext, NodeExecutionResult } from './run';

// Workflow 配置
export const WorkflowConfigSchema = z.object({
  parallel_limit: z.number().nullable().optional(),
  timeout: z.number().nullable().optional(),
  retry: RetryConfigSchema.optional(),
  debug: z.boolean().optional(),
  /** Strict mode: fail on unresolved templates instead of warning */
  strict: z.boolean().optional(),
  /** Maximum iterations for loop detection */
  maxIterations: z.number().optional().default(100),
  /** Enable loop mode to allow re-entry of completed nodes (for workflow cycles) */
  loopEnabled: z.boolean().optional().default(false),
});
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

// 输出定义
export const OutputDefinitionSchema = z.object({
  name: z.string(),
  source: z.string(),
  path: z.string(),
});
export type OutputDefinition = z.infer<typeof OutputDefinitionSchema>;

// ==================== 输入参数定义 ====================

/**
 * Single input parameter definition
 */
export const InputParameterSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  description: z.string().optional(),
  default: z.unknown().optional(),
  required: z.boolean().default(false),
});
export type InputParameter = z.infer<typeof InputParameterSchema>;

/**
 * Input parameters schema for workflow definition
 * Maps parameter names to their definitions
 */
export const WorkflowInputsSchema = z.record(
  z.string(),
  InputParameterSchema
);
export type WorkflowInputs = z.infer<typeof WorkflowInputsSchema>;

// Workflow 元数据
export const WorkflowMetadataSchema = z.object({
  author: z.string().optional(),
  taskId: z.number().optional(),  // 新增：关联的任务 ID
  tags: z.array(z.string()).optional().default([]),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;

// ==================== Workflow 定义 ====================

export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1, 'Workflow name is required'),
  version: z.string().default('1.0'),
  description: z.string().optional(),
  config: WorkflowConfigSchema.optional().default({}),
  nodes: z.array(NodeDefinitionSchema).min(1, 'At least one node is required'),
  entry: z.union([z.string(), z.array(z.string())]).default('__default_entry__'),
  outputs: z.array(OutputDefinitionSchema).optional().default([]),
  inputs: WorkflowInputsSchema.optional().default({}),
  metadata: WorkflowMetadataSchema.optional().default({}),
  // 新增 edges 数组
  edges: z.array(EdgeDefinitionSchema).optional().default([]),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// 扩展 Workflow 定义，自动计算入口节点
export interface WorkflowDefinitionExtended extends WorkflowDefinition {
  // 自动计算的入口节点列表
  computedEntry: string[];
  // 节点映射
  nodeMap: Map<string, NodeDefinition>;
  // 拓扑排序结果
  topologicalOrder: string[];
}

// ==================== Workflow 实体 ====================

export interface Workflow {
  id: string;
  name: string;
  version: string;
  description?: string;
  definition: WorkflowDefinition;
  config: WorkflowConfig;
  metadata: WorkflowMetadata;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ==================== YAML/JSON 解析辅助 ====================

export interface ParsedWorkflow {
  format: 'yaml' | 'json';
  definition: WorkflowDefinition;
}

// YAML parser placeholder - will be implemented with yaml package
let yamlParser: typeof import('yaml') | null = null;

async function getYamlParser() {
  if (!yamlParser) {
    yamlParser = await import('yaml');
  }
  return yamlParser;
}

/**
 * 解析 Workflow 文件
 * @param content 文件内容
 * @param filename 文件名，用于自动检测格式
 */
export async function parseWorkflowFile(content: string, filename: string): Promise<ParsedWorkflow> {
  const isYaml = filename.endsWith('.yaml') || filename.endsWith('.yml');
  const isJson = filename.endsWith('.json');
  
  let definition: WorkflowDefinition;
  
  if (isYaml) {
    const yaml = await getYamlParser();
    definition = WorkflowDefinitionSchema.parse(yaml.parse(content));
  } else if (isJson) {
    definition = WorkflowDefinitionSchema.parse(JSON.parse(content));
  } else {
    // 尝试自动检测
    try {
      definition = WorkflowDefinitionSchema.parse(JSON.parse(content));
    } catch {
      const yaml = await getYamlParser();
      definition = WorkflowDefinitionSchema.parse(yaml.parse(content));
    }
  }
  
  return {
    format: isYaml ? 'yaml' : 'json',
    definition
  };
}

/**
 * Synchronous version of parseWorkflowFile
 * Uses JSON parsing only for auto-detection
 */
export function parseWorkflowFileSync(content: string, filename: string): ParsedWorkflow {
  const isYaml = filename.endsWith('.yaml') || filename.endsWith('.yml');
  const isJson = filename.endsWith('.json');
  
  let definition: WorkflowDefinition;
  
  if (isJson) {
    definition = WorkflowDefinitionSchema.parse(JSON.parse(content));
  } else if (isYaml) {
    // For sync YAML parsing, we need the yaml package synchronously
    // This will throw if yaml is not imported, but that's acceptable
    // for production use where async parsing is preferred
    throw new Error('Synchronous YAML parsing not supported. Use parseWorkflowFile() instead.');
  } else {
    // 尝试自动检测 JSON
    try {
      definition = WorkflowDefinitionSchema.parse(JSON.parse(content));
    } catch {
      throw new Error('Cannot auto-detect format. Please use .yaml, .yml, or .json extension.');
    }
  }
  
  return {
    format: isJson ? 'json' : 'yaml',
    definition
  };
}
