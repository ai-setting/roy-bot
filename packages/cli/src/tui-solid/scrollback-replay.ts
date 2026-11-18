/**
 * @fileoverview Task #4721 G1 — **历史回放**（把 scrollback 里的历史重新渲染进 frame）。
 *
 * ## 为什么需要它
 *
 * opentui 的历史输出是 **write-once scrollback**（Task #4278 片4）：
 * `renderer.writeToScrollback(...)` 把已提交的消息写进**终端的滚动缓冲**，
 * 它们**不在 renderable 树里** ⇒
 *
 *   - 树里的任何节点（含 `<ScrollBox>`）都**看不到**这些行 ⇒ 滚轮无从下手；
 *   - opentui **没有公开**「把 scrollback 视口往回拨」的 API。
 *
 * ⇒ 唯一的办法：**自己留一份历史副本**，用户往上滚时把对应的历史行
 * **重新渲染进 frame**（动态区）。
 *
 * ## 纯函数化
 *
 * 本模块**不含 JSX、不含 Solid**（可被任意 runner 直接测）⇒ 逻辑与渲染
 * 解耦，边界（行数估算、切片）可独立验证。
 */

import type { HistoryItem } from "./App.js";

/**
 * 估算一条历史项渲染后占多少行。
 *
 * @param item 历史项
 * @param width 终端宽度（影响换行）
 */
export function estimateHistoryRows(item: HistoryItem, width = 80): number {
  const w = Math.max(1, width);
  if (item.role === "usage") return 1;

  const content = item.tool
    ? (item.tool.output ?? item.tool.error ?? item.tool.name)
    : (item.content ?? "");
  const text = String(content ?? "");
  if (text.length === 0) return 2; // 只有角色标签 + 间距

  // CJK 字符占 2 列（粗略估计，够用）。
  const columns = [...text].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const textRows = Math.max(1, Math.ceil(columns / Math.max(1, w - 4)));

  if (item.tool) {
    // 工具卡：标题行 + 内容行 + 底距
    return textRows + 2;
  }
  // 普通消息：角色标签行 + 内容行 + 底距
  return textRows + 2;
}

/**
 * 从历史缓冲里挑出「回退 `offset` 行」时应该显示的那一段。
 *
 * @param buffer 历史缓冲（**旧的在前，新的在后**）
 * @param offset 回退行数（0 = 显示最新）
 * @param width 终端宽度
 * @returns 要显示的历史项（**旧的在前**）
 */
export function selectHistoryWindow(
  buffer: HistoryItem[],
  offset: number,
  width = 80,
): HistoryItem[] {
  if (offset <= 0 || buffer.length === 0) return [];

  // 从最新的那一端往回累加行数，直到覆盖 offset。
  const picked: HistoryItem[] = [];
  let rows = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    picked.push(buffer[i]!);
    rows += estimateHistoryRows(buffer[i]!, width);
    if (rows >= offset) break;
  }
  return picked.reverse();
}

/**
 * 计算一个历史缓冲能回退的最大行数（= 全部历史的高度）。
 */
export function maxHistoryOffset(buffer: HistoryItem[], width = 80): number {
  return buffer.reduce((sum, item) => sum + estimateHistoryRows(item, width), 0);
}
