/**
 * @fileoverview 数据修复脚本 — 把 task #4033 损坏的 tags 字段从 CSV 转成 JSON 数组
 *
 * ## 历史背景 (Bug #4033)
 *
 * Task #4033 `[HTML 样式重构] v33 → v34：6 项 CSS 全面重构` 的 tags 字段
 * 被存成了 CSV 字符串 `'html-styling, css-refactor, v34, feishu, slides'`
 * 而非 JSON 数组 `["html-styling", "css-refactor", ...]`。
 *
 * `roy-bot tasks list` 默认 `ORDER BY updated_at DESC`，#4033 最近创建排在第一，
 * 触发 `JSON.parse(row.tags)` 的 `SyntaxError: Unexpected identifier "html"`，整个 CLI
 * 不显示任何任务。
 *
 * ## 修复策略（双层防御）
 *
 * 1. 代码层（推荐）：`sqlite-task-store.ts` 的 `parseTagsSafely` 对非法 JSON fallback，
 *    不让单个坏 row 阻塞整个列表。已 commit。
 * 2. 数据层（一次性）：把这个脚本跑一遍，把历史坏数据修正为合法 JSON 数组，
 *    让下游依赖 tags 类型的代码（CLI 渲染、tag 计算等）行为一致。
 *
 * ## 用法
 *
 *   bun packages/core/scripts/fix-task-4033-tags.ts
 *
 * 默认 DB 路径：`~/.local/share/roy-bot/tasks.db`
 * 自定义 DB 路径：设置 `ROY_AGENT_TASKS_DB` 环境变量。
 *
 * ## 幂等性
 *
 * 重新跑本脚本是安全的 — 已修正的 tags 是合法 JSON 数组，再 split + dump
 * 不会改变语义。
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";

const DB_PATH = process.env.ROY_AGENT_TASKS_DB ?? join(homedir(), ".local/share/roy-bot/tasks.db");
const TARGET_TASK_ID = 4033;

function parseCsvTags(csv: string): string[] {
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function main() {
  const db = new Database(DB_PATH);
  const row = db
    .query("SELECT id, title, tags FROM task WHERE id = ?")
    .get(TARGET_TASK_ID) as { id: number; title: string; tags: string | null } | undefined;

  if (!row) {
    console.error(`[fix-task-4033] Task #${TARGET_TASK_ID} not found in ${DB_PATH}`);
    process.exit(1);
  }

  if (!row.tags) {
    console.log(`[fix-task-4033] Task #${TARGET_TASK_ID} has no tags, nothing to do.`);
    db.close();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.tags);
  } catch {
    // 损坏数据：转 JSON 数组
    const fixed = JSON.stringify(parseCsvTags(row.tags));
    db.query("UPDATE task SET tags = ? WHERE id = ?").run(fixed, TARGET_TASK_ID);
    console.log(
      `[fix-task-4033] Task #${TARGET_TASK_ID} ("${row.title}"): tags was CSV, now ${fixed}`,
    );
    db.close();
    return;
  }

  if (Array.isArray(parsed)) {
    console.log(
      `[fix-task-4033] Task #${TARGET_TASK_ID} ("${row.title}"): tags already a valid JSON array, no-op.`,
    );
  } else if (typeof parsed === "string") {
    const fixed = JSON.stringify([parsed]);
    db.query("UPDATE task SET tags = ? WHERE id = ?").run(fixed, TARGET_TASK_ID);
    console.log(
      `[fix-task-4033] Task #${TARGET_TASK_ID}: tags was single JSON string, wrapped to ${fixed}`,
    );
  } else {
    console.log(
      `[fix-task-4033] Task #${TARGET_TASK_ID}: tags=${JSON.stringify(parsed)} (unrecognized type, left as-is)`,
    );
  }

  db.close();
}

main();
