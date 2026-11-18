/**
 * @fileoverview Task #4722 — command 子系统的共享类型
 *
 * 单独成文件，避免 `command-cards.ts` ↔ `command-registry.ts` 互相 import
 * 形成循环依赖（卡片渲染要读 command 的输出类型，command 要用卡片渲染）。
 */

/** 飞书 interactive 卡片 JSON（lark-cli 透传） */
export type LarkCard = Record<string, unknown>;
