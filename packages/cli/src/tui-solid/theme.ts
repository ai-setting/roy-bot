/** @jsxImportSource @opentui/solid */
/**
 * @fileoverview Task #5086 P5 —— Solid TUI 主题工程（token 集 + dark/light）。
 *
 * 单源真值：opencode v2.2.5 的 `packages/tui/src/theme/assets/opencode.json`
 * （本机 /tmp/opencode-src）。dark 深灰阶 step1-12 + 蓝 secondary #5c9cf5 +
 * 紫 accent #9d7cd8 + 橙 primary #fab283（即 darkStep9）。
 *
 * 与 Ink 链的关系：
 *   - `tui/theme.ts`（Ink 时代 11 字段：cyan/yellow/gray 语义色名）**保留**，
 *     Ink 组件（tui/App.tsx / StatusBar.tsx / Spinner.tsx …）继续消费。
 *   - 本模块是 Solid 链（interactive 运行时）的**新主题**，
 *     用 `useTuiTheme(mode)` 按 mode 取值，与 Ink 解耦。
 *   - `getTheme` 仍然 re-export（App/Spinner/StatusBar/ToolCall 的既有
 *     `import { getTheme } from "./theme.js"` 不断）——**兼容窗口**；
 *     组件迁移到 `useTuiTheme` 后这条 re-export 才退役。
 *
 * NO_COLOR 降级：`getNoColorTheme()` 返回全 `""` 的同形状主题；
 * `fg()`（style.ts）把 `""` 映射成 `undefined`，opentui 走默认前景。
 * 运行时探测 NO_COLOR 的入口仍走 `tui/theme.ts::getTheme()` 的
 * `shouldSuppressColors`（NO_COLOR / TERM=dumb）。
 *
 * Task #5109 P7（/theme 运行时切换）：
 *   - `runtimeModeSignal` = Solid signal 镜像的 `runtimeMode`；
 *     `setTuiThemeMode` 会同步更新它 ⇒ 组件用 `useTuiThemeReactive()` 即可
 *     在 `/theme` 切换时自动重渲染（**无需重启进程**）。
 *   - `resolveSolidTheme()` 保持**一次性求值**（组件函数体开头读一次）；
 *     只有 `useTuiThemeReactive()` 的订阅者才能看到后续变化。
 */

import { createSignal } from "solid-js";

// ---------------------------------------------------------------------------
// Token 集
// ---------------------------------------------------------------------------

/**
 * P5 必选 13 token + info + diff 预留。
 * 顺序与 opencode.json 的 theme.* 字段保持一致，便于逐行 diff。
 */
export const TUI_TOKENS = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "borderSubtle",
] as const;

export type TuiToken = (typeof TUI_TOKENS)[number];

/** mode 取值：与 opencode 的 themeModes 对齐（dark/light 双主题）。 */
export type TuiThemeMode = "dark" | "light";

/** token → hex 色值；NO_COLOR 模式下为 ""。 */
export type TuiTokenPalette = Record<TuiToken, string>;

/**
 * Solid 链主题形状 = token 集 + Ink 兼容语义层。
 *
 * 兼容层（`user/assistant/tool/muted/borderUser`）存在的唯一理由：
 * RoleLabel / StatusBar / ToolCall 在 P5 之前直接读 `theme.user` 等字段；
 * P5 把这些字段保留为 token 的**别名**，保证老调用点在迁移期仍工作。
 */
export interface TuiSolidTheme extends TuiTokenPalette {
  /** 用户消息 / RoleLabel "You" 色（opencode secondary）。 */
  user: string;
  /** 助手消息 / RoleLabel "Agent" 色（opencode primary）。 */
  assistant: string;
  /** 工具消息 / RoleLabel "Tool" 色（opencode warning）。 */
  tool: string;
  /** 旧 `theme.muted` 别名（StatusBar 用）→ textMuted。 */
  muted: string;
  /** 用户消息块左竖条（opencode 用 agent hue，此处取 secondary）。 */
  borderUser: string;
  /** 当前 mode（"dark" | "light" | "noColor"）。 */
  mode: TuiThemeMode | "noColor";
}

// ---------------------------------------------------------------------------
// opencode.json 逐值落盘（dark / light）
// ---------------------------------------------------------------------------

const DARK: TuiTokenPalette = {
  primary: "#fab283", // darkStep9
  secondary: "#5c9cf5", // darkSecondary
  accent: "#9d7cd8", // darkAccent
  error: "#e06c75", // darkRed
  warning: "#f5a742", // darkOrange
  success: "#7fd88f", // darkGreen
  info: "#56b6c2", // darkCyan
  text: "#eeeeee", // darkStep12
  textMuted: "#808080", // darkStep11
  background: "#0a0a0a", // darkStep1
  backgroundPanel: "#141414", // darkStep2
  backgroundElement: "#1e1e1e", // darkStep3
  border: "#484848", // darkStep7
  borderActive: "#606060", // darkStep8
  borderSubtle: "#3c3c3c", // darkStep6
};

const LIGHT: TuiTokenPalette = {
  primary: "#3b7dd8", // lightStep9
  secondary: "#7b5bb6", // lightSecondary
  accent: "#d68c27", // lightAccent
  error: "#d1383d", // lightRed
  warning: "#d68c27", // lightOrange
  success: "#3d9a57", // lightGreen
  info: "#318795", // lightCyan
  text: "#1a1a1a", // lightStep12
  textMuted: "#8a8a8a", // lightStep11
  background: "#ffffff", // lightStep1
  backgroundPanel: "#fafafa", // lightStep2
  backgroundElement: "#f5f5f5", // lightStep3
  border: "#b8b8b8", // lightStep7
  borderActive: "#a0a0a0", // lightStep8
  borderSubtle: "#d4d4d4", // lightStep6
};

const NO_COLOR: TuiTokenPalette = {
  primary: "",
  secondary: "",
  accent: "",
  error: "",
  warning: "",
  success: "",
  info: "",
  text: "",
  textMuted: "",
  background: "",
  backgroundPanel: "",
  backgroundElement: "",
  border: "",
  borderActive: "",
  borderSubtle: "",
};

function withAliases(palette: TuiTokenPalette, mode: TuiSolidTheme["mode"]): TuiSolidTheme {
  return {
    ...palette,
    user: palette.secondary,
    assistant: palette.primary,
    tool: palette.warning,
    muted: palette.textMuted,
    borderUser: palette.secondary,
    mode,
  };
}

// ---------------------------------------------------------------------------
// 运行时 mode 切换（Task #5109 P7 —— /theme 命令）
// ---------------------------------------------------------------------------

/**
 * 运行时显式设置的 mode。null = 跟随 env（`resolveSolidTheme` 的初始语义）。
 *
 * **为什么模块级**：`roy-bot interactive` 是**单 TUI 进程**，主题天然是
 * 进程级状态（opencode 的 `context/theme.tsx` 同理）。`/theme` 命令需要
 * 在不重启进程、不重挂组件的前提下生效 ⇒ 必须有一个全局可变点。
 */
let runtimeMode: TuiThemeMode | null = null;

/**
 * Solid signal 镜像（`createSignal`）——组件订阅它，切换后自动重渲染。
 *
 * ⚠️ **为什么不直接用 signal 存状态**：signal 需要模块加载时立即初始化，
 * 而 `runtimeMode` 的初始值是 null（跟随 env）。两者并存：
 *   - `runtimeMode` 是**非响应式**真相源（`getTuiThemeMode` 读）；
 *   - `runtimeModeSignal` 是**响应式**镜像（组件订阅）；
 *   - `setTuiThemeMode` 同步写两边 ⇒ 组件收到通知。
 */
const [runtimeModeSignal, setRuntimeModeSignal] = createSignal<TuiThemeMode | null>(null);

/**
 * 显式设置运行时主题 mode（`/theme` 命令入口）。
 * 传 null = 清除显式设置，回到 env 解析。
 */
export function setTuiThemeMode(mode: TuiThemeMode | null): void {
  runtimeMode = mode;
  setRuntimeModeSignal(mode);
}

/** 清除显式设置，回到 env 解析。 */
export function resetTuiThemeMode(): void {
  runtimeMode = null;
  setRuntimeModeSignal(null);
}

/**
 * 读当前运行时 mode（不含 NO_COLOR 降级判定）。
 *
 *   1. 有显式设置 ⇒ 用它；
 *   2. 否则按 env：`ROY_TUI_THEME=light` ⇒ light，其余 dark。
 */
export function getTuiThemeMode(env: NodeJS.ProcessEnv = process.env): TuiThemeMode {
  if (runtimeMode) return runtimeMode;
  return env.ROY_TUI_THEME === "light" ? "light" : "dark";
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 按 mode 取主题（dark / light）。
 * 不传默认 dark（opencode 默认主题）。
 */
export function useTuiTheme(mode: TuiThemeMode = "dark"): TuiSolidTheme {
  return withAliases(mode === "light" ? LIGHT : DARK, mode);
}

/**
 * NO_COLOR 降级主题：所有 token = ""（`fg()` 把 "" → undefined，opentui 走默认前景）。
 */
export function getNoColorTheme(): TuiSolidTheme {
  return withAliases(NO_COLOR, "noColor");
}

/**
 * 按环境变量取主题（生产入口）：
 *   - `NO_COLOR` 真值 / `TERM=dumb` ⇒ NO_COLOR 主题（沿用 tui/theme.ts 的探测逻辑）
 *   - `ROY_TUI_THEME=light` ⇒ light
 *   - 其它 ⇒ dark
 *
 * 注：刻意**不**复用 `tui/theme.ts::getTheme` 的返回值——它是 Ink 语义色名
 * （cyan/yellow），与 opencode token 不同形状。仅复用它的 NO_COLOR 探测规则。
 */
export function resolveSolidTheme(env: NodeJS.ProcessEnv = process.env): TuiSolidTheme {
  if (env.NO_COLOR && env.NO_COLOR !== "0" && env.NO_COLOR !== "false") return getNoColorTheme();
  if (env.TERM === "dumb") return getNoColorTheme();
  const mode = getTuiThemeMode(env);
  // Task #5086 P5 (DS r3 MAJOR-2): the markdown ANSI palette must follow
  // the theme mode — the classic 16-colour codes are dark-background tuned
  // (heading cyan #00cdcd = 1.98:1 on white). Importing render/markdown.js
  // here is safe: it has no dependency on tui-solid (no cycle).
  setMarkdownPalette(mode);
  return useTuiTheme(mode);
}

// ---------------------------------------------------------------------------
// Task #5109 P7 —— 响应式主题 hook（`/theme` 命令的运行时切换）
// ---------------------------------------------------------------------------

/**
 * **响应式**主题读取：组件调用它 ⇒ 订阅 `runtimeModeSignal`，
 * `setTuiThemeMode(...)` 之后组件自动重渲染（无需重启进程）。
 *
 * ## 与 `resolveSolidTheme()` 的区别
 *
 * | 入口                     | 求值时机               | 适用场景                       |
 * |--------------------------|------------------------|--------------------------------|
 * | `resolveSolidTheme()`    | **调用时一次性**（函数体）| 非响应式读取（工具函数、首帧）   |
 * | `useTuiThemeReactive()`  | **每次属性访问时**      | 组件 JSX 内、需要 /theme 联动   |
 *
 * ## 返回 Proxy 的原因（DS r2 MAJOR-1 的教训）
 *
 * r1 的实现是 `const theme = useTuiThemeReactive()();` ——
 * **立即调用**把响应式读取变成了**挂载时快照** ⇒ `/theme` 只对
 * 已经订阅 signal 的组件（SlashPalette）生效，其余 UI 冻结。
 *
 * ⇒ 这里返回 **Proxy**：每次 `theme.primary` 访问都在
 * `runtimeModeSignal()` 的订阅上下文里重新取值 ⇒ 在真 Solid 转译下
 * （`scripts/build-cli-dev.ts`）JSX 内的属性访问是响应式 effect，
 * signal 变化 ⇒ effect 重跑 ⇒ 重新取色 ⇒ **全 UI 跟随 /theme**。
 *
 * ⚠️ **不要**写成 `useTuiThemeReactive()()`（立即调用 = 快照）。
 *
 * ## NO_COLOR 降级
 *
 * 环境级硬降级（NO_COLOR / TERM=dumb）**优先于运行时 mode**：
 * 环境变量在进程启动时已固定，运行时 mode 不能把它「改回彩色」。
 */
export function useTuiThemeReactive(): TuiSolidTheme {
  // 缓存：signal 值没变时不重算（避免每次属性访问都 resolveSolidTheme）。
  let cached: TuiSolidTheme | null = null;
  let cachedSignal: TuiThemeMode | null | undefined = undefined;
  const resolve = (): TuiSolidTheme => {
    const sig = runtimeModeSignal(); // 显式订阅（signal 变化 ⇒ 重算）
    if (!cached || sig !== cachedSignal) {
      cached = resolveSolidTheme();
      cachedSignal = sig;
    }
    return cached;
  };
  return new Proxy({} as TuiSolidTheme, {
    get(_target, prop) {
      const theme = resolve() as unknown as Record<string | symbol, unknown>;
      return theme[prop];
    },
  });
}

// ---------------------------------------------------------------------------
// 兼容 re-export（Ink 主题 + style 适配器）
// ---------------------------------------------------------------------------
import { setMarkdownPalette } from "../render/markdown.js";

export { getTheme } from "../tui/theme.js";
export type { TuiTheme } from "../tui/theme.js";

export { setMarkdownPalette } from "../render/markdown.js";
export type { MarkdownPalette } from "../render/markdown.js";

export { fg, attrsFromFlags, ansiToRuns, visibleWidth } from "./style.js";
export type { StyleFlags, StyledRun } from "./style.js";
