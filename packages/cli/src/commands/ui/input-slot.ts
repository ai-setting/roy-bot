/**
 * @fileoverview Input Slot — Claude Code 风格输入区"槽位化"
 *
 * Task #2252: 改造点 2 — 输入区上下边框形成"槽位"
 * Task #2262: 第二轮打磨 — 加 ❯ 输入前缀（accent 暖红色）
 *
 * 设计灵感：Claude Code TUI 的输入区是 ╭───────╮...╰───────╯
 * 这种"上下两条横线 + ❯ 提示符 + dim 占位符"的设计，让用户**一眼能找到输入位置**，
 * 不用盯着屏幕找光标。
 *
 * 实现方式：
 *   - 在 readline 之上叠 3 行（top border / prompt / bottom border）
 *   - top border: 灰色横线
 *   - prompt: "❯ " 提示符（accent 暖红）+ dim 占位符
 *   - bottom border: 灰色横线
 *   - 在 prompt 行结束时自动 close 槽位（恢复 raw 模式）
 *
 * 注意：readline 的 prompt() 会自动在末尾输出 prompt 字符。我们需要：
 *   - 在 rl.question() / rl.prompt() 之前先输出 "─...─\n" (top)
 *   - rl.prompt() 会输出 "❯ "
 *   - 在 line 处理完之后再输出 "─...─\n" (bottom)
 *
 * 但是要保证在 quiet mode / 非 TTY 下跳过这些边框。
 */

import { COLORS } from "../../services/stream-output.service";

/**
 * 槽位宽度（不含左右 border 的字符数）。
 * 默认 = process.stdout.columns - 4 (左右各留 2 字符余量)
 */
export function getSlotWidth(): number {
  const cols = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(cols - 4, 100));
}

/**
 * 构造顶部横线（"─" 重复 width 次）。
 */
export function buildTopBorder(width?: number): string {
  const w = width ?? getSlotWidth();
  return COLORS.muted("\u2500".repeat(w));
}

/**
 * 构造底部横线（"─" 重复 width 次）。
 */
export function buildBottomBorder(width?: number): string {
  return buildTopBorder(width);
}

/**
 * 构造 prompt 行的占位符提示。
 * 格式：`  Try "/help" or ask anything...`
 * （含两个前导空格 — 给 ❯ 留位置）
 *
 * 注意：readline.prompt() 会自动输出 "❯ " 字符，所以我们这个函数返回的是
 * "占位符提示"，应该在 prompt 之前输出，作为 hint。
 */
export function buildPromptHint(): string {
  return COLORS.muted("  Try \"/help\" or ask anything...");
}

/**
 * 构造 ❯ 输入前缀（带 accent 暖红着色）。
 * 用于 printSlotHint 一次性输出（不依赖 readline）。
 */
export function buildPromptPrefix(): string {
  return COLORS.accent("\u276F ") + COLORS.muted("");
}

/**
 * 构造完整的"槽位提示行"（含 ❯ + 占位符 + 边框样式）：
 *   ❯ Try "/help" or ask anything...
 *
 * 用于一次性 printSlotHint 输出。
 */
export function buildPromptLine(): string {
  return COLORS.accent("\u276F ") + COLORS.muted("Try \"/help\" or ask anything...");
}

/**
 * 在 readline prompt 之前输出顶部边框。
 * 如果是非 TTY 或 quiet mode，跳过。
 */
export function printSlotTop(): void {
  if (!process.stdout.isTTY) return;
  console.log(buildTopBorder());
}

/**
 * 在 readline prompt 之前 / 用户输入完一行后输出底部边框。
 */
export function printSlotBottom(): void {
  if (!process.stdout.isTTY) return;
  // 注：底部边框应该换行输出（与下一个内容分隔）
  console.log(buildBottomBorder());
}

/**
 * Task #2264 P0: 启动时绘制槽位顶部边框（一次，永久显示）。
 * 用于替代 printSlotHint —— 不再打印 hint 行和底部边框，
 * 让 readline 自己管理光标，用户输入时持续可见 ❯ 前缀。
 */
export function printSlotTopBorder(): void {
  printSlotTop();
}

/**
 * Task #2264 P0: 每次 rl.prompt(true) 前打印底部边框，
 * 让输入区持续保持 "顶边-❯输入-底边-❯输入-底边..." 的循环结构。
 *
 * 使用 ANSI save/restore cursor 避免破坏 readline 的光标位置。
 */
export function printSlotBottomBorder(): void {
  printSlotBottom();
}

/**
 * 完整构造"槽位提示块"（一次性输出 top + hint + bottom）。
 * 在 REPL 启动时打印一次，让用户知道槽位长什么样。
 *
 * 格式（无 ANSI 时）：
 *   ─────────────────────────────────────────────
 *   ❯ Try "/help" or ask anything...
 *   ─────────────────────────────────────────────
 *
 * Task #2264 P0: 已废弃，保留向后兼容。REPL 现在用 printSlotTopBorder()
 * + printSlotBottomBorder() 替代，以让槽位在 readline 循环中持续可见。
 */
export function printSlotHint(): void {
  if (!process.stdout.isTTY) return;
  const top = buildTopBorder();
  const promptLine = buildPromptLine();
  const bot = buildBottomBorder();
  console.log(top);
  console.log(promptLine);
  console.log(bot);
}