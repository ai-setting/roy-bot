/**
 * @fileoverview Status Bar — Claude Code 风格底部常驻状态栏
 *
 * Task #2252: 改造点 3 — 底部常驻状态栏
 * Task #2262: 第二轮打磨 — 扩展为多段信息（mode · tokens · git · cwd · shortcuts）
 *
 * 设计灵感：Claude Code TUI 底部固定一行
 *   `⏺ high · /effort · claude-sonnet · esc to interrupt`
 * 多段用 ` · ` 分隔，每段独立色阶。
 *
 * roy-bot 改造点：状态栏扩展为多段（4+ 段）
 *   1. mode:     ● ready  /  ● executing (bash) / ● thinking...
 *   2. tokens:   12k in / 234 out （可省略 if not provided）
 *   3. git:      ⎇ main （可省略）
 *   4. cwd:      ~/work/proj （缩略显示，可省略）
 *   5. shortcuts: ? for help （始终显示）
 *   6. interrupt: esc to interrupt （非 ready/shutdown 时显示）
 *   7. agent:    agent mode （可选，isAgentMode=true 时显示）
 *
 * 状态点 (●/○) 全部用 COLORS.accent 暖红色贯穿品牌色 — 不论 ready/active。
 * token/git/cwd 用 muted 灰色。help 段用 primary 白色。
 */

import { COLORS } from "../../services/stream-output.service";

export type REPLMode =
  | "ready"
  | "thinking"
  | "executing"
  | "error"
  | "compact"
  | "shutdown";

const MODE_ICON: Record<REPLMode, string> = {
  ready: "\u25CB",      // ○
  thinking: "\u25CF",   // ●
  executing: "\u25CF",  // ●
  error: "\u25CF",      // ●
  compact: "\u25CF",    // ●
  shutdown: "\u25CF",   // ●
};

const MODE_LABEL: Record<REPLMode, string> = {
  ready: "ready",
  thinking: "thinking...",
  executing: "executing",
  error: "error",
  compact: "compacting",
  shutdown: "shutting down",
};

const MODE_COLOR: Record<REPLMode, (s: string) => string> = {
  // Task #2262 P2: ready 也用 accent (暖红) 贯穿品牌色 — 状态点 ●/○ 全部暖红
  ready: COLORS.accent,
  thinking: COLORS.accent,
  executing: COLORS.accent,
  error: COLORS.error,
  compact: COLORS.accent,
  shutdown: COLORS.accent,
};

export interface TokenUsage {
  /** input tokens used */
  input: number;
  /** output tokens used */
  output: number;
}

export interface StatusBarContext {
  mode: REPLMode;
  /** 额外的状态信息（如当前正在执行的工具名） */
  detail?: string;
  /** 是否在 batch/agent 模式 */
  isAgentMode?: boolean;
  /** Task #2262: token 使用情况（input/output），可选 */
  tokens?: TokenUsage;
  /** Task #2262: 当前 git 分支名，可选 */
  gitBranch?: string;
  /** Task #2262: 当前工作目录（绝对路径），会自动缩略显示 */
  cwd?: string;
  /** Task #2264 P1: model 简短名（如 "M3"），作为独立段显示 */
  model?: string;
}

/**
 * 格式化 token 数字为人类可读（k/M 单位）。
 *   1234 → "1k"
 *   12345 → "12k"
 *   1234567 → "1.2M"
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * 缩略显示 cwd：`~/work/code/proj/foo` → `~/.../foo`
 *   - 如果 cwd 在 $HOME 下，用 ~ 替换 home
 *   - 保留最后 2 级目录
 */
export function shortenCwd(cwd: string, home?: string): string {
  if (!cwd) return "";
  const h = home ?? process.env.HOME ?? "";
  let shortened = cwd;
  let isHome = false;
  if (h && cwd.startsWith(h)) {
    shortened = "~" + cwd.slice(h.length);
    isHome = true;
  }
  // 保留最后 2 级目录
  const parts = shortened.split("/").filter(Boolean);
  if (parts.length <= 2) return shortened;
  // 如果是 home 路径，保留 ~ + 最后 2 级（避免 ~ 被误算成 part 导致过度截断）
  const last2 = parts.slice(-2).join("/");
  return isHome ? `~/${last2}` : `.../${last2}`;
}

import { execSync } from "node:child_process";

/**
 * Task #2264 P1: 探测当前目录的 git 分支名。
 *
 * 实现：execSync 同步子进程 `git rev-parse --abbrev-ref HEAD`。
 * - 如果不在 git repo / git 不可用 / 超时 → 返回 undefined
 * - 失败时不抛错，向后兼容
 *
 * 注意：每次调用都会 spawn 一个 git 进程。生产环境应该缓存结果。
 */
export function detectGitBranch(cwd?: string): string | undefined {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const branch = out.trim();
    // 排除 HEAD (detached) / 空
    if (!branch || branch === "HEAD") return undefined;
    return branch;
  } catch {
    return undefined;
  }
}

/**
 * Task #2264 P1: 探测 model 的简短名（去掉 provider 前缀）。
 *
 *   "MiniMax-M3"        → "M3"
 *   "claude-3-5-sonnet" → "sonnet"
 *   "gpt-4o"            → "4o"
 *
 * 取最后一段（按 - 分割），≤6 字符就返回，否则截取前 6。
 */
export function shortModelName(model: string): string {
  if (!model) return "";
  const lastDash = model.split("-").pop() ?? model;
  if (lastDash.length <= 6) return lastDash;
  return lastDash.slice(0, 6);
}

/**
 * Task #2264 P1: 构造状态栏 5+ 段的便捷 builder。
 * 自动调用 shortModelName() 把 model 转成短名，作为独立段显示。
 *
 * 与 buildStatusBar() 不同：model 字段被自动 shortName 化。
 */
export function buildStatusBarForREPL(opts: {
  mode: REPLMode;
  model?: string;
  cwd?: string;
  gitBranch?: string;
  tokens?: TokenUsage;
  detail?: string;
  isAgentMode?: boolean;
}): string {
  const modelShort = opts.model ? shortModelName(opts.model) : undefined;
  return buildStatusBar({
    mode: opts.mode,
    model: modelShort,
    cwd: opts.cwd,
    gitBranch: opts.gitBranch,
    tokens: opts.tokens,
    detail: opts.detail, // detail 只在 non-ready mode 显示
    isAgentMode: opts.isAgentMode,
  });
}

/**
 * 构造单行状态栏（带 ANSI 颜色）。
 *
 * 格式（无 ANSI 时）：
 *   `● ready · 12k in / 234 out · ⎇ main · ~/work/proj · ? for help`
 *
 * 各段独立着色：
 *   - mode 段：accent (暖红) 或 secondary (灰) — 取决于 mode
 *   - tokens 段：muted 暗灰
 *   - git 段：muted 暗灰
 *   - cwd 段：muted 暗灰
 *   - help 段：primary 亮白
 *   - interrupt 段：muted 暗灰
 *   - agent 段：muted 暗灰
 */
export function buildStatusBar(ctx: StatusBarContext): string {
  const icon = MODE_ICON[ctx.mode];
  const label = MODE_LABEL[ctx.mode];
  const color = MODE_COLOR[ctx.mode];

  // 第 0 段：model 简短名 (Task #2264 P1)
  const modelSegment = ctx.model
    ? COLORS.primary(ctx.model)
    : null;

  // 第 1 段：● mode (detail)
  const modeText = ctx.detail && ctx.mode !== "ready"
    ? `${label} (${ctx.detail})`
    : label;
  const modeSegment = color(`${icon} ${modeText}`);

  // 第 2 段：tokens（12k in / 234 out）
  const tokensSegment = ctx.tokens
    ? COLORS.muted(`${formatTokens(ctx.tokens.input)} in / ${formatTokens(ctx.tokens.output)} out`)
    : null;

  // 第 3 段：git 分支（⎇ main）
  const gitSegment = ctx.gitBranch
    ? COLORS.muted(`\u2387 ${ctx.gitBranch}`)
    : null;

  // 第 4 段：cwd（缩略）
  const cwdSegment = ctx.cwd
    ? COLORS.muted(shortenCwd(ctx.cwd))
    : null;

  // 第 5 段：? for help (始终)
  const helpSegment = COLORS.primary("? for help");

  // 第 6 段：esc to interrupt (非 ready/shutdown)
  const interruptSegment = ctx.mode === "ready" || ctx.mode === "shutdown"
    ? null
    : COLORS.muted("esc to interrupt");

  // 第 7 段：agent mode 标识（isAgentMode）
  const agentSegment = ctx.isAgentMode
    ? COLORS.muted("agent mode")
    : null;

  const segments = [modelSegment, modeSegment, tokensSegment, gitSegment, cwdSegment, helpSegment, interruptSegment, agentSegment]
    .filter((s): s is string => s !== null);
  return segments.join(COLORS.muted(" \u00B7 "));
}

/**
 * 打印状态栏到 stdout。
 */
export function printStatusBar(ctx: StatusBarContext): void {
  console.log(buildStatusBar(ctx));
}

/**
 * 启动时常驻状态栏的 hint（一次性打印，让用户知道底部会有状态栏）。
 *
 * Task #2264 P1: 接受可选 ctx 参数，让 REPL 启动时一次性展示 5 段：
 *   mode · tokens · git · cwd · help
 * 向后兼容（ctx 可选），传 undefined 时退化为旧版 2 段 (ready + help)。
 */
export function printStatusBarHint(ctx?: Partial<StatusBarContext>): void {
  if (!process.stdout.isTTY) return;
  console.log(buildStatusBar({ mode: "ready", ...ctx }));
}