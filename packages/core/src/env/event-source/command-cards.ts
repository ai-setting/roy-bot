/**
 * @fileoverview Task #4722 — command 结果 → 飞书卡片渲染
 *
 * es 前端（lark-cli）用这些函数把 CommandResult 渲染成
 * 飞书 interactive 卡片。卡片 JSON 直接透传给
 * `lark-cli im +messages-reply --msg-type interactive --content`。
 *
 * ## 卡片版本：Card 2.0
 *
 * 按 lark-cli 官方卡片工作流（`lark-im/references/card/lark-im-card-create.md`），
 * Card 2.0 必须：
 * - 顶层 `"schema": "2.0"`（否则按 1.0 渲染）
 * - 内容放在 `body.elements`（不是 1.0 的顶层 `elements`）
 * - 交互组件用 `behaviors`（2.0 废弃了 1.0 的顶层 `action` 模块）
 *
 * ## 交互控件（用户需求：卡片中可有可编辑的 list）
 *
 * | 控件 | 行为 | 用途 |
 * |---|---|---|
 * | `button` × N | `behaviors:[{type:"callback"}]` | 每项的上移 / 下移（调优先级） |
 * | `form` + `input` + `button` | `form_action_type:"submit"` | 新增一个 fallback model |
 *
 * 按钮 callback 的 value 用 `action:"fbmodel*"` 命名空间，与 task 卡片的
 * `create_group` / `disband_group` 区分开 —— 回调路由据此分流。
 *
 * ## 降级路径
 *
 * 若飞书后台未开启 `card.action.trigger` 回调（consumer 能 ready 但收不到
 * 事件），卡片上的按钮不会生效。因此卡片**同时**保留文本指令引导，
 * 用户也可以直接敲 `##command##: fallback-model ...` 完成同样的操作。
 */

import type { LarkCard } from "./command-types";

/** 飞书 interactive 卡片 JSON（lark-cli 透传） */
export type { LarkCard };

/** 卡片主题色 */
const THEME = {
  primary: "blue",
  success: "green",
  warning: "orange",
} as const;

/**
 * command 卡片里按钮 callback 的 action 命名空间。
 *
 * 与 task 卡片的 `create_group` / `disband_group` 区分开，
 * 回调路由按前缀 `fbmodel` 分流到 command 子系统。
 */
export const FALLBACK_MODEL_ACTION_NS = "fbmodel";

/** 卡片 action 常量（回调路由与前端共用） */
export const FALLBACK_MODEL_ACTIONS = {
  /** 新增（form 提交） */
  add: `${FALLBACK_MODEL_ACTION_NS}_add`,
  /** 上移一项 */
  up: `${FALLBACK_MODEL_ACTION_NS}_up`,
  /** 下移一项 */
  down: `${FALLBACK_MODEL_ACTION_NS}_down`,
} as const;

/**
 * 判断一个卡片是不是 fallback-model 卡片。
 *
 * 用于回调路由：卡片被 patch 后再点按钮，仍能识别出是 command 卡片。
 *
 * ★ Task #4722 round2（交叉验证 MINOR-8）：**只按 header 标题判定**。
 *   Card 2.0 的顶层字段是固定的（schema / config / header / body），
 *   自定义顶层 key（如 `command: "fbmodel"`）有被飞书校验拒绝的风险 →
 *   不再使用。
 */
export function isFallbackModelCard(card: unknown): boolean {
  if (!card || typeof card !== "object") return false;
  const c = card as Record<string, unknown>;
  const header = c.header as Record<string, unknown> | undefined;
  const title = header?.title as Record<string, unknown> | undefined;
  return title?.content === "⚙️ Fallback Model 列表";
}

/**
 * 渲染纯文本卡片（标题 + markdown 正文）
 */
export function renderTextCard(title: string, content: string): LarkCard {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: THEME.primary,
    },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content,
        },
      ],
    },
  };
}

/**
 * 渲染 fallback-model list 卡片（Card 2.0，可交互）。
 *
 * @param list fallback 模型列表（有序 = 优先级，index 0 最高）
 * @param primaryModel 主模型（展示对照，可缺省）
 */
export function renderFallbackModelCard(
  list: string[],
  primaryModel?: string
): LarkCard {
  const elements: Record<string, unknown>[] = [];

  // ---- 主模型对照 ----
  if (primaryModel) {
    elements.push({
      tag: "markdown",
      content: `**主模型**：\`${primaryModel}\``,
    });
  }

  // ---- fallback 列表（每项带 上移/下移 按钮）----
  if (list.length === 0) {
    elements.push({
      tag: "markdown",
      content: "**fallback 列表**：⚠️ 未配置。主模型失败时不会自动降级。",
    });
  } else {
    elements.push({
      tag: "markdown",
      content: "**fallback 列表**（顺序 = 优先级，1 最高）：",
    });

    list.forEach((model, i) => {
      const row: Record<string, unknown>[] = [
        {
          tag: "markdown",
          content: `${i + 1}. \`${model}\``,
        },
      ];

      // 上移（不是第一项才有）
      if (i > 0) {
        row.push({
          tag: "button",
          text: { tag: "plain_text", content: "↑" },
          type: "default",
          size: "small",
          behaviors: [
            {
              type: "callback",
              value: {
                action: FALLBACK_MODEL_ACTIONS.up,
                index: i + 1,
                model,
              },
            },
          ],
        });
      }

      // 下移（不是最后一项才有）
      if (i < list.length - 1) {
        row.push({
          tag: "button",
          text: { tag: "plain_text", content: "↓" },
          type: "default",
          size: "small",
          behaviors: [
            {
              type: "callback",
              value: {
                action: FALLBACK_MODEL_ACTIONS.down,
                index: i + 1,
                model,
              },
            },
          ],
        });
      }

      elements.push({
        tag: "column_set",
        horizontal_spacing: "small",
        columns: [
          { tag: "column", width: "weighted", weight: 1, elements: row },
        ],
      });
    });
  }

  // ---- 分隔 ----
  elements.push({ tag: "hr" });

  // ---- 新增表单（form 内按钮用 form_action_type，不用 behaviors）----
  elements.push({
    tag: "form",
    name: "fbmodel_form",
    elements: [
      {
        tag: "input",
        name: "fbmodel_model",
        placeholder: { tag: "plain_text", content: "provider/model，如 tong/GLM-5.3-Flash" },
        required: true,
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "新增到 fallback 列表" },
        type: "primary_filled",
        form_action_type: "submit",
        // ★ form 内按钮没有 behaviors（2.0 规则）→ 靠 name 标识动作。
        //   回调时 `action_name === "fbmodel_add"`，
        //   新增的模型名从 `form_value["fbmodel_model"]` 取。
        name: FALLBACK_MODEL_ACTIONS.add,
      },
    ],
  });

  // ---- 文本指令降级引导 ----
  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: [
      "**文本指令**（按钮不可用时用这个）：",
      "- 新增：`##command##: fallback-model add <provider/model>`",
      "- 删除：`##command##: fallback-model remove <序号>`",
      "- 调优先级：`##command##: fallback-model reorder <原序号> <新序号>`",
      "- 查看：`##command##: list model`",
    ].join("\n"),
  });

  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "⚙️ Fallback Model 列表" },
      template: THEME.primary,
    },
    body: {
      direction: "vertical",
      elements,
    },
  };
}
