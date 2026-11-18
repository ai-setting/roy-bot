/**
 * @fileoverview Task #4722 收口 — 飞书卡片升级 Card 2.0 + 可交互控件
 *
 * 缺口（审计发现）：
 * 1. 原卡片是 **Card 1.0 结构**（`config` / `header` / `elements` 顶层），
 *    按 lark-cli 官方文档 Card 2.0 必须有 `"schema": "2.0"` 且内容在
 *    `body.elements` 下，否则按 1.0 渲染 / 不渲染。
 * 2. 卡片只有纯文本展示，**没有交互控件** —— 用户需求明确要
 *    「卡片中可有可编辑的 list 来新增或调整 fallback model 优先级」。
 *
 * 目标契约：
 * - Card 2.0 骨架：`schema:"2.0"` + `header` + `body.elements`
 * - 每个 fallback 项带**上下移按钮**（callback 行为）
 * - 底部带**新增输入框 + 提交按钮**（form 行为）
 * - 按钮 value 用 `{action:"fbmodel", ...}` 命名空间，与 task 卡片的
 *   create_group/disband_group 区分开
 */

import { describe, test, expect } from "bun:test";

import {
  renderFallbackModelCard,
  renderTextCard,
  isFallbackModelCard,
} from "./command-cards";

/** 递归收集卡片里所有 tag */
function collectTags(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectTags(item, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.tag === "string") out.push(obj.tag);
    for (const v of Object.values(obj)) collectTags(v, out);
  }
  return out;
}

describe("Task #4722 收口：飞书卡片 Card 2.0 + 交互控件", () => {
  test("卡片是 Card 2.0 骨架（schema 2.0 + body.elements）", () => {
    const card = renderFallbackModelCard(["a/M1", "b/M2"], "tong/GLM");
    expect(card.schema).toBe("2.0");
    expect(Array.isArray((card.body as any)?.elements)).toBe(true);
    // 1.0 的顶层 elements 不应再存在
    expect((card as any).elements).toBeUndefined();
  });

  test("纯文本卡片也是 Card 2.0", () => {
    const card = renderTextCard("标题", "正文");
    expect(card.schema).toBe("2.0");
    expect(Array.isArray((card.body as any)?.elements)).toBe(true);
  });

  test("每个 fallback 项都有上移/下移按钮（可调优先级）", () => {
    const card = renderFallbackModelCard(["a/M1", "b/M2"], undefined);
    const tags = collectTags(card);
    // 2 项 → item1 有下移、item2 有上移 → 共 2 个调序按钮 + 1 个提交按钮 = 3
    expect(tags.filter((t) => t === "button").length).toBeGreaterThanOrEqual(3);

    const json = JSON.stringify(card);
    // 按钮 callback 的 action 命名空间
    expect(json).toContain("fbmodel");
    // 上移 / 下移动作
    expect(json).toContain("fbmodel_up");
    expect(json).toContain("fbmodel_down");
  });

  test("底部有新增输入框 + 提交按钮（可新增）", () => {
    const card = renderFallbackModelCard(["a/M1"], undefined);
    const tags = collectTags(card);
    expect(tags).toContain("form");
    expect(tags).toContain("input");
    // form 内提交按钮（Card 2.0：form 内按钮用 form_action_type，不用 behaviors）
    const json = JSON.stringify(card);
    expect(json).toContain("submit");
    // 新增动作靠按钮 name 标识（回调时 action_name === "fbmodel_add"）
    expect(json).toContain("fbmodel_add");
  });

  test("空列表也能渲染（引导用户先新增）", () => {
    const card = renderFallbackModelCard([], undefined);
    expect(card.schema).toBe("2.0");
    const json = JSON.stringify(card);
    expect(json).toContain("未配置");
    // 空列表时也要有新增入口
    expect(json).toContain("fbmodel_add");
  });

  test("卡片可被 isFallbackModelCard 识别（command 回调路由用）", () => {
    expect(isFallbackModelCard(renderFallbackModelCard(["a/M1"], undefined))).toBe(
      true
    );
    expect(isFallbackModelCard(renderTextCard("标题", "正文"))).toBe(false);
    expect(isFallbackModelCard({ schema: "2.0" })).toBe(false);
  });

  test("按钮 value 结构可被 JSON 往返（飞书要求 action_value 是 JSON 字符串）", () => {
    const card = renderFallbackModelCard(["a/M1", "b/M2"], undefined);
    const roundtrip = JSON.parse(JSON.stringify(card));
    expect(roundtrip).toEqual(card);
    // 找到第一个 callback 按钮，验证其 value 是可序列化对象
    const buttons: any[] = [];
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        const o = n as any;
        if (o.tag === "button") buttons.push(o);
        Object.values(o).forEach(walk);
      }
    };
    walk(card);
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      if (b.behaviors?.[0]?.type === "callback") {
        expect(typeof b.behaviors[0].value).toBe("object");
        expect(b.behaviors[0].value.action).toBeString();
      }
    }
  });
});
