/**
 * @fileoverview Task #4889 — 任务纪律子路径公开导出面
 *
 * 消费方式：
 *   import { TASK_DISCIPLINE_PROMPT } from "@ai-setting/roy-bot-core/env/task/prompt";
 *
 * 设计（/tmp/4889-phase1-design.md §1.3-1.6）：
 *   TASK_DISCIPLINE_PROMPT 是唯一真相源；4 个分片供
 *   「部分缺失」的 runtime 只补自己缺的那块。
 */

export {
  TASK_DISCIPLINE_PROMPT,
  TASK_DISCIPLINE_LIFECYCLE,
  TASK_DISCIPLINE_OPERATION,
  TASK_DISCIPLINE_GOALS,
  TASK_DISCIPLINE_COMPLETE,
} from "./task-discipline";
