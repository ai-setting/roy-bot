/**
 * @fileoverview slash-command-popup — Claude Code 风格 / 命令弹窗
 *
 * Task #2312: 实现 / 自动命令匹配 + 弹窗
 * Task #2333: 借鉴 opencode Autocomplete 模式 (REPORT.md)
 *   - active state 下移到弹窗内部 (opencode `useFilteredList` + `solid-list` 模式)
 *   - 弹窗自己 useInput 处理 ↑/↓/Enter/Esc (opencode `Autocomplete` 模式)
 *   - 父级不需要 selectedIndex state, 父级 re-render 不再影响弹窗 active
 *
 * 设计:
 * - 弹窗渲染在输入框上方 (REPLInk 的 Box 层级, 与 MultilineInput 兄弟节点)
 * - 显示当前过滤后的命令列表 (max 8 条, 超出滚动提示)
 * - 当前选中行用 ▶ 前缀 + inverse 高亮 (Claude Code 风格)
 * - 命令名固定宽度左对齐, 描述紧随其后
 * - 空查询显示全部命令 (用户第一次输入 / 时)
 * - 没有匹配的命令时不渲染弹窗 (避免空状态闪烁)
 *
 * 渲染策略:
 * - 弹窗整体用 Box borderStyle="single" 包起来 (浅蓝边框, Claude Code 风格)
 * - 顶部加一行 muted 提示 "Commands" (区分标题与内容)
 * - 选中行: bgBlue + ▶ + cmd (white bold) + desc (gray)
 * - 未选中行: 空格 + cmd (默认色) + desc (gray)
 *
 * 借鉴 opencode 模式 (Task #2333):
 * - active state 在弹窗内部 useState 管理 (类似 opencode `solid-list`)
 * - 弹窗 useInput({ isActive: filtered.length > 0 }) 处理 ↑/↓/Enter/Esc
 *   类似 opencode `Autocomplete.onKeyDown`
 * - 外部 (REPLInk) 通过 onSelect 接收用户选中的命令
 * - 父级 useInput 不参与弹窗键处理 (避免双重触发)
 */

import * as React from "react";
import { Box, Text, useInput } from "ink";
import {
  COMMANDS,
  filterCommandsFuzzy,
  MAX_POPUP_ITEMS,
  type Command,
} from "./commands-registry";

/**
 * 弹窗 props
 */
export interface SlashCommandPopupProps {
  /** 当前查询字符串 (不含前导 /, 由 REPLInk 计算) */
  query: string;
  /**
   * Task #2333: 外部受控的 selectedIndex (可选)
   * - 不传: 弹窗自己 useState 管理 (opencode 模式, 默认)
   * - 传了: 弹窗用外部值 (向后兼容, 旧测试用)
   * - 外部 + 内部: 双向同步 (init 外部 → 内部, 内部变 → 通知外部 via onIndexChange)
   */
  selectedIndex?: number;
  /**
   * Task #2333: 弹窗内部 selectedIndex 变化时通知外部 (opencode 模式)
   * - 外部用来同步自己的 popupIndex state (如果需要)
   * - 父级可以不传, 表示 "父级不关心弹窗 active" (更纯粹的开 code 模式)
   */
  onIndexChange?: (index: number) => void;
  /**
   * Task #2333: 用户选中命令时调用 (Enter / Tab 触发)
   * - opencode 模式: 弹窗自己 useInput 处理 Enter → 调 onSelect
   * - 父级 REPLInk 通过这个回调接收选中的 cmd, 然后 setInputBuffer 补全输入
   */
  onSelect?: (cmd: Command) => void;
  /**
   * Task #2333: 用户按 Esc 关闭弹窗 (opencode 模式)
   * - 弹窗自己 useInput 处理 Esc → 调 onClose
   * - 父级 REPLInk 通过这个回调清空 inputValue (隐藏弹窗)
   */
  onClose?: () => void;
}

/**
 * Task #2317: CommandRow — 单行命令渲染, React.memo 包裹
 *
 * 让 SlashCommandPopup 在 selectedIndex / query 变化时只重渲染变化的行,
 * 其他行 (cmd 不变) 保持稳定引用 → ink 不重绘这些行 → 不闪烁。
 */
const CommandRow = React.memo(function CommandRow({
  cmd,
  isSelected,
}: {
  cmd: Command;
  isSelected: boolean;
}): React.ReactElement {
  // 命令名固定 12 字符左对齐 (e.g. "/attach    ")
  const cmdPadded = cmd.cmd.padEnd(12, " ");
  // 选中行: ▶ 蓝底 + 白字命令 + 灰字描述
  if (isSelected) {
    return (
      <Text inverse key={cmd.cmd}>
        {"▶ "}
        {cmdPadded}
        {cmd.desc}
      </Text>
    );
  }
  // 未选中行: 两个空格 + 命令 + 描述
  return (
    <Text key={cmd.cmd}>
      {"  "}
      {cmdPadded}
      <Text color="gray">{cmd.desc}</Text>
    </Text>
  );
});

/**
 * 弹窗组件 — 不可见时返回 null (避免占用屏幕空间)
 *
 * Task #2333: 内部 useState 管理 selectedIndex (opencode 模式)
 *  - 不再受控于父级, 父级 re-render 不影响弹窗 active state
 *  - useInput({ isActive: filtered.length > 0 }) 处理 ↑/↓/Enter/Esc
 *  - 类似 opencode Autocomplete 组件
 */
export const SlashCommandPopup = React.memo(function SlashCommandPopup({
  query,
  selectedIndex: externalSelectedIndex,
  onIndexChange,
  onSelect,
  onClose,
}: SlashCommandPopupProps): React.ReactElement | null {
  // Task #2657 R2 T-B: switched from substring (filterCommands) to
  // subsequence fuzzy (filterCommandsFuzzy). Lets users type abbreviations
  // like "mdl" to find /model, "hlp" to find /help, etc.
  const filtered = React.useMemo(() => filterCommandsFuzzy(query), [query]);

  // Task #2333: 内部 selectedIndex state (opencode 模式)
  // - initialValue 从 externalSelectedIndex 取 (向后兼容)
  // - 外部变化时同步内部 (用 useEffect 监听)
  // - 内部变化时通过 onIndexChange 通知外部
  const [internalSelectedIndex, setInternalSelectedIndex] = React.useState(
    () => externalSelectedIndex ?? 0,
  );

  // 外部 selectedIndex 变化时同步到内部 (向后兼容)
  // 例如: 父级重新挂载弹窗, 或外部 reset index
  React.useEffect(() => {
    if (externalSelectedIndex !== undefined && externalSelectedIndex !== internalSelectedIndex) {
      setInternalSelectedIndex(externalSelectedIndex);
    }
  }, [externalSelectedIndex, internalSelectedIndex]);

  // 内部 index 变化时通知外部
  const updateIndex = React.useCallback(
    (next: number) => {
      setInternalSelectedIndex(next);
      onIndexChange?.(next);
    },
    [onIndexChange],
  );

  // filtered 变化时重置 internalSelectedIndex (避免越界)
  React.useEffect(() => {
    if (filtered.length === 0) return;
    if (internalSelectedIndex >= filtered.length) {
      updateIndex(0);
    }
  }, [filtered, internalSelectedIndex, updateIndex]);

  // Task #2333: 弹窗自己 useInput 处理 ↑/↓/Enter/Esc (opencode Autocomplete 模式)
  // - isActive: filtered.length > 0 时才接收事件 (弹窗关闭时不抢键)
  // - 父 useInput 不知道弹窗存在, 不会双重处理
  useInput(
    (input, key) => {
      // 弹窗内任何输入字符都让父级 MultilineInput 接收 (用 return 跳过)
      // 除非是导航键
      if (key.upArrow) {
        if (filtered.length === 0) return;
        updateIndex(
          (internalSelectedIndex - 1 + filtered.length) % filtered.length,
        );
        return;
      }
      if (key.downArrow) {
        if (filtered.length === 0) return;
        updateIndex((internalSelectedIndex + 1) % filtered.length);
        return;
      }
      if (key.return && !key.meta && !key.shift && !key.ctrl) {
        const cmd = filtered[internalSelectedIndex];
        if (cmd && onSelect) {
          onSelect(cmd);
        }
        return;
      }
      if (key.tab) {
        // Tab 也选中当前 (类似 Enter)
        const cmd = filtered[internalSelectedIndex];
        if (cmd && onSelect) {
          onSelect(cmd);
        }
        return;
      }
      if (key.escape) {
        if (onClose) {
          onClose();
        }
        return;
      }
      // 其他键 (字符输入, backspace 等) 不在弹窗处理, 让父 useInput 处理
    },
    { isActive: filtered.length > 0 },
  );

  // 没有匹配项 — 不渲染 (避免空状态干扰)
  if (filtered.length === 0) {
    return null;
  }

  // 钳制 internalSelectedIndex (防御性, 防止 filtered 边界)
  const selectedIndex = Math.max(
    0,
    Math.min(filtered.length - 1, internalSelectedIndex),
  );

  // 限制显示数量, 视口跟随 selectedIndex 滚动 (Task #2316 修复)
  // - 选中项保持在视口中间偏上 (index - 3), 让用户能看到上下文
  // - 顶部/底部边界保护: scrollOffset 不能 < 0, 也不能让视口超出 filtered 末尾
  const filteredLength = filtered.length;
  const scrollOffset =
    filteredLength <= MAX_POPUP_ITEMS
      ? 0
      : Math.max(0, Math.min(filteredLength - MAX_POPUP_ITEMS, selectedIndex - 3));
  const visible = filtered.slice(scrollOffset, scrollOffset + MAX_POPUP_ITEMS);
  const hiddenBefore = scrollOffset;
  const hiddenAfter = filteredLength - (scrollOffset + visible.length);
  // 视口内高亮索引 (selectedIndex 减去视口偏移)
  const windowedIndex = selectedIndex - scrollOffset;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      marginBottom={0}
    >
      {/* 顶部提示行 — 灰色 + 分类总数 + 视口外提示 (↑ 上方 / ↓ 下方) */}
      <Text color="gray" dimColor>
        Commands ({filteredLength})
        {hiddenBefore > 0 ? ` · ${hiddenBefore} more ↑` : ""}
        {hiddenAfter > 0 ? ` · ${hiddenAfter} more ↓` : ""}
      </Text>
      {visible.map((cmd, i) => (
        <CommandRow key={cmd.cmd} cmd={cmd} isSelected={i === windowedIndex} />
      ))}
    </Box>
  );
});

/**
 * 工具函数: 把 selectedIndex 限制到 [0, filteredLength-1] 范围
 */
export function clampSelectedIndex(index: number, filteredLength: number): number {
  if (filteredLength === 0) return 0;
  return Math.max(0, Math.min(filteredLength - 1, index));
}

/**
 * 工具函数: 计算滚动后的窗口内索引 (用于 UI 渲染时定位高亮)
 *
 * 当 filteredLength > MAX_POPUP_ITEMS 时, 把选中项保持在第 4 行附近 (接近中间),
 * 让用户能看到上下文的命令。
 */
export function computeWindowedIndex(index: number, filteredLength: number): number {
  if (filteredLength <= MAX_POPUP_ITEMS) return clampSelectedIndex(index, filteredLength);
  const scrollOffset = Math.max(0, Math.min(filteredLength - MAX_POPUP_ITEMS, index - 3));
  return index - scrollOffset;
}

/**
 * 重新导出 COMMANDS 供测试使用
 */
export { COMMANDS };
