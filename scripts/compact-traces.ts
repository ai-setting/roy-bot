#!/usr/bin/env bun
/**
 * @fileoverview traces.db 保留期压缩工具（Task #4479）
 *
 * ## 为什么需要它
 *
 * `~/.local/share/roy-bot/traces.db` 会无限增长：每个 span 都写一行，
 * 而 span 的数量随运行时间线性增长。2026-10-22 实测：
 * **169.3GB / 1885 万 span / 约 20GB 每天**。
 *
 * 本脚本做两件事：
 * 1. **裁剪** —— 只保留最近 N 天（默认 2 天）的 span
 * 2. **回收** —— `VACUUM` 真正把删除的空间还给文件系统
 *
 * ## 为什么不用 `DELETE FROM span WHERE start_time < ?`
 *
 * 源库曾经**没有 `start_time` 索引** → 全表 DELETE 要扫 169GB，超时。
 * 本脚本不依赖索引：利用「rowid 与 start_time 同序（append-only）」的性质，
 * **先二分定位 cutoff 的 rowid**，再按 rowid 区间批量删除。
 * 实测在 146GB 库上二分只花几秒。
 *
 * ## 用法
 *
 * ```bash
 * # 保留最近 2 天（默认）
 * bun run scripts/compact-traces.ts
 *
 * # 保留最近 7 天
 * bun run scripts/compact-traces.ts --keep-days 7
 *
 * # 只看会删多少，不真删（dry-run）
 * bun run scripts/compact-traces.ts --keep-days 2 --dry-run
 *
 * # 紧凑完顺便建索引（治本：让按时间查 trace 从超时→毫秒级）
 * bun run scripts/compact-traces.ts --keep-days 2 --index
 *
 * # 指定别的库
 * bun run scripts/compact-traces.ts --db /path/to/traces.db --keep-days 2
 * ```
 *
 * ## 安全约束
 *
 * - **不删库**：只删行 + VACUUM，绝不 `rm` 数据库文件
 * - 删前强制 `integrity_check`
 * - `--dry-run` 随时可用
 * - 需要进程**没有**持有该库时运行（否则 SQLITE_BUSY）；
 *   库在 WAL 模式下运行最安全
 *
 * ## 排期建议（cron / systemd timer）
 *
 * ```bash
 * # 每天 03:17 跑一次（错开整点，避免和其他定时任务撞车）
 * 17 3 * * * /usr/bin/flock -n /tmp/compact-traces.lock \
 *   ~/.nvm/versions/node/v24.19.0/bin/bun \
 *   ~/work/codework/personal/roy_world/roy-bot/scripts/compact-traces.ts \
 *   --keep-days 2 --index >> /tmp/compact-traces.log 2>&1
 * ```
 *
 * `flock -n` 保证同一时刻只有一个实例在跑。
 */

/* eslint-disable no-console */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Args {
  db: string;
  keepDays: number;
  dryRun: boolean;
  index: boolean;
  vacuum: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: join(homedir(), ".local/share/roy-bot/traces.db"),
    keepDays: 2,
    dryRun: false,
    index: false,
    vacuum: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep-days") args.keepDays = Number(argv[++i]);
    else if (a.startsWith("--keep-days=")) args.keepDays = Number(a.split("=")[1]);
    else if (a === "--db") args.db = argv[++i];
    else if (a.startsWith("--db=")) args.db = a.split("=")[1];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--index") args.index = true;
    else if (a === "--no-vacuum") args.vacuum = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun run scripts/compact-traces.ts [--keep-days N] [--db PATH] [--dry-run] [--index] [--no-vacuum]"
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.keepDays) || args.keepDays <= 0) {
    console.error(`[compact] invalid --keep-days: ${args.keepDays}`);
    process.exit(1);
  }
  return args;
}

function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${u[i]}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.db)) {
    console.error(`[compact] db not found: ${args.db}`);
    process.exit(1);
  }

  const sizeBefore = statSync(args.db).size;
  console.log(`[compact] db       : ${args.db}`);
  console.log(`[compact] size    : ${fmtBytes(sizeBefore)}`);
  console.log(`[compact] keepDays: ${args.keepDays}`);

  const db = new Database(args.db, { readwrite: true });
  db.exec("PRAGMA busy_timeout=120000;");

  const cutoff = Date.now() - args.keepDays * 24 * 3600 * 1000;
  console.log(`[compact] cutoff  : ${new Date(cutoff).toISOString()}`);

  const maxRow = db.query("SELECT MAX(rowid) m FROM span").get().m;
  if (!maxRow) {
    console.log("[compact] span table empty — nothing to do");
    db.close();
    return;
  }

  // ---- 定位 cutoff 边界（两段式：先用单调列粗定位，再按 start_time 精修） ----
  //
  // ⚠️ 2026-10-22 修复（交叉验证发现）：**不能直接用 start_time 做二分**。
  //
  // 原实现假设「rowid 与 start_time 同序」，但 span 是**在结束时** INSERT 的
  // （rowid 顺序 ≈ end_time），而 start_time 是**开始**时间。
  // 一条耗时很长的 span（start_time 很早、end_time 很晚）会把 start_time 序列
  // 打断 —— 数组不再单调，二分会落到**错误的位置**，
  // 可能把**仍在保留窗口内的近期行**一起删掉。
  //
  // 正确做法（两段式）：
  //   1) 粗定位：用**与 rowid 严格同序**的 `time_created`（插入顺序）二分，
  //      得到「肯定早于 cutoff 的最大 rowid」—— 这一步只会**多删**，不会少删。
  //   2) 精修：在粗边界附近，按 **start_time 精确**判定每一行，
  //      把「start_time >= cutoff 但被粗定位误伤」的行救回来。
  //
  // ⚠️ 不要给 Bun 的 query() 多传参数：第二个参数被当成 .all()/.get() 的
  // options 槽，多传会抛 "too many arguments"。绑定参数请用具名占位。
  const at = (rowid: number): number =>
    db.query("SELECT time_created FROM span WHERE rowid = $rowid").get({ $rowid: rowid })
      ?.time_created ?? 0;

  let lo = 1;
  let hi = maxRow;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (at(mid) >= cutoff) hi = mid; else lo = mid + 1;
  }
  // lo = 第一条 time_created >= cutoff 的 rowid
  const coarseKeepFrom = lo;
  console.log(
    `[compact] keepFrom : rowid ${coarseKeepFrom} (time_created ${new Date(at(coarseKeepFrom)).toISOString()})`,
  );

  // 粗边界附近按 start_time 精修：找出「真实的保留起点」。
  // 从粗边界**往前**回溯，直到遇到 start_time < cutoff 的行为止；
  // 这段区间里的 start_time >= cutoff 的行都属于保留窗口，必须保留。
  const REWIND = 500_000;
  const rewindTo = Math.max(1, coarseKeepFrom - REWIND);
  let realKeepFrom = coarseKeepFrom;
  if (rewindTo < coarseKeepFrom) {
    const rows = db
      .query(
        "SELECT rowid, start_time FROM span WHERE rowid >= $a AND rowid < $b ORDER BY rowid",
      )
      .all({ $a: rewindTo, $b: coarseKeepFrom });
    // 从后往前找第一条 start_time >= cutoff 的行 —— 它是保留窗口的真正起点
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].start_time >= cutoff) {
        realKeepFrom = rows[i].rowid;
        break;
      }
    }
    if (realKeepFrom !== coarseKeepFrom) {
      console.log(
        `[compact] refined   : keepFrom ${coarseKeepFrom} -> ${realKeepFrom} (start_time 精确边界)`,
      );
    }
  }

  const total = db.query("SELECT COUNT(*) c FROM span").get().c;
  // 用修正后的边界：realKeepFrom 是「第一条 start_time >= cutoff 的行」
  // 它之前的行全部 start_time < cutoff → 可以安全删除。
  const toDelete = realKeepFrom - 1;
  console.log(`[compact] total    : ${total} spans; will delete ${toDelete}, keep ${total - toDelete}`);

  if (args.dryRun) {
    console.log("[compact] dry-run — no changes made");
    db.close();
    return;
  }

  // ---- 删除 ----
  if (toDelete > 0) {
    // 删前强制 integrity_check（文件头承诺的行为）——
    // 169GB 的库删错了没法重来，宁可多花几分钟确认库是好的。
    let ti = Date.now();
    const integrity = db.query("PRAGMA integrity_check").get()?.integrity_check;
    console.log(
      `[compact] integrity: ${integrity} (${((Date.now() - ti) / 1000).toFixed(1)}s)`,
    );
    if (integrity !== "ok") {
      console.error("[compact] integrity_check 未通过 —— 放弃删除，不做任何改动");
      db.close();
      process.exit(1);
    }

    let t = Date.now();
    db.exec("BEGIN");
    try {
      db.exec(`DELETE FROM span WHERE rowid < ${realKeepFrom}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    console.log(`[compact] deleted  : ${toDelete} rows in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  // ---- 索引（治本） ----
  if (args.index) {
    const existing = db
      .query("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r: any) => r.name);
    if (!existing.includes("idx_span_start_time")) {
      let t = Date.now();
      db.exec("CREATE INDEX IF NOT EXISTS idx_span_start_time ON span(start_time)");
      console.log(`[compact] index    : idx_span_start_time created in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
    if (!existing.includes("idx_span_name_start")) {
      let t = Date.now();
      db.exec("CREATE INDEX IF NOT EXISTS idx_span_name_start ON span(name, start_time)");
      console.log(`[compact] index    : idx_span_name_start created in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
  }

  // ---- 清理「离群行」（straggler） ----
  //
  // 粗定位之后，边界**之后**可能还残留 start_time 很老的行 ——
  // 就是那类「跑了很久才结束」的 span（start_time 早、time_created 晚）。
  // 它们同样超出保留期，应该删掉。
  //
  // 这一步依赖 start_time 索引才快；没有索引时全表扫会很慢，
  // 因此只在「索引已存在」时执行（索引在下面 --index 分支里建，
  // 所以这里若没索引就跳过，由首次带 --index 的运行补上）。
  const hasStartIdx = db
    .query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_span_start_time'")
    .all()
    .length > 0;
  if (hasStartIdx) {
    const stray = db
      .query("SELECT COUNT(*) c FROM span WHERE rowid >= $r AND start_time < $cut")
      .get({ $r: realKeepFrom, $cut: cutoff });
    if (stray && stray.c > 0) {
      let t = Date.now();
      db.exec("BEGIN");
      try {
        db.exec(`DELETE FROM span WHERE rowid >= ${realKeepFrom} AND start_time < ${cutoff}`);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      console.log(
        `[compact] strays   : deleted ${stray.c} out-of-window rows in ${((Date.now() - t) / 1000).toFixed(1)}s`,
      );
    }
  }

  // ---- VACUUM 真正回收空间 ----
  if (args.vacuum) {
    let t = Date.now();
    console.log("[compact] vacuuming (this can take a while)...");
    db.exec("VACUUM");
    console.log(`[compact] vacuum   : done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  // ---- 校验 ----
  const after = db.query("SELECT COUNT(*) c, MIN(start_time) mn FROM span").get();
  console.log(`[compact] after    : ${after.c} spans, oldest ${new Date(after.mn).toISOString()}`);
  const sizeAfter = statSync(args.db).size;
  console.log(`[compact] size now : ${fmtBytes(sizeAfter)} (was ${fmtBytes(sizeBefore)})`);

  db.close();
  console.log("[compact] DONE");
}

main();
