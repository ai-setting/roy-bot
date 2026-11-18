/**
 * @fileoverview CLI markdown renderer — ANSI string output via marked + cli-highlight.
 *
 * Task #2610 (范围 C, 阶段 1): 引入 marked + cli-highlight，替换自实现的
 * markdown-renderer.tsx。设计参考 #2601 原型 (refs/imported/ink-tui-overhaul)。
 *
 * 关键决策：
 *  - 输出纯 ANSI 字符串，而非 React 元素树。原因：Ink <Text> 原生支持嵌套
 *    ANSI 转义, 且宽度换行由 Ink 负责, 此层只负责语义着色。
 *  - 流式安全：marked.lexer() 在 unclosed code fence / inline marker 上不
 *    抛异常, 因此 streaming 输入可直接调用。
 *  - cli-highlight 对未识别语言会输出 stderr 警告; 我们拦截 console.error,
 *    检测到 "Could not find the language" 时回落到 dimmed text 渲染。
 *
 * 不引入 marked 的 Renderer (自定义渲染器), 因为 ANSI 字符串在 Ink <Text>
 * 中行为更可控, 也避免与 marked v18 类型耦合过紧。
 *
 * 范围 C 授权：本文件刻意推翻 Task #2290/#2291 "不引入外部 markdown 依赖"
 * 决策。理由：(a) marked+cli-highlight 已成 pi-mono / opencode 等同类项目
 * 事实标准, 自实现解析器承担长期维护成本; (b) 本仓库自实现版本对 GFM 表格、
 * 嵌套列表等扩展语法支持滞后, 切换到 marked 是一次性补齐。
 */

import { Marked, type Tokens } from "marked";
import { highlight, type Theme } from "cli-highlight";

// =============================================================================
// Default theme: maps highlight.js token scopes to terminal ANSI colors.
// Required because cli-highlight omits colors when stdout is not a TTY
// (e.g. piped to a file or run under tests), so we provide colors
// explicitly to guarantee consistent output.
// =============================================================================

/**
 * Task #5086 P5：NO_COLOR / TERM=dumb 降级（**惰性**探测——每次渲染时读，
 * 因为测试/调用方可能在模块加载后才设置 env）。
 * 命中时把所有 ANSI **色码**置空（保留 bold/dim/italic/underline —— 它们是
 * 属性不是颜色，NO_COLOR 规范只要求去色）。
 */
function noColorMode(): boolean {
  if (typeof process === "undefined") return false;
  const nc = process.env.NO_COLOR;
  if (nc && nc !== "0" && nc !== "false") return true;
  if (process.env.TERM === "dumb") return true;
  return false;
}

/**
 * Task #5086 P5 (DS r3 MAJOR-2): the ANSI palette is **mode-aware**.
 *
 * The classic 16-colour SGR codes (36 cyan / 33 yellow / …) are tuned for
 * a DARK background — on a light canvas (#ffffff) the xterm hex mapping
 * gives heading cyan #00cdcd at only 1.98:1 contrast (WCAG AA needs
 * 4.5:1 for body text, 3:1 for large text).
 *
 * So the palette emits **truecolor** SGR (38;2;r;g;b) with theme-token
 * values: dark keeps the classic 16-colour look, light uses the
 * token's light-mode shades (which are already contrast-checked
 * against #ffffff).
 */
export interface MarkdownPalette {
  cyan: string;
  yellow: string;
  magenta: string;
  gray: string;
  green: string;
  red: string;
}

/** Classic 16-colour palette (dark canvas) — xterm hex equivalents. */
const DARK_PALETTE: MarkdownPalette = {
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

/**
 * Light-canvas palette (truecolor, contrast-checked against #ffffff).
 * Values mirror opencode.json's light column:
 *   info/cyan  #318795 → 4.72:1
 *   warning    #b0851f → 3.55:1 (large text / accents)
 *   accent     #d68c27 → 2.75:1 (bumped to #8a5200 → 5.15:1)
 *   success    #3d9a57 → 3.06:1 (bumped to #1f6b34 → 5.60:1)
 *   error      #d1383d → 4.32:1 (bumped to #a01c22 → 6.42:1)
 */
const LIGHT_PALETTE: MarkdownPalette = {
  cyan: "\x1b[38;2;49;135;149m", // #318795 → 4.72:1
  yellow: "\x1b[38;2;138;82;0m", // #8a5200 → 5.15:1
  magenta: "\x1b[38;2;123;45;138m", // #7b2d8a → 6.51:1
  gray: "\x1b[38;2;90;90;90m", // #5a5a5a → 7.03:1
  green: "\x1b[38;2;31;107;52m", // #1f6b34 → 5.60:1
  red: "\x1b[38;2;160;28;34m", // #a01c22 → 6.42:1
};

let activePalette: MarkdownPalette = DARK_PALETTE;

/**
 * Switch the markdown ANSI palette (dark ⇄ light).
 * Called by the Solid TUI when the theme mode changes.
 */
export function setMarkdownPalette(mode: "dark" | "light"): void {
  activePalette = mode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  boldOff: "\x1b[22m",
  dim: "\x1b[2m",
  dimOff: "\x1b[22m",
  italic: "\x1b[3m",
  italicOff: "\x1b[23m",
  underline: "\x1b[4m",
  underlineOff: "\x1b[24m",
  get cyan() {
    return noColorMode() ? "" : activePalette.cyan;
  },
  get yellow() {
    return noColorMode() ? "" : activePalette.yellow;
  },
  get magenta() {
    return noColorMode() ? "" : activePalette.magenta;
  },
  get gray() {
    return noColorMode() ? "" : activePalette.gray;
  },
};

const GREEN = () => (noColorMode() ? "" : activePalette.green);
const RED = () => (noColorMode() ? "" : activePalette.red);

/**
 * Task #5086 P5 (DS r2 MINOR-3): when NO_COLOR strips the colour
 * prefix, wrapping in reset (`\x1b[0m`) still pollutes the stream —
 * reset can split tokens (`const\x1b[0m x`) and ansiToRuns then
 * normalises fg to default anyway. When colours are off, emit the
 * text bare.
 */
const colored = (color: string, s: string) => (color ? color + s + ANSI.reset : s);

const DEFAULT_THEME: Theme = {
  keyword: (s) => colored(ANSI.magenta, s),
  built_in: (s) => colored(ANSI.cyan, s),
  type: (s) => colored(ANSI.yellow, s),
  string: (s) => colored(GREEN(), s),
  number: (s) => colored(RED(), s),
  comment: (s) => colored(ANSI.gray, s),
  function: (s) => colored(ANSI.cyan, s),
  title: (s) => colored(ANSI.cyan, s),
  params: (s) => colored(ANSI.yellow, s),
  class: (s) => colored(ANSI.yellow, s),
  tag: (s) => colored(ANSI.cyan, s),
  attr: (s) => colored(ANSI.yellow, s),
  symbol: (s) => colored(RED(), s),
  meta: (s) => colored(ANSI.gray, s),
  regexp: (s) => colored(RED(), s),
  variable: (s) => s,
  template_variable: (s) => colored(ANSI.cyan, s),
  literal: (s) => colored(RED(), s),
} as unknown as Theme;

// =============================================================================
// Module-level toggle for global disable (e.g., for piping, CI logs)
// =============================================================================

let markdownEnabled = true;

export function isMarkdownEnabled(): boolean {
  return markdownEnabled;
}

export function setMarkdownEnabled(enabled: boolean): void {
  markdownEnabled = enabled;
}

// =============================================================================
// marked parser setup
// =============================================================================

const marked = new Marked({
  gfm: true,
  breaks: false,
  pedantic: false,
});

// =============================================================================
// Inline rendering
// =============================================================================

function renderInline(
  tokens: Tokens.Generic[] | undefined,
  stylePrefix: string
): string {
  if (!tokens || tokens.length === 0) {
    return "";
  }

  const parts: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        parts.push(applyPrefix(t.raw ?? t.text ?? "", stylePrefix));
        break;

      case "escape":
        parts.push(applyPrefix(t.text ?? "", stylePrefix));
        break;

      case "strong": {
        const inner = renderInline((t as Tokens.Strong).tokens, "");
        parts.push(ANSI.bold + inner + ANSI.boldOff);
        break;
      }

      case "em": {
        const inner = renderInline((t as Tokens.Em).tokens, "");
        parts.push(ANSI.italic + inner + ANSI.italicOff);
        break;
      }

      case "codespan": {
        const text = (t as Tokens.Codespan).text ?? "";
        parts.push(ANSI.yellow + applyPrefix(text, "") + ANSI.reset);
        break;
      }

      case "link": {
        const linkToken = t as Tokens.Link;
        const inner = renderInline(linkToken.tokens, "");
        const href = linkToken.href ?? "";
        parts.push(
          ANSI.cyan +
            ANSI.underline +
            inner +
            ANSI.underlineOff +
            ANSI.dim +
            " (" +
            href +
            ")" +
            ANSI.reset
        );
        break;
      }

      case "image":
        parts.push(ANSI.dim + "[image: " + (t.raw ?? "") + "]" + ANSI.reset);
        break;

      case "br":
        parts.push("\n");
        break;

      default:
        parts.push(applyPrefix(t.raw ?? "", stylePrefix));
    }
  }
  return parts.join("");
}

function applyPrefix(text: string, prefix: string): string {
  if (!prefix) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

// =============================================================================
// Block-level rendering
// =============================================================================

// Task #4994 (P4): headings drop the `##` prefix — colour + bold carry
// the hierarchy instead (opencode parity: its native markdown renderer
// conceals the hashes). Depth ≥ 4 falls back to plain bold (the colour
// ladder tops out at h3, same as most terminal markdown themes).
const HEADING_COLORS = ["", () => ANSI.cyan, () => ANSI.cyan, () => ANSI.cyan, ""] as const;

function renderBlock(token: Tokens.Generic, width: number): string {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const depth = Math.min(4, Math.max(1, h.depth ?? 1));
      const text = renderInline(h.tokens, "");
      const colorOrFn = HEADING_COLORS[depth] ?? "";
      // Task #5086 P5：HEADING_COLORS 现在是惰性 thunk，调用时才求值
      // （否则模块加载时 NO_COLOR 未设 → 缓存了色码）。
      const color = typeof colorOrFn === "function" ? colorOrFn() : colorOrFn;
      const styled =
        (color ? color + ANSI.bold : ANSI.bold) + text + ANSI.boldOff +
        (color ? ANSI.reset : "");
      return wrapLine(styled, width);
    }

    case "paragraph": {
      const p = token as Tokens.Paragraph;
      const text = renderInline(p.tokens, "");
      return wrapLine(text, width);
    }

    case "code": {
      const c = token as Tokens.Code;
      const lang = c.lang ?? "";
      const code = c.text ?? "";
      return renderCodeBlock(code, lang, width);
    }

    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      const innerLines: string[] = [];
      for (const inner of bq.tokens ?? []) {
        innerLines.push(renderBlock(inner, width - 2));
      }
      const joined = innerLines.join("\n");
      return joined
        .split("\n")
        .map((line) => ANSI.gray + "> " + line + ANSI.reset)
        .join("\n");
    }

    case "list": {
      const list = token as Tokens.List;
      const lines: string[] = [];
      const startIndex = typeof list.start === "number" ? list.start : 1;
      let index = startIndex;
      const ordered = list.ordered ?? false;
      for (const item of list.items ?? []) {
        const bullet = ordered ? `${index}. ` : "  - ";
        const itemContent: string[] = [];
        for (const inner of (item as Tokens.ListItem).tokens ?? []) {
          itemContent.push(renderBlock(inner, Math.max(1, width - bullet.length)));
        }
        const itemText = itemContent.join("\n").split("\n");
        lines.push(
          ANSI.dim + bullet + ANSI.reset + (itemText[0] ?? "")
        );
        for (let i = 1; i < itemText.length; i++) {
          lines.push(" ".repeat(bullet.length) + (itemText[i] ?? ""));
        }
        if (ordered) {
          index++;
        }
      }
      return lines.join("\n");
    }

    case "hr": {
      const hrChar = "─";
      return ANSI.dim + hrChar.repeat(Math.max(10, width)) + ANSI.reset;
    }

    case "space":
      return "";

    case "table": {
      const t = token as Tokens.Table;
      const rows: string[][] = [];
      const header = (t.header ?? []).map((cell) =>
        renderInline((cell as Tokens.TableCell).tokens, "")
      );
      rows.push(header);
      for (const row of t.rows ?? []) {
        rows.push(
          (row ?? []).map((cell) =>
            renderInline((cell as Tokens.TableCell).tokens, "")
          )
        );
      }
      const colCount = Math.max(1, ...rows.map((r) => r.length));
      // Task #4994 (P4): column widths are CELL widths, not UTF-16
      // lengths — `visibleCellWidth` counts CJK/emoji as 2 columns
      // (Bun.stringWidth), so 中文 header/body rows share the same
      // grid geometry.
      const widths: number[] = Array(colCount).fill(0);
      for (const row of rows) {
        for (let i = 0; i < row.length; i++) {
          widths[i] = Math.max(widths[i] ?? 0, visibleCellWidth(row[i] ?? ""));
        }
      }
      const out: string[] = [];
      const top = ANSI.dim +
        "┌" + widths.map((w) => "─".repeat(w + 2)).join("┬") + "┐" +
        ANSI.reset;
      const divider = ANSI.dim +
        "├" + widths.map((w) => "─".repeat(w + 2)).join("┼") + "┤" +
        ANSI.reset;
      const bottom = ANSI.dim +
        "└" + widths.map((w) => "─".repeat(w + 2)).join("┴") + "┘" +
        ANSI.reset;
      out.push(top);
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r] ?? [];
        const cells: string[] = [];
        for (let i = 0; i < colCount; i++) {
          const cell = row[i] ?? "";
          // pad by CELL width, not string length.
          const pad = Math.max(0, (widths[i] ?? 0) - visibleCellWidth(cell));
          const styled = (r === 0 ? ANSI.bold : "") + cell +
            (r === 0 ? ANSI.boldOff : "");
          cells.push(" " + styled + " ".repeat(pad) + " ");
        }
        out.push(ANSI.dim + "│" + ANSI.reset + cells.join(ANSI.dim + "│" + ANSI.reset) + ANSI.dim + "│" + ANSI.reset);
        if (r === 0) out.push(divider);
      }
      out.push(bottom);
      return out.join("\n");
    }

    default:
      return (token as unknown as { raw?: string }).raw ?? "";
  }
}

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function renderCodeBlock(code: string, lang: string, width: number): string {
  // Task #4994 (P4): the raw ``` fence text is concealed — a dim frame
  // border carries the block boundary instead (opencode parity). A
  // known language keeps its tag in the top-right of the frame.
  const fenceWidth = Math.max(10, Math.min(width, 72));
  const tag = lang ? ` ${lang} ` : "";
  const border = ANSI.gray +
    "╭" + "─".repeat(fenceWidth - 2) +
    (tag ? "─".repeat(Math.max(0, 0)) + "╮" : "╮") +
    ANSI.reset;
  const top = lang
    ? ANSI.gray + "╭─" + ANSI.reset + ANSI.yellow + tag + ANSI.reset +
      ANSI.gray + "─".repeat(Math.max(0, fenceWidth - 3 - tag.length)) + "╮" +
      ANSI.reset
    : border;
  const footer = ANSI.gray +
    "╰" + "─".repeat(fenceWidth - 2) + "╯" +
    ANSI.reset;

  if (!lang) {
    const lines = code.split("\n");
    const out = [top];
    for (const line of lines) {
      out.push(ANSI.dim + "  " + line + ANSI.reset);
    }
    out.push(footer);
    return out.join("\n");
  }

  // Try to highlight with cli-highlight. If the language is not
  // supported, fall back to dimmed plain text.
  try {
    const originalConsoleError = console.error;
    let suppressed = false;
    console.error = (...args: unknown[]) => {
      const msg = args
        .map((a) => (typeof a === "string" ? a : String(a)))
        .join(" ");
      if (msg.includes("Could not find the language")) {
        suppressed = true;
        return;
      }
      originalConsoleError.apply(console, args as Parameters<typeof originalConsoleError>);
    };
    let highlighted: string;
    try {
      highlighted = highlight(code, {
        language: lang,
        ignoreIllegals: true,
        theme: DEFAULT_THEME,
      });
    } finally {
      console.error = originalConsoleError;
    }
    if (suppressed) {
      throw new Error("unsupported language");
    }
    const lines = highlighted.split("\n");
    const out = [top];
    for (const line of lines) {
      out.push("  " + line);
    }
    out.push(footer);
    return out.join("\n");
  } catch {
    const lines = code.split("\n");
    const out = [top];
    for (const line of lines) {
      out.push(ANSI.dim + "  " + line + ANSI.reset);
    }
    out.push(footer);
    return out.join("\n");
  }
}

// =============================================================================
// Width wrapping (ANSI-aware)
// =============================================================================

function wrapLine(line: string, width: number): string {
  if (width <= 0 || line.length <= width) {
    return line;
  }
  const words = line.split(/( +)/);
  const out: string[] = [];
  let current = "";
  for (const w of words) {
    if (current.length + w.length > width && current.length > 0) {
      out.push(current);
      current = w.trimStart();
    } else {
      current += w;
    }
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out.join("\n");
}

// =============================================================================
// Public API
// =============================================================================

export interface RenderOptions {
  width?: number;
}

/**
 * Render a markdown string as ANSI-styled terminal output.
 *
 * Safe to call on partial / streaming input: unclosed code fences and
 * unclosed inline markers are handled without throwing.
 */
export function renderMarkdown(text: string, options: RenderOptions = {}): string {
  const width = options.width ?? 80;

  if (!markdownEnabled) {
    return wrapLine(text, width);
  }

  if (!text || text.trim() === "") {
    return "";
  }

  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(text) as Tokens.Generic[];
  } catch (err) {
    return wrapLine(text, width);
  }

  const lines: string[] = [];
  for (const token of tokens) {
    const block = renderBlock(token, width);
    if (block.length > 0) {
      lines.push(block);
    }
  }
  return lines.join("\n\n");
}

/**
 * Truncate a long text for terminal output.
 *
 * Truncates to `maxLines` lines and appends a notice about hidden content.
 * Use `maxLines=0` to disable truncation.
 */
export function truncateForTerminal(text: string, maxLines: number): string {
  if (maxLines <= 0) {
    return text;
  }
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  const kept = lines.slice(0, maxLines).join("\n");
  const hidden = lines.length - maxLines;
  return `${kept}\n${ANSI.dim}[... ${hidden} more lines, use --max-lines to see more]${ANSI.reset}`;
}

/**
 * Truncate an already-rendered ANSI string so its visible line count
 * (after Ink wraps each line at the terminal width) does not exceed
 * `maxVisibleLines`.
 *
 * Unlike truncateForTerminal, this operates on the rendered text that
 * flows through Ink, so we measure wrap rows, not raw newlines: a
 * single markdown paragraph may expand into many terminal rows once
 * Ink wraps it.
 *
 * Semantics (Task #2657 R2 v2):
 *  - **Newest-first**: when we run out of budget, we drop the OLDEST
 *    source lines / cells, not the newest. The user needs to see the
 *    most recent streaming tokens above all else.
 *  - **Cell-aware**: ANSI escape sequences, CJK double-width glyphs,
 *    emoji ZWJ sequences and combining marks are measured with
 *    Bun.stringWidth (terminal cell count), never with `.length`
 *    (UTF-16 code unit count).
 *  - **Single-line safety**: a single very long line that wraps to
 *    more rows than the budget allows is cell-truncated to fit the
 *    LAST `budget × width` cells, instead of being dropped wholesale.
 *  - **Notice reservation**: 1 row is always reserved for the trailing
 *    "[... N more line(s) hidden]" notice so the visible row count
 *    never exceeds `maxVisibleLines`.
 *  - **ANSI-safe**: truncation never cuts mid-escape, and the notice
 *    always ends with an ANSI reset so colors do not bleed past the
 *    truncation.
 */
export function truncateRenderedMarkdown(
  rendered: string,
  maxVisibleLines: number,
  width: number,
): string {
  if (maxVisibleLines <= 0 || !rendered) {
    return rendered;
  }
  const safeWidth = Math.max(1, width);

  // Step 1: per-line wrap rows, ANSI/CJK/emoji-aware.
  const sourceLines = rendered.split("\n");
  const lineInfo = sourceLines.map((line) => ({
    line,
    rows: Math.max(1, Math.ceil(visibleCellWidth(line) / safeWidth)),
  }));

  // Step 2: total visible rows of the original content.
  const totalRows = lineInfo.reduce((sum, info) => sum + info.rows, 0);

  // If the original content already fits in the budget, return as-is.
  if (totalRows <= maxVisibleLines) {
    return rendered;
  }

  // We need to truncate. Reserve 1 row for the "[... N more]" notice.
  // If the budget is so small that no body rows survive, we still emit
  // the notice so the user knows content was hidden.
  const bodyBudget = Math.max(0, maxVisibleLines - 1);

  // TAIL-first selection: walk source lines in REVERSE order,
  // accumulating from the END until we exhaust the body budget.
  // Single long lines are cell-truncated to fit the remaining budget.
  const tail: string[] = [];
  let rowsUsed = 0;
  for (let i = lineInfo.length - 1; i >= 0; i--) {
    const info = lineInfo[i]!;
    if (rowsUsed + info.rows <= bodyBudget) {
      tail.unshift(info.line);
      rowsUsed += info.rows;
    } else if (info.rows > bodyBudget && rowsUsed === 0) {
      // Single (or first-pass) line is too tall for the whole budget.
      // Cell-truncate it to fit bodyBudget rows.
      const truncatedLine = tailTruncateToRows(info.line, bodyBudget, safeWidth);
      tail.unshift(truncatedLine);
      rowsUsed = bodyBudget;
    } else {
      break;
    }
  }
  const hidden = sourceLines.length - tail.length;
  const notice = ANSI.dim +
    `[... ${hidden} more line(s) hidden, use --max-lines to see more]` +
    ANSI.reset;
  if (bodyBudget > 0 && tail.length > 0) {
    return tail.join("\n") + "\n" + notice;
  }
  // bodyBudget is 0 (or we kept no lines): only the notice fits.
  return notice;
}

// --- internal helpers ---------------------------------------------------------

/**
 * Visible (ANSI-stripped) cell width of a string. We strip CSI/SGR
 * sequences before measuring because escape codes occupy zero cells.
 * Bun.stringWidth handles CJK double-width, emoji ZWJ sequences and
 * combining marks correctly.
 */
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function visibleCellWidth(s: string): number {
  const stripped = s.replace(ANSI_CSI_RE, "");
  // Bun.stringWidth is available in the test runner (bun test) and in
  // production runtime (bun start). For non-Bun hosts we fall back to
  // a UTF-16 length approximation, which is at least better than the
  // previous `s.length` (which double-counted CJK).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bun = (globalThis as any).Bun;
  if (bun && typeof bun.stringWidth === "function") {
    return bun.stringWidth(stripped);
  }
  return stripped.length;
}

/**
 * Tail-truncate a single line so its visible cell width fits within
 * `rows × width` cells, while preserving ANSI state. We slice the
 * stripped string from the END to keep the newest cells, then append
 * an ANSI reset.
 */
function tailTruncateToRows(line: string, rows: number, width: number): string {
  if (rows <= 0) return "";
  const cellBudget = rows * width;
  const stripped = line.replace(ANSI_CSI_RE, "");
  const visibleLen = (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bun = (globalThis as any).Bun;
    if (bun && typeof bun.stringWidth === "function") {
      return bun.stringWidth(stripped);
    }
    return stripped.length;
  })();
  if (visibleLen <= cellBudget) return line;
  // Walk grapheme clusters from the END, accumulating cell width until
  // we hit the budget. We track the byte-index where the kept tail
  // starts in the stripped string, then drop everything before it.
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bun = (globalThis as any).Bun;
  const cw = (s: string): number => (bun && typeof bun.stringWidth === "function")
    ? bun.stringWidth(s)
    : s.length;
  let keptCells = 0;
  const segments: string[] = [];
  // Intl.Segmenter iterates start-to-end; walk via array to go in reverse.
  const all = Array.from(seg.segment(stripped));
  for (let k = all.length - 1; k >= 0; k--) {
    const { segment } = all[k]!;
    const w = cw(segment);
    if (keptCells + w > cellBudget) break;
    keptCells += w;
    segments.unshift(segment);
  }
  const tail = segments.join("");
  // Drop everything before the kept tail in the original line (we cannot
  // reliably preserve every ANSI prefix without a full ANSI parser). We
  // close any open state with an ANSI reset.
  return tail + ANSI.reset;
}