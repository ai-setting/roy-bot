/**
 * @fileoverview Shared list output helpers
 *
 * 统一的 list 命令输出规范：
 * 1. 分页参数：-n / --limit, -o / --offset（默认 20, 0）
 * 2. JSON 结构：{ total, count, truncated, limit, offset, <items>: [...] }
 *    （<items> 字段名由各 list 命令自定义：tasks/sessions/workflows/...）
 * 3. 默认文本：表格 + "Showing X-Y of Z items" 页脚
 *
 * quiet 模式输出由各 list 命令自行定义（本 helper 不强制统一格式），
 * 因为不同命令的主键信息不同：tasks 用 `#<id> <title>`，
 * sessions 用 `<title> (<id>)`，其余命令直接输出 name
 *
 * 子命令通过 builder 选项 + applyPagination/renderPaginationFooter 两个
 * 工具函数即可满足统一规范，无需各自重复实现。
 *
 * 涉及的 list 命令：
 * - tasks list / search
 * - sessions list
 * - workflow list
 * - skills list
 * - agents list
 * - tools list
 * - mcp list
 * - eventsource list
 * - commands list
 */

import chalk from "chalk";

/**
 * 共享分页参数（所有 list 命令统一使用）
 */
export interface ListPaginationArgs {
  /** 每页数量 */
  limit: number;
  /** 分页偏移 */
  offset: number;
}

/**
 * 标准分页选项（用于 yargs builder）
 */
export const PAGINATION_OPTIONS = {
  limit: {
    alias: "n",
    type: "number" as const,
    default: 20,
    description: "每页数量（-n alias）",
  },
  offset: {
    alias: "o",
    type: "number" as const,
    default: 0,
    description: "分页偏移（-o alias）",
  },
};

/**
 * 在 CLI 层应用分页（不修改 component）。
 * 用于 in-memory 列表（skill/agent/tool/mcp/eventsource）的 CLI 层截断。
 *
 * @param items - 全量数据
 * @param args  - 分页参数
 * @returns 截断后的子集
 */
export function applyPagination<T>(items: T[], args: ListPaginationArgs): T[] {
  const offset = Math.max(0, args.offset);
  const limit = Math.max(1, args.limit);
  return items.slice(offset, offset + limit);
}

/**
 * 渲染分页页脚（统一的 "Showing X-Y of Z items" 格式）
 *
 * @param opts.total    - 匹配总数
 * @param opts.count    - 当前返回数
 * @param opts.offset   - 当前 offset
 * @param opts.limit    - 当前 limit
 * @param opts.itemName - 元素名（单数），会自动加 s 复数
 * @param opts.extras   - 附加元数据（如 ["depth=2", "include-archived"]）
 */
export function renderPaginationFooter(opts: {
  total: number;
  count: number;
  offset: number;
  limit: number;
  itemName: string;
  extras?: string[];
}): string {
  const { total, count, offset, limit, itemName, extras = [] } = opts;
  const start = total === 0 ? 0 : offset + 1;
  const end = offset + count;
  const items = `${itemName}${count === 1 ? "" : "s"}`;
  const base = `Showing ${start}-${end} of ${total} ${items}`;
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  const truncatedHint = total > count && offset + count < total
    ? chalk.cyan(` — use -o ${offset + limit} for next page`)
    : "";
  return chalk.gray(base + suffix + truncatedHint);
}

// Note on dead code:
// Earlier drafts of this helper also exported `buildListJsonMeta`.
// It was removed during code review because JSON output is more
// naturally assembled inline at each list command (they each have
// command-specific extra fields like `source`, `pattern`,
// `available_tags`, etc. that the generic helper could not express
// without becoming an untyped string-builder API).

/**
 * Quiet 模式下的统一输出格式：
 *
 *   # Total: 28 items      <- 第一行：总数（带 # 前缀，可 grep -v "^#" 跳过）
 *   <id>\t<name>           <- 后续每行：id<TAB>name (id 在第一列便于 awk 抽取)
 *   <id>\t<name>
 *   ...
 *
 * @param total    - 元素总数（未应用 limit 截断）
 * @param itemName - 元素名（单数），自动加 s 复数
 * @returns 渲染好的 header 字符串（不含末尾换行）
 */
export function renderQuietHeader(total: number, itemName: string): string {
  const items = `${itemName}${total === 1 ? "" : "s"}`;
  return `# Total: ${total} ${items}`;
}

/**
 * Quiet 模式下的单行输出：`<id>\t<name>`
 *
 * 保持 id 在第一列以兼容现有的 grep/awk 脚本：
 *   awk -F'\t' '{print $1}'  → 取 id
 *   awk -F'\t' '{print $2}'  → 取 name
 *
 * 对没有独立 id 字段的命令（workflow/skills/agents/tools/mcp/prompt/
 * commands 等，name 即 id），调用方传 (name, name) 即可。脚本仍然能用
 * `awk '{print $1}'` 拿到 id（虽然和 name 相同）。
 */
export function renderQuietLine(id: string | number, name: string): string {
  return `${id}\t${name}`;
}

/**
 * Quiet 模式下的分页提示（仅在 truncated 时返回字符串，否则返回空串）
 *
 * 输出格式：`# (showing 1-3 of 28, use -o 3 for next page)`
 * - 与 `renderQuietHeader` 配对使用，header 在前、hint 在后
 * - 以 `# ` 前缀开头，脚本可以用 `grep -v "^#"` 同时过滤 header 和 hint
 * - 仅在 `count < total`（即被分页截断）时返回非空字符串
 *
 * @param opts.count    - 当前返回数量（CLI 层分页后）
 * @param opts.total    - 元素总数（未应用 limit 截断）
 * @param opts.offset   - 当前 offset
 * @param opts.limit    - 当前 limit
 */
export function renderQuietPaginationHint(opts: {
  count: number;
  total: number;
  offset: number;
  limit: number;
}): string {
  const { count, total, offset, limit } = opts;
  if (total <= count) {
    return "";
  }
  const start = offset + 1;
  const end = offset + count;
  return `# (showing ${start}-${end} of ${total}, use -o ${offset + limit} for next page)`;
}
