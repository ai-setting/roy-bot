import { z } from 'zod';

// ==================== 基础事件 ====================

export const BaseEventSchema = z.object({
  type: z.string(),
  run_id: z.string(),
  timestamp: z.number(),
});

export type BaseEvent = z.infer<typeof BaseEventSchema>;

// ==================== Workflow 生命周期事件 ====================

export const WorkflowStartedEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.started'),
  workflow_name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export const WorkflowPausedEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.paused'),
});

export const WorkflowResumedEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.resumed'),
});

export const WorkflowStoppedEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.stopped'),
  reason: z.string(),
});

export const WorkflowCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.completed'),
  result: z.record(z.string(), z.unknown()).optional(),
  duration_ms: z.number(),
});

export const WorkflowFailedEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.failed'),
  error: z.object({
    message: z.string(),
    stack: z.string().optional(),
  }),
  failed_at: z.string(),
});

export const WorkflowOutputEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.output'),
  output: z.record(z.string(), z.unknown()),
});

// ==================== Node 生命周期事件 ====================

export const NodeScheduledEventSchema = BaseEventSchema.extend({
  type: z.literal('node.scheduled'),
  node_id: z.string(),
});

export const NodeStartedEventSchema = BaseEventSchema.extend({
  type: z.literal('node.started'),
  node_id: z.string(),
  input: z.any().optional(),
  agentSessionId: z.string().optional(),
  userQuery: z.string().optional(),
  userResponse: z.string().optional(),
});

export const NodeProgressEventSchema = BaseEventSchema.extend({
  type: z.literal('node.progress'),
  node_id: z.string(),
  progress: z.number(),
  message: z.string().optional(),
});

export const NodeCompletedEventSchema = BaseEventSchema.extend({
  type: z.literal('node.completed'),
  node_id: z.string(),
  output: z.any(),
  duration_ms: z.number(),
});

export const NodeFailedEventSchema = BaseEventSchema.extend({
  type: z.literal('node.failed'),
  node_id: z.string(),
  error: z.object({
    message: z.string(),
    stack: z.string().optional(),
  }),
});

export const NodeSkippedEventSchema = BaseEventSchema.extend({
  type: z.literal('node.skipped'),
  node_id: z.string(),
  reason: z.string(),
});

// ==================== 节点间数据流事件 ====================

export const NodeDataEventSchema = BaseEventSchema.extend({
  type: z.literal('node.data'),
  from_node: z.string(),
  to_node: z.string(),
  data: z.any(),
});

// ==================== 动态节点事件 ====================

export const NodeAddedEventSchema = BaseEventSchema.extend({
  type: z.literal('node.added'),
  node_id: z.string(),
  node: z.any(),
});

export const NodeRemovedEventSchema = BaseEventSchema.extend({
  type: z.literal('node.removed'),
  node_id: z.string(),
});

// ==================== 控制事件 ====================

export const ControlPauseEventSchema = BaseEventSchema.extend({
  type: z.literal('control.pause'),
});

export const ControlResumeEventSchema = BaseEventSchema.extend({
  type: z.literal('control.resume'),
});

export const ControlStopEventSchema = BaseEventSchema.extend({
  type: z.literal('control.stop'),
});

// ==================== 人工交互事件 (Schemas only) ====================

export const NodeInterruptEventSchema = BaseEventSchema.extend({
  type: z.literal('node.interrupt'),
  node_id: z.string(),
  node_type: z.string(),
  query: z.string(),
});

export const WorkflowAskUserEventSchema = BaseEventSchema.extend({
  type: z.literal('workflow.ask-user'),
  session_id: z.string(),
  node_id: z.string(),
  node_type: z.string(),
  query: z.string(),
});

// ==================== 联合事件类型 ====================

export const WorkflowEventSchema = z.union([
  WorkflowStartedEventSchema,
  WorkflowPausedEventSchema,
  WorkflowResumedEventSchema,
  WorkflowStoppedEventSchema,
  WorkflowCompletedEventSchema,
  WorkflowFailedEventSchema,
  WorkflowOutputEventSchema,
  NodeScheduledEventSchema,
  NodeStartedEventSchema,
  NodeProgressEventSchema,
  NodeCompletedEventSchema,
  NodeFailedEventSchema,
  NodeSkippedEventSchema,
  NodeDataEventSchema,
  NodeAddedEventSchema,
  NodeRemovedEventSchema,
  ControlPauseEventSchema,
  ControlResumeEventSchema,
  ControlStopEventSchema,
  NodeInterruptEventSchema,
  WorkflowAskUserEventSchema,
]);

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

// ==================== Event 工厂函数 ====================

export function createWorkflowEvent<T extends WorkflowEvent['type']>(
  type: T,
  runId: string,
  data: Omit<Extract<WorkflowEvent, { type: T }>, 'type' | 'run_id' | 'timestamp'>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return {
    type,
    run_id: runId,
    timestamp: Date.now(),
    ...data,
  };
}
