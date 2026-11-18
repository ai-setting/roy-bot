/**
 * @fileoverview EnvContext 模块导出
 *
 * Task #2331: env context 通用化为 EventEnvelope, 替代 lark-specific LarkEventContext.
 *
 * 保留 LarkEventContext type alias 用于:
 * 1. 文档/迁移说明引用
 * 2. 第三方代码可能 import 这个类型
 *
 * 新代码请使用 EventEnvelope (来自 './env-event')。
 */

export {
  type EnvContext,
  type ReplyChannel,
  type LarkEventContext,
  type CreateEnvContextOptions,
  getEnvContext,
  getEnvContextOrEmpty,
  hasEnvContext,
  runWithEnvContext,
  runWithEnvContextAsync,
  createEnvContext,
  mergeEnvContext,
  normalizeParentTaskId,
  resolveEnvParentTaskId,
  // Task #5659: toolEnv 方案 C（ES config → metadata → EnvContext → spawn env）
  normalizeToolEnv,
  resolveToolEnv,
  getCurrentTaskId,
  setCurrentTaskId,
  envContextStorage,
  // Task #2331: 通用 EventEnvelope helpers (替代 Task #2326 LARK_* helpers)
  getEventFromEnvContext,
  // Task #2331: EventEnvelope types re-export
  type EventEnvelope,
  type EventSource,
  EVENT_ENV_PREFIX,
  serializeEventToEnv,
  restoreEventFromEnv,
} from "./env-context";

// EventEnvelope helpers - source-specific extractors
export {
  isLarkEvent,
  isGithubEvent,
  isJiraEvent,
  getLarkMessageId,
  getLarkChatId,
  getLarkUserId,
} from "./env-event";
