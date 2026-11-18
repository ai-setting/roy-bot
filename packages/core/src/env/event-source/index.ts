/**
 * EventSource 模块入口
 * 
 * 导出所有 EventSource 相关的类型、类和函数
 */

// 类型导出
export type {
  EventSourceStatus,
  EventSourceType,
  EventSourceConfig,
  EventMetadata,
  RecommendedAction,
  ReplyChannel,
  EventSourceEventPayload,
  EventSourceEvent,
  EventSourceEventHandler,
  EventSourceStatusChangeEvent,
  EventSourcePersistenceConfig,
  EventSourceInstance,
  EventSourceHandler,
  EventSourceInitHook,
  EventSourceComponentInterface,
  EventSourceAgentHandlerConfig,
  NotifyChannelInfo,
  RuleNoticeInfo,
} from "./types";

// 类导出
export { EventSourceInitHooks } from "./types";

// 内置类型常量
export { BUILT_IN_EVENT_SOURCE_TYPES, BUILT_IN_EVENT_SOURCE_TYPE_LIST } from "./types";

// 辅助函数
export {
  isBuiltInEventSourceType,
  isValidEventSourceType,
  getDefaultConfigForType,
  validateEventSourceConfig,
} from "./types";

// 组件
export { EventSourceComponent } from "./event-source-component";

// ★ Task #4722：command 子系统（`##command##:` 前缀分流）
//
// command 子系统是**纯核心层能力**，不耦合任何 es 逻辑；
// es（lark-cli 卡片）与 CLI（文本）都是它的前端。
export {
  COMMAND_PREFIX,
  isCommandMessage,
  extractCommandInvocation,
  CommandRegistry,
  getGlobalCommandRegistry,
  handleCommandMessage,
} from "./command-registry";
// ★ Task #5302：es command（eventsource 管理）
export { esCommand, resolveEsFilePath } from "./es-command";
export type {
  CommandInvocation,
  CommandContext,
  CommandOutput,
  CommandTextOutput,
  CommandCardOutput,
  CommandResult,
  CommandDefinition,
} from "./command-registry";

// command 卡片渲染（飞书 interactive 卡片，Card 2.0）
export {
  renderTextCard,
  renderFallbackModelCard,
  isFallbackModelCard,
  FALLBACK_MODEL_ACTIONS,
  FALLBACK_MODEL_ACTION_NS,
} from "./command-cards";
export type { LarkCard } from "./command-types";

// command 卡片按钮回调（fbmodel_* 动作 → 回 command 子系统）
export {
  isCommandCardAction,
  translateCardActionToCommand,
  handleCommandCardAction,
} from "./command-card-action";
export type {
  CommandCardActionEvent,
  CommandCardActionPorts,
  CommandCardActionResult,
} from "./command-card-action";

// fallback-model command（管理 llm.fallbackModels）
export {
  fallbackModelCommand,
  listCommand,
  readFallbackModelList,
  readRawFallbackModelArray,
  writeFallbackModelList,
  DEFAULT_CONFIG_PATH,
} from "./fallback-model-command";

// EventStore（Task #4042 ESPlugin v2）— 类 + 接口 + 进程内共享单例
export {
  EventStoreImpl,
  setSharedEventStore,
  getSharedEventStore,
  resetSharedEventStore,
} from "./event-store";
export type {
  EventStore,
  TriggerEventInput,
  TriggerEventMetadata,
  PersistedEvent,
  EventStoreOptions,
} from "./event-store";

// 内置 Handler
export {
  larkCliHandler,
  timerHandler,
  bountyIMHandler,
  cliCommandHandler,
  wecomCliHandler,
  builtInHandlers,
  getBuiltInHandler,
  // ★ Task #2326: lark-messageid-context 集成测试需要直接调用 extractMetadata
  extractMetadata,
  // ★ ES-M1 (Task #5144): 渠道 system prompt 构造/解析
  buildLarkRecommendedAction,
  buildLarkChannelSystemPrompt,
  resolveLarkChannelSystemPrompt,
  LARK_CHANNEL_PROMPT_SECTION_TITLE,
  LARK_PROMPT_LENGTH_BUDGET,
} from "./event-source-handlers";

// WeCom Handler（Task #5142）
export {
  WECOM_CLI_ES_TYPE,
  WECOM_CHAT_ID_PREFIX,
  WECOM_WS_DEFAULT_URL,
  wecomCliHandler as wecomCliHandlerDirect,
  buildWecomReplyChannel,
  buildWecomNotifyPrompt,
  buildWecomChannelSystemPrompt,
  WECOM_CHANNEL_PROMPT_SECTION_TITLE,
  parseWecomFrame,
  readWecomCredentialsFile,
  resolveWecomCredentials,
  WECOM_CREDENTIALS_DEFAULT_PATH,
  resolveWecomBinary,
  probeCommandBinary,
  readWecomCliConfig,
} from "./wecom-cli-handler";
export type {
  WecomReplyChannelInput,
  WecomNotifyPromptInput,
  WecomChannelSystemPromptInput,
  WecomCredentials,
  ParsedWecomFrame,
} from "./wecom-cli-handler";

// ★ 修复：sanitizeWecomFrame 定义在 wecom-ws-bridge，之前错从
//   wecom-cli-handler 重导出（SyntaxError: export not found）。
export { sanitizeWecomFrame } from "./wecom-ws-bridge";

// CLI Command Handler（Task #4568）
export {
  CLI_COMMAND_ES_TYPE,
  CLI_SESSION_CHAT_ID_PREFIX,
  buildCliReplyChannel,
  parseCliSessionChatId,
} from "./cli-command-handler";
export type { CliReplyChannel, CliNoticeSink } from "./cli-command-handler";

// Timer Handler
export { TimerInstance } from "./timer-handler";

// Bounty IM Handler
export { BountyIMInstance, buildDefaultBountyIMSystemPrompt, resolveBountyIMSystemPrompt } from "./bounty-im-handler";
