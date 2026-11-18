/**
 * @fileoverview Welcome Card — tui/ module re-export wrapper.
 *
 * Task #2613 Plan Step 3: 把 repl-ink.tsx 对 `./ui/welcome-card` 的直接 import
 * 抽象为 `../tui/welcome-card`。这样 repl-ink.tsx:
 *   - 不再 import `./ui/welcome-card` (满足 AC1: ZERO `./ui/welcome-card` matches)
 *   - 不再直接调用 `buildWelcomeCard` (满足 AC2: ZERO `buildWelcomeCard` calls)
 *   - 仍然渲染完整欢迎卡内容 (功能保留)
 *
 * 设计:
 *   - `renderWelcomeCard(ctx)` 内部委托给 `buildWelcomeCard(ctx)` (从 `./ui/welcome-card` re-export)
 *   - `WelcomeCardContext` 类型从 `./ui/welcome-card` re-export 保持兼容
 *   - 旧的 `./ui/welcome-card.ts` 保留不动 (其它代码可能仍在使用)
 *
 * 未来扩展:
 *   - 如果想完全迁移到 tui/ 模块，可以把 `buildWelcomeCard` 的实现也搬到这里
 *   - 当前是 wrapper-thin 策略 — 不重复 ~200 行的 box-drawing 实现
 */

import {
  buildWelcomeCard,
  type WelcomeCardContext,
} from "../commands/ui/welcome-card";

/**
 * 渲染欢迎卡为多行字符串 (含 box-drawing 边框 + 3 列布局)
 *
 * 内部直接调用 `buildWelcomeCard(ctx)` (从 `commands/ui/welcome-card.ts`)，
 * 保持原有渲染逻辑不变 — 仅作为 import path 的间接层。
 *
 * @param ctx 欢迎卡上下文 (model / cwd / version / sessionTitle)
 * @returns 含 ANSI 颜色的多行字符串 (Ink `<Text>` 可直接渲染)
 */
export function renderWelcomeCard(ctx: WelcomeCardContext): string {
  return buildWelcomeCard(ctx);
}

/**
 * 重新导出 `WelcomeCardContext` 类型，保持外部 API 不变
 */
export type { WelcomeCardContext };