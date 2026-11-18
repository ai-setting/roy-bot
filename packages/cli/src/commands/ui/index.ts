/**
 * @fileoverview UI 改造模块集合 (Task #2252)
 *
 * 5 个核心组件:
 *   - welcome-card: 启动欢迎卡（含像素 logo）
 *   - input-slot:   输入区"槽位化"（上下边框）
 *   - status-bar:   底部常驻状态栏（mode + shortcuts + interrupt）
 *   - status-dot:   状态点 + 文字反馈（替代裸 spinner）
 *   - colors:       COLORS 3 档色阶（在 services/stream-output.service.ts 中）
 */

export {
  buildWelcomeCard,
  printWelcomeCard,
  PIXEL_LOGO_LINES,
  TIPS_LINES,
  WHATS_NEW_LINES,
  type WelcomeCardContext,
} from "./welcome-card";

export {
  buildTopBorder,
  buildBottomBorder,
  buildPromptHint,
  buildPromptPrefix,
  buildPromptLine,
  printSlotTop,
  printSlotBottom,
  printSlotHint,
  printSlotTopBorder,
  printSlotBottomBorder,
  getSlotWidth,
} from "./input-slot";

export {
  buildStatusBar,
  buildStatusBarForREPL,
  printStatusBar,
  printStatusBarHint,
  detectGitBranch,
  shortModelName,
  type REPLMode,
  type StatusBarContext,
} from "./status-bar";

export {
  buildStatusDot,
  startStatusDot,
  type DotStatus,
  type StatusDotController,
} from "./status-dot";
