/**
 * @fileoverview Shared modules for CLI commands
 *
 * 导出共享模块供 act、interactive 等命令复用
 */

export { SessionManager } from "./session-manager";
export type { SessionInitResult, SessionManagerOptions } from "./session-manager";

export { QueryExecutor } from "./query-executor";
export type { QueryExecutorOptions, StreamOptions } from "./query-executor";

export {
  assembleMultimodalMessage,
  parseActImageArgs,
} from "./multimodal-message";

export {
  applyPagination,
  renderPaginationFooter,
  renderQuietHeader,
  renderQuietLine,
  renderQuietPaginationHint,
  PAGINATION_OPTIONS,
} from "./list-output";
export type { ListPaginationArgs } from "./list-output";
