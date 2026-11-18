/**
 * @fileoverview Task #5109 P7 —— 斜杠补全面板**状态机**（纯函数）。
 *
 * ## 为什么是纯函数
 *
 * opentui 的 `testRender` 在 `bun test` 下是**急求值**（React 风格），
 * 组件渲染完首帧不再更新 ⇒ 「按键 → 状态变化 → 重绘」型断言无法在
 * 单测里可靠验证（见 `test-utils/repaint-capability.ts` 的实测记录）。
 *
 * ⇒ 把面板的全部交互语义抽到这里，用**穷举**方式验证；
 * UI 组件（`SlashPalette.tsx`）只负责把状态画出来 + 把按键翻译成 action。
 *
 * ## 对齐 opencode
 *
 * opencode 的分层 keymap（`packages/tui/src/mini/footer.prompt.tsx:1283-1335`）：
 *   - 面板可见时：↑↓ = 面板选择、Esc = 关闭、Enter = 选中执行、Tab = 补全；
 *   - 面板不可见时：↑↓ = 历史导航、Esc = 清空输入。
 *
 * 本状态机实现「面板可见」那一层。
 *
 * ## 键位语义（opencode `config/keybind.ts:276-280`）
 *
 * | 语义 | 键位           | 本仓行为            |
 * |------|----------------|---------------------|
 * | 上一项 | up / ctrl+p    | `move(-1)`          |
 * | 下一项 | down / ctrl+n  | `move(+1)`          |
 * | 关闭   | escape         | `close`（**不打断流式**）|
 * | 选中   | return         | 选中并执行          |
 * | 补全   | tab            | 选中并把 `/name ` 写入输入框 |
 */

export interface SlashPaletteState {
  /** 面板是否可见。 */
  open: boolean;
  /** 当前过滤词（`/` 之后的文本）。 */
  query: string;
  /** 当前高亮项下标。 */
  selectedIndex: number;
}

export type SlashPaletteAction =
  /** 输入内容变化：query 非 null ⇒ 打开/更新；null ⇒ 触发消失，关闭。 */
  | { type: "trigger"; query: string | null }
  /** 过滤词变化（面板已打开时）。 */
  | { type: "query"; query: string }
  /** ↑↓ 移动高亮（delta = ±1）。 */
  | { type: "move"; delta: number; itemCount?: number }
  /** Esc 关闭。 */
  | { type: "close" };

export function initialSlashPaletteState(): SlashPaletteState {
  return { open: false, query: "", selectedIndex: 0 };
}

/**
 * 检测输入框里是否存在斜杠触发，返回过滤词（`/` 之后的部分）。
 *
 * 触发规则（对齐 opencode `packages/tui/src/prompt/display.ts:33-41`）：
 *   - `/` 必须在**行首**或**前一字符是空白**（否则 `abc/def` 不触发）；
 *   - `/` 与光标之间**不能有空白**（`/help me` 不再是触发 ⇒ 关闭面板）；
 *   - query 里**不能有第二个 `/`**。
 *
 * @returns 过滤词（`/` 之后、到光标为止）；无触发时返回 null。
 */
export function slashTriggerQuery(text: string): string | null {
  if (!text) return null;
  for (let index = text.lastIndexOf("/"); index >= 0; index = text.lastIndexOf("/", index - 1)) {
    const before = index === 0 ? undefined : text[index - 1];
    const query = text.slice(index + 1);
    if (before !== undefined && !/\s/.test(before)) continue;
    if (/\s/.test(query)) return null;
    if (query.includes("/")) return null;
    return query;
  }
  return null;
}

/** 状态机 reducer（纯函数）。 */
export function slashPaletteReducer(
  state: SlashPaletteState,
  action: SlashPaletteAction,
): SlashPaletteState {
  switch (action.type) {
    case "trigger": {
      if (action.query === null) {
        return { open: false, query: "", selectedIndex: 0 };
      }
      // 面板已开且 query 未变 ⇒ 保持高亮位置（opencode 的 refresh() 同款）。
      if (state.open && state.query === action.query) return state;
      return { open: true, query: action.query, selectedIndex: 0 };
    }
    case "query": {
      if (!state.open) return state;
      return { open: true, query: action.query, selectedIndex: 0 };
    }
    case "move": {
      if (!state.open) return state;
      const count = action.itemCount;
      if (count === undefined) {
        // 未知条目数 ⇒ 只能向下 clamp（避免负下标）。
        return { ...state, selectedIndex: Math.max(0, state.selectedIndex + action.delta) };
      }
      if (count <= 0) return state;
      const next = state.selectedIndex + action.delta;
      return {
        ...state,
        selectedIndex: Math.max(0, Math.min(count - 1, next)),
      };
    }
    case "close":
      return { open: false, query: "", selectedIndex: 0 };
    default:
      return state;
  }
}
