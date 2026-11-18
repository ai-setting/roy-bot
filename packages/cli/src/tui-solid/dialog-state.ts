/**
 * @fileoverview Task #5116 P7.1 —— Dialog（配置弹窗）状态机（纯函数）。
 *
 * 与 slash-palette-state.ts 同构：纯函数 reducer，
 * 渲染层（Dialog.tsx）只消费状态，按键语义在这里穷举。
 *
 * ## 两种形态
 *
 * - `list`：provider/model 列表选择（↑↓/Enter/Esc）
 * - `form`：添加 provider 表单（字段切换/提交/Esc）
 */

export type DialogKind = "connect" | "model";

export interface DialogListItem {
  /** 唯一 id（提交时回传）。 */
  id: string;
  /** 主文本（如 /provider 名 或 model id）。 */
  label: string;
  /** 次要文本（描述 / 脱敏 apiKey / base URL）。 */
  detail?: string;
  /** 标记行（如 "default" / "current"）。 */
  badge?: string;
}

// ---------------------------------------------------------------------------
// ★ Task #5129 P7.3 F2 —— 模型 id 解析（纯函数）
//
// 背景（#5125 DS review M3）：`item.id.split("/")` 对含 `/` 的模型名
// （如 OpenRouter 风格 `provider/org/model`）会截断错 ⇒ 解析出错误的
// model 并写进 config / runtime override。
//
// 语义：id 形如 `${provider}/${model}`，model 本身**可含 `/`** ⇒
// 只按**第一个** `/` 切一次，其余整体为 model。
// ---------------------------------------------------------------------------

/** 解析 /model 弹窗 item.id → { provider, model }；非法 id 返回 null。 */
export function parseModelDialogId(
  id: string,
): { provider: string; model: string } | null {
  const idx = id.indexOf("/");
  if (idx <= 0 || idx === id.length - 1) return null;
  const provider = id.slice(0, idx);
  const model = id.slice(idx + 1);
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * ★ Task #5138 P7.4 —— /model 弹窗条目的 badge 文案（纯函数，可单测）。
 *
 * 优先级：**当前全局 default**（`llm.defaultModel`）> provider 级 default
 * > 无 badge。
 *
 * 抽成纯函数的原因（DS review r2 MINOR-2）：原先 badge 三元内联在
 * RunScreen 的 JSX 里 ⇒ 无法单测，只有截图能证明。
 *
 * @param flags - readModelsFromConfig 给出的两个标记
 * @returns badge 文案；无标记时返回 undefined（弹窗不显示 badge）
 */
export function modelDialogBadge(flags: {
  isCurrentDefault?: boolean;
  isProviderDefault?: boolean;
}): string | undefined {
  if (flags.isCurrentDefault) return "current";
  if (flags.isProviderDefault) return "provider default";
  return undefined;
}

export type DialogAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "select" }
  | { type: "cancel" }
  /** 表单：切换字段（下一字段；最后字段视作提交）。 */
  | { type: "next-field" }
  /** 表单：输入当前字段。 */
  | { type: "field-input"; text: string }
  /** 表单：删除当前字段最后一个字符。 */
  | { type: "field-backspace" }
  /** 表单：提交全部字段。 */
  | { type: "submit" }
  /** 从表单回到列表（不改状态）。 */
  | { type: "back-to-list" };

export interface DialogState {
  kind: DialogKind;
  mode: "list" | "form" | "closed";
  /** list 模式：高亮下标。 */
  selectedIndex: number;
  /** form 模式：当前字段下标（0=name 1=apiKey 2=baseURL）。 */
  fieldIndex: number;
  /** form 模式：字段值。 */
  fields: { name: string; apiKey: string; baseURL: string };
}

/** 弹窗事件（提交/取消）。 */
export type DialogOutcome =
  | { kind: "none" }
  | { kind: "item-selected"; itemId: string }
  | { kind: "form-submitted"; name: string; apiKey: string; baseURL: string }
  | { kind: "cancelled" };

export const CONNECT_FORM_FIELDS = ["name", "apiKey", "baseURL"] as const;

/** 初始列表态。 */
export function initialDialogState(kind: DialogKind): DialogState {
  return {
    kind,
    mode: "list",
    selectedIndex: 0,
    fieldIndex: 0,
    fields: { name: "", apiKey: "", baseURL: "" },
  };
}

/**
 * 移动高亮（clamp，不循环——与 slash-palette-state 同款）。
 */
function moveSelection(state: DialogState, delta: number, itemCount: number): DialogState {
  if (itemCount === 0) return state;
  const next = Math.min(Math.max(state.selectedIndex + delta, 0), itemCount - 1);
  return next === state.selectedIndex ? state : { ...state, selectedIndex: next };
}

/**
 * reducer：状态 + 动作 → 新状态 + 事件。
 *
 * 返回 `{ state, outcome }`；outcome 非纯状态变化（提交/选中/取消）
 * 时非 none，调用方据此决定关闭/持久化。
 */
export function dialogReducer(
  state: DialogState,
  action: DialogAction,
  itemCount: number,
): { state: DialogState; outcome: DialogOutcome } {
  // ---- list 模式 ----
  if (state.mode === "list") {
    switch (action.type) {
      case "up":
        return { state: moveSelection(state, -1, itemCount), outcome: { kind: "none" } };
      case "down":
        return { state: moveSelection(state, 1, itemCount), outcome: { kind: "none" } };
      case "select":
        if (itemCount === 0) return { state, outcome: { kind: "none" } };
        return { state, outcome: { kind: "item-selected", itemId: "" } };
      case "cancel":
        return { state: { ...state, mode: "closed" }, outcome: { kind: "cancelled" } };
      // 表单动作在 list 模式不生效（无意义）。
      default:
        return { state, outcome: { kind: "none" } };
    }
  }

  // ---- form 模式 ----
  const fields = state.fields;
  const fieldOrder: (keyof typeof fields)[] = ["name", "apiKey", "baseURL"];
  const currentKey = fieldOrder[Math.min(state.fieldIndex, fieldOrder.length - 1)];

  switch (action.type) {
    case "field-input": {
      const text = action.text;
      // 过滤控制字符（单行输入，拒绝换行）。
      const clean = [...text].filter((ch) => ch.charCodeAt(0) >= 0x20).join("");
      if (!clean) return { state, outcome: { kind: "none" } };
      return {
        state: { ...state, fields: { ...fields, [currentKey]: fields[currentKey] + clean } },
        outcome: { kind: "none" },
      };
    }
    case "field-backspace": {
      if (!fields[currentKey]) return { state, outcome: { kind: "none" } };
      return {
        state: { ...state, fields: { ...fields, [currentKey]: fields[currentKey].slice(0, -1) } },
        outcome: { kind: "none" },
      };
    }
    case "next-field":
    case "submit": {
      // submit 或已是最后字段 ⇒ 提交；next-field 在中间字段 ⇒ 切下一字段。
      const isLast = state.fieldIndex >= fieldOrder.length - 1;
      if (action.type === "submit" || isLast) {
        return { state, outcome: { kind: "form-submitted", ...fields } };
      }
      return {
        state: { ...state, fieldIndex: state.fieldIndex + 1 },
        outcome: { kind: "none" },
      };
    }
    case "cancel":
      return { state: { ...state, mode: "closed" }, outcome: { kind: "cancelled" } };
    case "back-to-list":
      return {
        state: { ...state, mode: "list", fieldIndex: 0, fields: { name: "", apiKey: "", baseURL: "" } },
        outcome: { kind: "none" },
      };
    default:
      return { state, outcome: { kind: "none" } };
  }
}
