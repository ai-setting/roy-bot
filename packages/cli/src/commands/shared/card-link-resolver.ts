/**
 * @fileoverview Task #5036 — 生产端卡片链接解析器（lark-cards.db → applink）
 *
 * 把持久层的卡片记录接到 `EventHandler.resolveCardUrl` 上。
 *
 * ## 数据流
 *
 * ```
 * lark-cards.db（表 lark_card：task_id PK / message_id / chat_id / profile）
 *   ↓ getCardRecordReader（只读语义，进程内单例）
 * resolveCardLinkForTask（chat 级 → 查 position → 消息级，best-effort）
 *   ↓
 * EventHandler.resolveCardUrl → 终态回执正文附 `[📌 查看任务卡片](url)`
 * ```
 *
 * ## ★ 生产库隔离（DS review B2，硬要求）
 *
 * core 的 `createLarkCardStateStore()` 只在**不传 dbPath** 时把测试环境降级成
 * 内存实现。本模块若显式传默认生产路径，会**绕过**那道保护，让 `bun test`
 * 以**读写模式**打开真实用户库（`PRAGMA journal_mode=WAL` / `CREATE TABLE` /
 * `ALTER TABLE` / `CREATE INDEX` 全都真跑）—— 实测确实把
 * `~/.local/share/roy-bot/lark-cards.db-wal` 的 mtime 改动了。
 *
 * ⇒ 这里加一道**自己的**守卫：测试环境 + 生产默认路径 ⇒ 直接拒绝（返回
 *   `undefined`，即"不附链接"）。守卫按**路径**判定而非只看 env，因为
 *   `ROY_AGENT_LARK_CARD_DB` 可以让生产环境指向任意库，测试也可能显式传。
 *
 * ## 为什么默认不查真实库
 *
 * `EventHandler` 是通用层（本地 REPL / CLI 触发 / 飞书群都在用）。
 * `chatId` 是 `cli:<sid>` 合成值时飞书侧必然拒绝 —— 那种情况下压根不该
 * 去查卡片库、更不该 spawn lark-cli。所以：
 *   - **解析器只由飞书事件路径装配**
 *   - 库文件不存在 / 打不开 / 守卫拒绝 ⇒ 返回 `undefined`（不附链接），绝不抛
 */

import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import {
  createLarkCardStateStore,
  getDefaultLarkCardDbPath,
  MemoryLarkCardStateStore,
  type LarkCardStateStore,
} from "@ai-setting/roy-bot-core/env/task/plugins";

import {
  buildCardOpenUrl,
  cacheCardLink,
  getCachedCardLink,
  resolveCardLinkForTask,
  type CardLinkRecord,
  type ResolveCardLinkDeps,
} from "./card-message-link";

export { getDefaultLarkCardDbPath };

/**
 * 进程内 store 单例。
 *
 * - 值 `null` = **永久不可用**（库文件不存在 —— 重启前不会再出现）
 * - 值 `{ store }` = 可用
 *
 * ★ DS review m2：以前把"首次打开抛错"也缓存成 `null`，一次瞬时 `SQLITE_BUSY`
 *   会让进程整个生命周期都拿不到链接。现在**只有「库文件不存在」才缓存 null**
 *   （那是稳定事实），打开失败不入缓存，下次调用重试。
 */
const storeCache = new Map<string, LarkCardStateStore | null>();

/**
 * 测试环境判定。
 *
 * 与 core `lark-card-state-store.ts` 同一套口径（`NODE_ENV=test` 或 bun test
 * 的 worker 标记），保证"什么算测试"两处不 drift。
 */
function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || "BUN_TEST_WORKER_ID" in process.env;
}

/**
 * 解析「该用哪个卡片库」——**与写端同一套优先级**（DS review N1）。
 *
 * 写端在 `core/env/task/plugins/lark-card-state-store.ts`：
 *   `dbPath ?? process.env.ROY_AGENT_LARK_CARD_DB ?? getDefaultLarkCardDbPath()`
 *
 * ★ 读端以前只认 `getDefaultLarkCardDbPath()`，于是任何设置了
 *   `ROY_AGENT_LARK_CARD_DB` 的部署：**卡片写进自定义库、回执读默认库** ⇒
 *   永远读不到 ⇒ 链接静默消失（= B1「写好了但生产不生效」的同型缺陷）。
 */
export function resolveCardDbPath(explicit?: string): string {
  return explicit ?? process.env.ROY_AGENT_LARK_CARD_DB ?? getDefaultLarkCardDbPath();
}

/**
 * 生产库候选路径集合（**import 期快照**，DS review N2）。
 *
 * 为什么不能每次现算 `getDefaultLarkCardDbPath()`：
 *   它读的是**调用时**的 `process.env.HOME`。测试（以及任何 monkeypatch HOME
 *   的代码）一旦改了 HOME，两侧就都算出同一个「假的默认路径」⇒ 守卫把
 *   **真实生产库**判成"非生产"⇒ B2 的安全网整体失效。DS review 已实测：
 *   `HOME=/tmp/fakehome` 后 reader 真的打开了真实生产库并读出 task #4954。
 *
 * 所以：在模块加载时（此时 HOME 还是真实的）把候选路径**快照**下来，
 * 之后无论 HOME 怎么变，都按这份快照判断。
 *
 * 覆盖多个位置（不只有硬编码默认值）：
 *   - `ROY_AGENT_LARK_CARD_DB`（写端官方覆盖点）
 *   - `$HOME/.local/share/roy-bot/lark-cards.db`（当前默认）
 *   - `$XDG_DATA_HOME/roy-bot/lark-cards.db`（XDG 规范位置）
 */
const PRODUCTION_DB_CANDIDATES: readonly string[] = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const set = new Set<string>();
  const push = (p: string | undefined) => {
    if (!p) return;
    try {
      set.add(resolvePath(p));
    } catch {
      // 非法路径（理论上不会）→ 跳过
    }
  };

  push(join(home, ".local", "share", "roy-bot", "lark-cards.db"));
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) push(join(xdg, "roy-bot", "lark-cards.db"));
  push(process.env.ROY_AGENT_LARK_CARD_DB);

  return [...set];
})();

/**
 * 是否禁止打开该路径（测试环境 + 生产候选路径 ⇒ 禁止）。
 *
 * ★ 必须**先规范化再比对**：`/a/./b` 与 `/a/../a/b` 是同一个文件，
 *   纯字符串相等比较能被这两种写法绕过（DS review N2 实测）。
 *
 * 只拦生产候选路径，不拦 tmp 库：测试需要能建自己的临时库。
 */
export function isForbiddenCardDbPath(dbPath: string): boolean {
  if (!isTestEnv()) return false;
  let normalized: string;
  try {
    normalized = resolvePath(dbPath);
  } catch {
    return true; // 路径非法 → 保守拒绝
  }
  return PRODUCTION_DB_CANDIDATES.includes(normalized);
}

/**
 * 取（或建立）卡片记录读取器。
 *
 * @returns 库文件不存在 / 测试环境指向生产库 / 打开失败 ⇒ `undefined`
 *          （**不**新建空库：本链路只读，凭空建一个空 db 会污染用户目录，
 *            且让 `existsSync` 判断失真）
 */
export function getCardRecordReader(
  dbPath: string = resolveCardDbPath(),
): ((taskId: number) => CardLinkRecord | undefined) | undefined {
  if (isForbiddenCardDbPath(dbPath)) return undefined;
  if (!existsSync(dbPath)) {
    // ★ N4：缓存 null 省掉反复 stat，但**库后来出现时必须能恢复** ——
    //   下次进来先 existsSync 判真了，就把陈旧的 null 丢掉重建。
    storeCache.set(dbPath, null);
    return undefined;
  }

  let cached = storeCache.get(dbPath);
  if (cached === null) {
    // 之前记过"库不存在"，现在库出现了 ⇒ 丢弃陈旧结论（N4）
    storeCache.delete(dbPath);
    cached = undefined;
  }
  if (cached === undefined) {
    try {
      cached = createLarkCardStateStore(dbPath);
    } catch {
      // ★ m2：瞬时故障**不**缓存，留给下次重试
      return undefined;
    }
    // ★ m3：sqlite 打不开时 core 会静默降级成内存 store —— 那等于"永远没有
    //   这张卡"，与"库坏了"无法区分。这里显式识别并当作不可用（不入缓存，
    //   下次仍可能恢复），避免把故障伪装成正常降级。
    if (cached instanceof MemoryLarkCardStateStore) {
      cached.close();
      return undefined;
    }
    storeCache.set(dbPath, cached);
  }
  if (!cached) return undefined;

  const resolved = cached;
  return (taskId: number): CardLinkRecord | undefined => {
    const rec = resolved.get(taskId);
    if (!rec?.chatId) return undefined;
    return {
      chatId: rec.chatId,
      ...(rec.messageId ? { messageId: rec.messageId } : {}),
      ...(rec.profile ? { profile: rec.profile } : {}),
    };
  };
}

/**
 * 造一个可直接注入 `EventHandler.resolveCardUrl` 的解析器。
 *
 * ⚠️ **永不抛**：库不存在 / sqlite 故障 / 查询异常一律降级为 `undefined`
 *    （= 回执不带链接），因为它是提示消息链路的**附加信息**。
 *
 * ## ★ Task #5080：为什么在这里分两步返回
 *
 * #5080 的生产现象（task 5077，回执是纯文本、没有「📌 查看任务卡片」）：
 *
 *   - `lark-cards.db` 里 **5077 的卡片记录是在的**
 *   - 但回执链路是：查卡片记录（零 IO，~0ms）→ **await** position 查询
 *     （spawn `lark-cli im +messages-mget`，实测 ~1.05s，负载高时更久）
 *     → 才决定返回 chat 级还是消息级
 *   - 而 `event-handler.ts` 的回执预算是 **2500ms**，超时即「没有链接」
 *   - 生产实测 span dur = **5664ms** > 2500ms ⇒ **预算超时 ⇒ 纯文本回执**
 *
 * ⇒ **本该零成本就能拿到的 chat 级链接，被一次慢 position 查询拖死了。**
 *
 * 本函数改成**有上界地等** position 查询：
 *
 *   1. **同步**读卡片记录（sqlite，WAL 模式，实测 p99=1ms）⇒ 有记录就说明
 *      「这张卡存在」，chat 级链接（`?openChatId=<oc>`）**零 IO**可得
 *   2. position 查询**有本地超时**地等一小会儿（缺省 1200ms）
 *      - 正常路径（~1s）⇒ 拿到**精确**链接（跳到那条卡片消息）
 *      - 慢 / 卡死 ⇒ 上界到点 ⇒ 降级 **chat 级**链接（**依然有链接**）
 *   3. 结果落进程内缓存 ⇒ 后续回执零成本命中
 *
 * ### 取舍
 *
 * - 慢路径下链接精度降级为 chat 级（跳到会话而不是跳到那条卡片消息）
 * - 代价：用户要在会话里找那张卡 —— 但**远好于 #5036 的原始诉求**
 *   （「否则还要点开 pin 来找对应的卡片消息」）
 * - 收益：**回执永远带链接**，且等待时间有硬上界（不会被 spawn 拖垮）
 *
 * ⚠️ 与 `event-handler.ts` 的 2500ms 预算是**两层**独立兜底：
 *   本层保证「有卡片记录 ⇒ 一定有链接」；外层保证「回执本身不被告住」。
 *
 * ### 为什么降级必须在这一层（不能放到 EventHandler）
 *
 * EventHandler **不知道**该 task 是否真有卡片 —— 在那一层凭空造 chat 级
 * 链接等于**编造**（实测会打破 4 条既有契约测试：「解析不出 URL ⇒ 不含
 * 链接」「未注入 ⇒ 逐字一致」「预算超时 ⇒ 不附链接」）。
 * 只有本层知道「卡片记录存在」⇒ 只有本层能保证「有卡片 ⇒ 有链接」。
 */
export function createCardUrlResolver(
  deps: {
    /** 库路径（测试用 tmp 库；缺省走 `getDefaultLarkCardDbPath()`） */
    dbPath?: string;
    /** 覆盖整条 lookup（测试用，避免真 spawn lark-cli） */
    lookupPosition?: ResolveCardLinkDeps["lookupPosition"];
    appLinkBase?: string;
    /**
     * ★ Task #5080：position 查询的**本地**上界（毫秒）。
     *
     * 缺省 1200ms：略高于实测常态值（bun 运行时 ~0.9-1.04s），留一点余量；
     * 又明显低于 `event-handler.ts` 的 2500ms 回执预算 ⇒ 外层预算**永远
     * 不会**先被打爆 ⇒ 有卡片记录就一定带得上链接。
     */
    lookupTimeoutMs?: number;
  } = {},
): (taskId: number) => Promise<string | undefined> {
  return async (taskId: number): Promise<string | undefined> => {
    try {
      const getCardRecord = getCardRecordReader(deps.dbPath);
      if (!getCardRecord) return undefined;

      // ★ 缓存命中 ⇒ 直接返回（含精确 position 链接），零 IO 零 spawn
      const cached = getCachedCardLink(taskId);
      if (cached !== undefined) return cached;

      // 读卡片记录（sqlite 点查，实测 p99=1ms；WAL 下不阻塞写）
      const record = getCardRecord(taskId);
      if (!record?.chatId) return undefined;

      // ★ chat 级链接是**零 IO**的 —— 它就是「有卡片记录」的证据。
      //   先算出来，作为 position 查询失败/超时时的降级目标。
      const chatLevelUrl = buildCardOpenUrl({
        chatId: record.chatId,
        appLinkBase: deps.appLinkBase,
      });
      if (!chatLevelUrl) return undefined;

      if (!record.messageId) {
        cacheCardLink(taskId, chatLevelUrl);
        return chatLevelUrl;
      }

      // ★ position 查询：**有上界**地等一小会儿。
      //   - 正常路径（~1s）⇒ 拿到**精确**链接（跳到那条卡片消息）
      //   - 慢/卡死 ⇒ 本地上界到点 ⇒ 降级 chat 级链接（**依然有链接**）
      //   绝不像修复前那样无限期 await —— 那会把 chat 级链接一起拖死，
      //   最终被外层 2500ms 预算砍成「纯文本回执」（生产实测 task 5077）。
      const exact = await resolveCardLinkForTask(taskId, {
        getCardRecord: () => record,
        ...(deps.lookupPosition ? { lookupPosition: deps.lookupPosition } : {}),
        ...(deps.appLinkBase ? { appLinkBase: deps.appLinkBase } : {}),
        ...(deps.lookupTimeoutMs !== undefined
          ? { lookupTimeoutMs: deps.lookupTimeoutMs }
          : {}),
      });

      const url = exact ?? chatLevelUrl;
      cacheCardLink(taskId, url);
      return url;
    } catch {
      return undefined;
    }
  };
}

/** 清空 store 单例（测试用） */
export function resetCardRecordStoreCacheForTest(): void {
  storeCache.clear();
}
