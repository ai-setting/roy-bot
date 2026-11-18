/**
 * @fileoverview commands-registry — Claude Code 风格 / 命令注册表
 *
 * Task #2312: 实现 / 命令自动匹配 + 弹窗
 *
 * 设计:
 * - 集中维护所有 slash command (10+ 条)
 * - 提供 filterCommands(query) 纯函数用于实时过滤
 * - 每个 command 含 cmd / desc / category / aliases (可选)
 * - handler 是可选的 UI 渲染层 — 实际命令路由仍由 interactive.ts 的 commandRegistry 完成
 *   (保持单一权威源: commandRegistry 是执行层, COMMANDS 是 UI 展示层)
 *
 * 分类:
 * - general    通用 (help, exit, quit)
 * - memory     记忆 (init, memory)
 * - model      模型 (model)
 * - session    会话 (compact, sessions)
 * - attachment 多模态 (attach, list, paste, clear)
 * - system     系统 (status, abort)
 */

export type CommandCategory =
  | "general"
  | "memory"
  | "model"
  | "session"
  | "attachment"
  | "system";

/**
 * 单个 slash command 的元数据 (UI 展示用)
 */
export interface Command {
  /** 主命令名, 必须以 "/" 开头, e.g. "/help" */
  cmd: string;
  /** 简短描述, 显示在弹窗中, e.g. "Show all commands" */
  desc: string;
  /** 分类标签, 用于分组和着色 */
  category: CommandCategory;
  /** 简写别名 (不含 /), e.g. ["h"] 表示 /h 也匹配 */
  aliases?: readonly string[];
}

/**
 * 所有 slash command 的注册表 (展示层)
 *
 * 与 interactive.ts 的 commandRegistry (执行层) 保持一致 —
 * 这里只列出会被 ink REPL 弹窗提示的命令, 不包括所有内部命令
 * (例如 /cls /st /s /q 等不在这里 — 它们是 /clear /status /sessions /quit 的别名, 通过 aliases 处理)
 *
 * 顺序: 按使用频率排序 (用户在第一次输入 / 时最先看到最常用的)
 */
export const COMMANDS: readonly Command[] = [
  // === general ===
  { cmd: "/help", desc: "Show all commands", category: "general", aliases: ["h"] },
  { cmd: "/quit", desc: "Exit interactive mode", category: "general", aliases: ["q", "exit"] },

  // === memory ===
  { cmd: "/init", desc: "Create memory file", category: "memory" },
  { cmd: "/memory", desc: "Show memory", category: "memory" },

  // === model ===
  { cmd: "/model", desc: "Switch model", category: "model" },

  // === session ===
  { cmd: "/compact", desc: "Compress context", category: "session", aliases: ["c"] },
  { cmd: "/sessions", desc: "List sessions", category: "session", aliases: ["s"] },

  // === attachment ===
  { cmd: "/attach", desc: "Add file/URL to attach", category: "attachment" },
  { cmd: "/list", desc: "List attachments", category: "attachment" },
  { cmd: "/paste", desc: "Paste from clipboard", category: "attachment" },
  { cmd: "/clear", desc: "Clear attach list", category: "attachment", aliases: ["cls"] },

  // === system ===
  { cmd: "/status", desc: "Show session status", category: "system", aliases: ["st"] },
  { cmd: "/abort", desc: "Abort in-flight request", category: "system" },
] as const;

/**
 * 实时过滤 slash command
 *
 * 匹配规则 (case-insensitive):
 * 1. cmd 主名包含 query (e.g. "/he" 匹配 "/help")
 * 2. 任一 alias 包含 query (e.g. "/q" 匹配 "/quit" 的 q alias)
 *
 * @param query 用户输入的字符串, 可以是:
 *   - "/" (空查询) → 返回全部命令
 *   - "/he" → 只匹配 /help
 *   - "he" 或 "h" → 同上 (自动 strip 前导 /)
 *   - "" → 返回全部
 *
 * @returns 匹配的命令数组 (按 COMMANDS 原始顺序, 不重新排序)
 */
export function filterCommands(query: string): Command[] {
  const q = query.trim().replace(/^\/+/, "").toLowerCase();
  if (q === "") {
    return [...COMMANDS];
  }
  return COMMANDS.filter((c) => {
    // 主名匹配: "/help" 去掉前导 / 后是 "help", 与 q 比较
    const cmdName = c.cmd.replace(/^\/+/, "").toLowerCase();
    if (cmdName.startsWith(q)) return true;
    if (cmdName.includes(q)) return true;
    // alias 匹配
    if (c.aliases) {
      for (const a of c.aliases) {
        if (a.toLowerCase().startsWith(q)) return true;
        if (a.toLowerCase().includes(q)) return true;
      }
    }
    return false;
  });
}

/**
 * Task #2657 Round 2 (T-B): subsequence fuzzy matcher.
 *
 * Returns true when every char in `query` appears in `target` in order
 * (chars do NOT need to be contiguous). This is the algorithm used by
 * fzf / VS Code quick-open / pi-mono command palette.
 *
 * Examples:
 *   fuzzyMatch("mdl", "model")  → true  (m...d...l appear in order)
 *   fuzzyMatch("hlp", "help")   → true  (h...l...p)
 *   fuzzyMatch("ldm", "model")  → false (out of order)
 *   fuzzyMatch("",    "model")  → true  (empty matches anything)
 *
 * Case-insensitive (both args lowercased before matching).
 *
 * pi-inspired: pi-mono's command palette uses subsequence fuzzy matching
 * for low-friction command discovery.
 */
export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
    }
  }
  return qi === q.length;
}

/**
 * Task #2657 Round 2 (T-B): fuzzy filter for slash command popup.
 *
 * Uses fuzzyMatch() against each command's cmd + aliases. Empty query
 * returns all commands (same UX as filterCommands).
 *
 * Behavior compared to filterCommands:
 *   - filterCommands: substring (contiguous) match — "mo" matches /model
 *   - filterCommandsFuzzy: subsequence match — "mdl" matches /model
 *
 * The popup uses filterCommandsFuzzy so users can type abbreviations or
 * scrambled chars and still find the command they want.
 */
export function filterCommandsFuzzy(query: string): Command[] {
  const q = query.trim().replace(/^\/+/, "");
  if (q === "") {
    return [...COMMANDS];
  }
  return COMMANDS.filter((c) => {
    const cmdName = c.cmd.replace(/^\/+/, "");
    if (fuzzyMatch(q, cmdName)) return true;
    if (c.aliases) {
      for (const a of c.aliases) {
        if (fuzzyMatch(q, a)) return true;
      }
    }
    return false;
  });
}

/**
 * 弹窗中一次最多显示的命令数 (超过滚动)
 */
export const MAX_POPUP_ITEMS = 8;

/**
 * 把命令分类转成可读的 label (用于弹窗分组/着色)
 */
export function categoryLabel(category: CommandCategory): string {
  switch (category) {
    case "general":
      return "general";
    case "memory":
      return "memory";
    case "model":
      return "model";
    case "session":
      return "session";
    case "attachment":
      return "attach";
    case "system":
      return "system";
  }
}