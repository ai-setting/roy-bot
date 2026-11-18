/**
 * @fileoverview DesktopComponent Registration
 * 
 * Desktop 组件配置注册：
 * - 配置键声明
 * - 默认值
 * - Schema 定义
 */

import { z } from "zod";
import type { ComponentRegistration } from "@ai-setting/roy-bot-core";

// ============================================================================
// Schema
// ============================================================================

/**
 * Desktop events 配置 Schema
 */
export const DesktopEventsSchema = z.object({
  /** 是否启用事件订阅 */
  enabled: z.boolean().default(true),
  /** 订阅的事件类型（支持通配符） */
  types: z.array(z.string()).default(["agent.*", "tool.*", "session.*"]),
});

export type DesktopEventsConfig = z.infer<typeof DesktopEventsSchema>;

/**
 * Desktop Component 配置 Schema
 */
export const DesktopComponentConfigSchema = z.object({
  events: DesktopEventsSchema.default({}),
});

export type DesktopComponentConfig = z.infer<typeof DesktopComponentConfigSchema>;

// ============================================================================
// Defaults
// ============================================================================

/**
 * Desktop Component 默认值
 */
export const DESKTOP_COMPONENT_DEFAULTS: Record<string, unknown> = {
  "desktop.events.enabled": true,
  "desktop.events.types": ["agent.*", "tool.*", "session.*"],
};

// ============================================================================
// Component Registration
// ============================================================================

/**
 * Desktop Component 注册配置
 */
export const DESKTOP_COMPONENT_REGISTRATION: ComponentRegistration = {
  name: "desktop",
  sources: [],
  keys: [
    {
      key: "desktop.events.enabled",
      sources: ["memory", "env", "file"],
      default: true,
    },
    {
      key: "desktop.events.types",
      sources: ["memory", "env", "file"],
      default: ["agent.*", "tool.*", "session.*"],
    },
  ],
  schema: DesktopComponentConfigSchema,
  defaults: DESKTOP_COMPONENT_DEFAULTS,
};
