/**
 * @fileoverview Status Dot — Claude Code 风格状态点 + 文字反馈
 *
 * Task #2252: 改造点 5 — 状态点 + 文字反馈（替代裸 spinner）
 *
 * 设计灵感：Claude Code TUI 的 `● high · /effort` 是颜色编码的圆点 + 文字标签，
 * 比裸 spinner 信息量大。
 *
 * roy-bot 改造点：用 `● thinking...` / `● executing (bash)` / `● ready` 替代传统 spinner。
 *
 * 实现方式：
 *   - 提供一个简单的 StatusDot class
 *   - start(label) → 输出 `● <label>` 并 start 内部定时器（每 0.3s 追加一个 .）
 *   - update(label) → 修改 label
 *   - stop(finalLabel, status) → 输出 `✓ <finalLabel>` 或 `✗ <finalLabel>`
 *
 *   注意：clack/prompts 的 spinner() 也会自动退到 TTY 检查，但因为它会自动
 *   clear screen 行（依赖 ANSI cursor up），可能和 readline 冲突。所以我们用
 *   自实现（不依赖 clack spinner），保持简单可靠。
 */

import { COLORS } from "../../services/stream-output.service";

export type DotStatus = "thinking" | "executing" | "loading" | "running" | "busy";

const ICON_BY_STATUS: Record<DotStatus, string> = {
  thinking: "\u25CF",   // ●
  executing: "\u25CF",  // ●
  loading: "\u25CF",    // ●
  running: "\u25CF",    // ●
  busy: "\u25CF",       // ●
};

const COLOR_BY_STATUS: Record<DotStatus, (s: string) => string> = {
  thinking: COLORS.accent,
  executing: COLORS.accent,
  loading: COLORS.secondary,
  running: COLORS.accent,
  busy: COLORS.accent,
};

/**
 * 单个 status dot 的文本构造。
 * `withDots=true` 会在 label 后追加 ".", "..", "..." 营造"思考中"氛围。
 */
export function buildStatusDot(
  status: DotStatus,
  label: string,
  withDots = false,
  dotCount = 0,
): string {
  const icon = ICON_BY_STATUS[status];
  const color = COLOR_BY_STATUS[status];
  const dots = withDots ? ".".repeat((dotCount % 3) + 1) : "";
  return color(`${icon} ${label}${dots}`);
}

export interface StatusDotController {
  /** 更新 label */
  update(newLabel: string): void;
  /** 停止并标记成功 */
  stopSuccess(finalLabel?: string): void;
  /** 停止并标记失败 */
  stopError(finalLabel?: string): void;
  /** 当前 label（只读） */
  readonly currentLabel: string;
}

/**
 * 启动一个 status dot 反馈（不依赖 clack）。
 *
 * @param status dot 类型
 * @param label 初始 label
 * @returns StatusDotController
 */
export function startStatusDot(
  status: DotStatus,
  label: string,
  options?: {
    /** 是否启用 dots 动画（每 0.3s 追加 .） */
    animateDots?: boolean;
    /** dot 动画间隔 (ms) */
    intervalMs?: number;
    /** 输出函数（默认 console.log） */
    writer?: (line: string) => void;
  },
): StatusDotController {
  const writer = options?.writer ?? ((line: string) => console.log(line));
  const animateDots = options?.animateDots ?? true;
  const intervalMs = options?.intervalMs ?? 300;

  let currentLabel = label;
  let stopped = false;
  let dotCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  // 第一次输出
  const initial = buildStatusDot(status, currentLabel, animateDots, dotCount);
  writer(initial);

  if (animateDots && process.stdout.isTTY) {
    timer = setInterval(() => {
      if (stopped) return;
      dotCount++;
      const line = buildStatusDot(status, currentLabel, true, dotCount);
      // 简化：用 ANSI CR (\r) 回到行首重写
      process.stdout.write(`\r${line}`);
    }, intervalMs);
  }

  return {
    update(newLabel: string) {
      if (stopped) return;
      currentLabel = newLabel;
      dotCount = 0;
      const line = buildStatusDot(status, currentLabel, animateDots, dotCount);
      if (process.stdout.isTTY && timer) {
        process.stdout.write(`\r${line}`);
      } else {
        writer(line);
      }
    },
    stopSuccess(finalLabel?: string) {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const text = finalLabel ?? currentLabel;
      // 清除当前行（用 ANSI clear + CR），输出 ✓
      if (process.stdout.isTTY) {
        process.stdout.write(`\r\u001B[2K\u2713 ${text}\n`);
      } else {
        writer(`\u2713 ${text}`);
      }
    },
    stopError(finalLabel?: string) {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const text = finalLabel ?? currentLabel;
      if (process.stdout.isTTY) {
        process.stdout.write(`\r\u001B[2K\u2717 ${text}\n`);
      } else {
        writer(`\u2717 ${text}`);
      }
    },
    get currentLabel() {
      return currentLabel;
    },
  };
}
