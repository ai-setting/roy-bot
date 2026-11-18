#!/usr/bin/env bun
/**
 * Task #5403 — alias / linkedTo 废弃数据迁移（一次性脚本）
 *
 * ## 背景
 *
 * alias 能力（`session.linked_to` + SessionComponent 的 resolveSessionId 透传）
 * 已整体废弃：群 session 改为**独立会话**，关联关系存 metadata，建群时注入
 * 1 条 user role 事件作为背景提示。
 *
 * 存量 `linked_to` 数据不清掉会有两个后果：
 *  1. `sessions get <群>` 之类仍会把旧字段当成有效关系展示（误导）
 *  2. 旧的群 session 行是「空壳」（消息实际在 canonical 上），不清干净会让人
 *     以为群还在共享历史
 *
 * ## 做什么（逐行 3 步，幂等）
 *
 * 对每条 `linked_to` 非空的行：
 *  1. `metadata.linkedFromSessionId = <linked_to 的值>`
 *  2. `metadata.groupCreatedAt` 缺失时补上 `updated_at`（合理近似）
 *  3. 若该行**没有注入过事件**（消息数 0），注入 1 条 user role 事件
 *  4. `linked_to = NULL`（清空列；列本身保留，不 DROP —— 避免破坏性迁移）
 *
 * ## 幂等
 *
 * 已迁移过的行 `linked_to` 为空 ⇒ 直接跳过。重复执行安全。
 *
 * ## 用法
 *
 *   # 只演练，不写库（默认）
 *   bun run scripts/migrate-5403-drop-session-alias.ts
 *
 *   # 真写（先备份 sessions.db！）
 *   bun run scripts/migrate-5403-drop-session-alias.ts --apply
 *
 * ⚠️ 执行前务必确认 daemon 未在写（或接受 WAL 并发）：本脚本用同一个
 *    bun:sqlite 连接，WAL 模式下并发写是安全的（busy_timeout 由默认值兜底）。
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import os from "node:os";
import {
  buildGroupLinkEventMessage,
  buildGroupSessionMetadata,
} from "../packages/core/src/env/session/group-session-link";

const APPLY = process.argv.includes("--apply");

const DB_PATH =
  process.env.ROY_SESSIONS_DB ??
  path.join(os.homedir(), ".local/share/roy-bot/sessions.db");

type Row = {
  id: string;
  linked_to: string;
  metadata: string | null;
  updated_at: number;
};

function main() {
  console.log(`[5403] db = ${DB_PATH}`);
  console.log(`[5403] mode = ${APPLY ? "APPLY（会写库）" : "DRY-RUN（只打印）"}`);

  // readonly:true（dry-run）时 bun:sqlite 不接受 readwrite 选项，分开构造
  const db = APPLY ? new Database(DB_PATH, { readwrite: true }) : new Database(DB_PATH, { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");

  const rows = db
    .query(
      "SELECT id, linked_to, metadata, updated_at FROM session " +
        "WHERE linked_to IS NOT NULL AND linked_to != ''"
    )
    .all() as Row[];

  console.log(`[5403] 待迁移行数 = ${rows.length}`);
  if (rows.length === 0) {
    console.log("[5403] 无 alias 残留，nothing to do");
    return;
  }

  for (const row of rows) {
    const origin = row.linked_to.trim();
    const md = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};

    const nextMd = buildGroupSessionMetadata({
      chatId: typeof md.chatId === "string" && md.chatId.trim() ? md.chatId : row.id,
      originSessionId: origin,
      createdAt:
        typeof md.groupCreatedAt === "string"
          ? md.groupCreatedAt
          : new Date(row.updated_at).toISOString(),
      base: md,
    });

    const msgCount = (
      db.query("SELECT COUNT(*) as n FROM message WHERE session_id = ?").get(row.id) as {
        n: number;
      }
    ).n;

    console.log(
      `[5403]   ${row.id} -> ${origin}` +
        `（消息数=${msgCount}，${msgCount === 0 ? "将注入 1 条 user 事件" : "已有消息，不注入"}）`
    );

    if (!APPLY) continue;

    db.run("BEGIN");
    try {
      if (msgCount === 0) {
        const ev = buildGroupLinkEventMessage({ originSessionId: origin, chatId: row.id });
        const now = Date.now();
        db.run(
          "INSERT INTO message (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
          [`msg_5403_${crypto.randomUUID()}`, row.id, ev.role, ev.content, now]
        );
      }
      db.run("UPDATE session SET metadata = ?, linked_to = NULL, updated_at = ? WHERE id = ?", [
        JSON.stringify(nextMd),
        Date.now(),
        row.id,
      ]);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      console.error(`[5403]   ✗ ${row.id} 迁移失败: ${String(err)}`);
      throw err;
    }
  }

  if (APPLY) {
    const left = (
      db
        .query(
          "SELECT COUNT(*) as n FROM session WHERE linked_to IS NOT NULL AND linked_to != ''"
        )
        .get() as { n: number }
    ).n;
    console.log(`[5403] 迁移完成。剩余 linked_to 非空行数 = ${left}（期望 0）`);
  } else {
    console.log("[5403] DRY-RUN 结束。确认无误后加 --apply 真正执行。");
  }

  db.close();
}

main();
