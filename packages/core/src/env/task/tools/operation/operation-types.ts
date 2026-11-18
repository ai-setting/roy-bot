/**
 * @fileoverview Operation Tool Parameter Schemas (Task #2211: 双维度里程碑 + 过程)
 *
 * 设计目标：
 * - **状态/里程碑维度**（"达到什么"）：milestone_type / milestone_title / milestone_description
 * - **过程维度**（"如何达到"）：process_description（100-500 字符硬约束，Task #4764 放宽）
 *
 * 兼容：
 * - action_type / action_title / action_description 通过 z.preprocess 自动映射到 milestone_*
 *   并通过输出字段 _deprecated_warning 提示"建议改用 milestone_*"
 */

import { z } from "zod";

/**
 * Action type enum
 */
const ActionTypeEnum = z.enum([
  "create",
  "progress",
  "milestone",
  "problem",
  "solution",
  "decision",
  "review",
  "completed",
  "workflow_extracted",
]);

export { ActionTypeEnum };

/**
 * Process description constraints
 *
 * 设计哲学：操作记录只承担节点阶段 milestone 概要。
 * - milestone_description：达成状态/结果的描述（保留原义，可长可短）
 * - process_description：采取了什么策略 + 工具步骤达成的过程概要
 *
 * 硬约束：100-500 字符（Task #4764 放宽，原 100-150）。
 * - 太短（<100）= 没价值，不算过程概要
 * - 太长（>500）= 退化为日志细节，违背 milestone 摘要设计
 * - 放宽理由（Task #4764）：150 字符装不下「里程碑 + 达成操作」的完整过程，
 *   agent 需要在执行中「边做边记」（记录刚做的操作 + 为什么），500 字符
 *   足够表达且仍不是日志；完整细节仍应通过 sessionId 回查 session 历史。
 *
 * 失败模式：
 * - < 100：拒绝（提供有意义的 process_description 才是该字段的本职）
 * - > 500：拒绝（防止字段膨胀，保持 milestone 摘要克制）
 */
export const PROCESS_DESCRIPTION_MIN_LENGTH = 100;
export const PROCESS_DESCRIPTION_MAX_LENGTH = 500;

/**
 * Milestone description (状态/结果描述) — 长度上限保留宽松（与历史 action_description 一致）。
 */
export const MILESTONE_DESCRIPTION_MAX_LENGTH = 5000;

/**
 * Milestone title — 必填，1-200 字符。
 */
export const MILESTONE_TITLE_MIN_LENGTH = 1;
export const MILESTONE_TITLE_MAX_LENGTH = 200;

/**
 * process_description 字段校验
 * - 可选（向后兼容）
 * - 长度严格 100-500 字符（Task #4764 放宽）
 */
export const ProcessDescriptionSchema = z
  .string()
  .min(PROCESS_DESCRIPTION_MIN_LENGTH, {
    message: `process_description 太短（少于 ${PROCESS_DESCRIPTION_MIN_LENGTH} 字符），无法表达过程概要；如无过程信息请省略该字段，细节请回查 sessionId。`,
  })
  .max(PROCESS_DESCRIPTION_MAX_LENGTH, {
    message: `process_description 太长（超过 ${PROCESS_DESCRIPTION_MAX_LENGTH} 字符），会退化为日志细节；操作记录只承担 milestone 概要，完整细节请通过 sessionId 回查 session。`,
  })
  .describe(
    "过程概要（process_description）：采取的策略 + 工具步骤概要；" +
      `严格控制 ${PROCESS_DESCRIPTION_MIN_LENGTH}-${PROCESS_DESCRIPTION_MAX_LENGTH} 字符。` +
      "操作记录是节点阶段 milestone 摘要，完整过程通过 sessionId 回查 session；" +
      "milestone_description 才是达成的状态/结果描述。"
  );

/**
 * milestone_title 字段校验
 * - 必填
 * - 1-200 字符
 */
export const MilestoneTitleSchema = z
  .string()
  .min(MILESTONE_TITLE_MIN_LENGTH, { message: "milestone_title 不能为空" })
  .max(MILESTONE_TITLE_MAX_LENGTH, {
    message: `milestone_title 超过 ${MILESTONE_TITLE_MAX_LENGTH} 字符，建议精简（一行标题即可）。`,
  })
  .describe(
    "里程碑标题（milestone_title）：达成的里程碑/状态的一句话标题；" +
      "必填，1-200 字符。"
  );

/**
 * milestone_description 字段校验
 * - 可选
 * - 0-5000 字符（保留宽松，便于状态/结果描述）
 */
export const MilestoneDescriptionSchema = z
  .string()
  .max(MILESTONE_DESCRIPTION_MAX_LENGTH, {
    message: `milestone_description 超过 ${MILESTONE_DESCRIPTION_MAX_LENGTH} 字符；如需更详细的过程，请改用 process_description。`,
  })
  .optional()
  .describe(
    "状态/结果描述（milestone_description）：达成的状态或结果描述；" +
      "可长可短；过程概要应放在 process_description，不要与本字段重复。"
  );

/**
 * input schema with milestone_* as primary, action_* as deprecated alias via preprocess
 */
const CreateOperationInputSchema = z.object({
  task_id: z.number().describe("Task ID"),
  // 主字段
  milestone_type: ActionTypeEnum.optional(),
  milestone_title: MilestoneTitleSchema.optional(),
  milestone_description: MilestoneDescriptionSchema,
  process_description: ProcessDescriptionSchema.optional(),
  // 兼容旧字段
  action_type: ActionTypeEnum.optional(),
  action_title: z.string().min(1).max(MILESTONE_TITLE_MAX_LENGTH).optional(),
  action_description: z.string().max(MILESTONE_DESCRIPTION_MAX_LENGTH).optional(),
  md_path: z.string().optional().describe("Path to detailed markdown documentation"),
});

/**
 * task_operation_create tool parameters (Task #2211)
 *
 * 双维度规范：
 * - milestone_* 字段描述达成的状态/结果
 * - process_description 描述达成过程（100-500 字符）
 * - action_* 字段作为兼容窗口期别名
 */
export const CreateOperationToolSchema = CreateOperationInputSchema.transform(
  (input): CreateOperationToolParams => {
    const deprecatedFields: string[] = [];
    let milestoneType = input.milestone_type;
    let milestoneTitle = input.milestone_title;
    let milestoneDescription = input.milestone_description;

    if (!milestoneType && input.action_type) {
      milestoneType = input.action_type;
      deprecatedFields.push("action_type");
    }
    if (!milestoneTitle && input.action_title) {
      milestoneTitle = input.action_title;
      deprecatedFields.push("action_title");
    }
    if (milestoneDescription === undefined && input.action_description !== undefined) {
      milestoneDescription = input.action_description;
      deprecatedFields.push("action_description");
    }

    return {
      task_id: input.task_id,
      milestone_type: milestoneType,
      milestone_title: milestoneTitle,
      milestone_description: milestoneDescription,
      process_description: input.process_description,
      md_path: input.md_path,
      _deprecated_fields_used: deprecatedFields,
    };
  }
);

export interface CreateOperationToolParams {
  task_id: number;
  milestone_type?: string;
  milestone_title?: string;
  milestone_description?: string;
  process_description?: string;
  md_path?: string;
  _deprecated_fields_used: string[];
}

/**
 * task_operation_get tool parameters
 */
export const GetOperationToolSchema = z.object({
  operation_id: z.number().describe("Operation ID"),
});

export type GetOperationToolParams = z.infer<typeof GetOperationToolSchema>;

/**
 * task_operation_list tool parameters
 */
export const ListOperationsToolSchema = z.object({
  task_id: z.number().describe("Task ID"),
  // 主字段
  milestone_type: ActionTypeEnum.optional(),
  // 兼容旧字段
  action_type: ActionTypeEnum.optional(),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
}).transform((input) => {
  const deprecatedFields: string[] = [];
  let milestoneType = input.milestone_type;
  if (!milestoneType && input.action_type) {
    milestoneType = input.action_type;
    deprecatedFields.push("action_type");
  }
  return {
    task_id: input.task_id,
    milestone_type: milestoneType,
    limit: input.limit,
    offset: input.offset,
    _deprecated_fields_used: deprecatedFields,
  };
});

export interface ListOperationsToolParams {
  task_id: number;
  milestone_type?: string;
  limit: number;
  offset: number;
  _deprecated_fields_used: string[];
}

/**
 * task_operation_update tool parameters
 */
const UpdateOperationInputSchema = z.object({
  operation_id: z.number().describe("Operation ID"),
  // 主字段
  milestone_title: MilestoneTitleSchema.optional(),
  milestone_description: MilestoneDescriptionSchema,
  process_description: ProcessDescriptionSchema.optional(),
  // 兼容旧字段
  action_title: z.string().min(1).max(MILESTONE_TITLE_MAX_LENGTH).optional(),
  action_description: z.string().max(MILESTONE_DESCRIPTION_MAX_LENGTH).optional(),
});

export const UpdateOperationToolSchema = UpdateOperationInputSchema.transform((input) => {
  const deprecatedFields: string[] = [];
  let milestoneTitle = input.milestone_title;
  let milestoneDescription = input.milestone_description;

  if (!milestoneTitle && input.action_title) {
    milestoneTitle = input.action_title;
    deprecatedFields.push("action_title");
  }
  if (milestoneDescription === undefined && input.action_description !== undefined) {
    milestoneDescription = input.action_description;
    deprecatedFields.push("action_description");
  }
  return {
    operation_id: input.operation_id,
    milestone_title: milestoneTitle,
    milestone_description: milestoneDescription,
    process_description: input.process_description,
    _deprecated_fields_used: deprecatedFields,
  };
});

export interface UpdateOperationToolParams {
  operation_id: number;
  milestone_title?: string;
  milestone_description?: string;
  process_description?: string;
  _deprecated_fields_used: string[];
}

/**
 * task_operation_delete tool parameters
 */
export const DeleteOperationToolSchema = z.object({
  operation_id: z.number().describe("Operation ID"),
});

export type DeleteOperationToolParams = z.infer<typeof DeleteOperationToolSchema>;
