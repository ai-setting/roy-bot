/**
 * @fileoverview B1 bridge 脚本（Task #4336）
 *
 * 监听 /tmp/card-action-consume.log 的 NDJSON 新行，
 * 解析 card.action.trigger，调 worktree 的 handleCardAction，
 * 用 lark-cli 真实建群/解散 + 用飞书 token patch 卡片。
 *
 * 架构：
 *   [飞书] → 卡片按钮被点
 *     ↓ EventBus
 *   [lark-cli consume] → NDJSON → /tmp/card-action-consume.log
 *     ↓ tail -f
 *   [bridge 脚本] → 解析事件 → 调 handleCardAction (worktree 代码)
 *     ↓
 *   [lark-cli chat-create] → 建群 / [lark-cli api DELETE .../members/me] → bot 退群
 *   [lark-cli api POST .../interactive/v1/card/update] → patch 卡片
 *
 * 用法：
 *   cd ~/work/codework/personal/roy_world/roy-bot/.worktrees/feat-lark-card-noauto
 *   bun run /tmp/bridge-card-action.ts
 *
 * 铁律：
 *   - 不动 main 分支，不 push
 *   - 不 commit 真 apiKey
 *   - 不 kill roy-bot 进程
 */

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  handleCardAction,
  type CardActionEvent,
  type CardActionPorts,
} from "../packages/core/src/env/task/plugins/lark-card-action-handler";

// ========================================================================
// Config
// ========================================================================

const LOG_FILE = "/tmp/card-action-consume.log";
const TASK_DB = resolve(process.env.HOME!, ".local/share/roy-bot/tasks.db");
const BRIDGE_TAG = `[bridge]`;

const log = (...args: unknown[]) => console.log(`${BRIDGE_TAG}`, new Date().toISOString(), ...args);
const warn = (...args: unknown[]) => console.warn(`${BRIDGE_TAG} WARN`, new Date().toISOString(), ...args);

// ========================================================================
// lark-cli wrapper（调 shell 命令，profile 来自 event）
// ========================================================================

function exec(cmd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((res, rej) => {
    const p = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res({ stdout, stderr, code });
      else rej(new Error(`exit ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
    });
    p.on("error", rej);
  });
}

/**
 * 用 lark-cli im messages patch 卡片（用 message_id，14 天有效）
 *
 * ★ 与 handler 的 patchCardByToken（用飞书 token）区别：
 *   - 用 message_id 替代 token（lark-cli 1.0.96 提供 `im messages patch`）
 *   - 14 天有效 vs 飞书 token 30 分钟有效
 *   - 不依赖飞书推 card.action.trigger 时给的 token（更适合 bridge 测试场景）
 *
 * @param messageId 飞书 message_id（卡片消息）
 * @param card 卡片 schema（CardPayload）
 * @param profile lark-cli profile
 */
async function patchCardByMessageId(messageId: string, card: any, profile?: string): Promise<void> {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  // content 必须是 JSON 字符串（second stringify），参看 event-source-handlers.ts:1183
  const data = JSON.stringify({ content: JSON.stringify(card) });
  const cmd =
    `lark-cli ${profileFlag}im messages patch --message-id ${shellQuote(messageId)} ` +
    `--data ${shellQuote(data)} --as bot`;
  const { stdout } = await exec(cmd, 30_000);
  log(`patchCardByMessageId ok: ${stdout.slice(0, 200)}`);
}

/**
 * 调 lark-cli im +chat-create 建群（bridge 版本）
 *
 * ★ 与 handler.ts 的 createGroupChatViaLarkCli 差异：
 *   - 不带 `--output json`（lark-cli 1.0.96 不支持；输出默认就是 JSON）
 *   - 多了 "oc_" hex 容错（防止正则漏匹配时返回错误信息）
 *   - ★ Task #4337：如果传了 initialUserIds，建群时直接通过 --users 把用户一起拉进去
 *     （lark-cli im +chat-create --users "ou_xxx"）
 *     比"建群后用 chat-members-API 再拉人"更可靠（飞书 API 后置邀请偶发 scope 不足）
 *
 * @returns 新建群的 chat_id（oc_xxx）
 */
async function bridgeCreateGroupChat(opts: {
  name: string;
  description: string;
  profile?: string;
  initialUserIds?: string[];
}): Promise<string> {
  const profileFlag = opts.profile ? `--profile ${opts.profile} ` : "";
  const usersFlag = opts.initialUserIds && opts.initialUserIds.length > 0
    ? `--users ${shellQuote(opts.initialUserIds.join(","))} `
    : "";
  // ★ 不要 --output json（lark-cli 1.0.96 不识别）
  // ★ 加 --format json 是默认；显式声明便于阅读
  const cmd =
    `lark-cli ${profileFlag}im +chat-create --name ${shellQuote(opts.name)} ` +
    usersFlag +
    `--description ${shellQuote(opts.description)} --as bot`;
  const { stdout } = await exec(cmd, 60_000);
  // 匹配 "chat_id":"oc_xxx"
  const m = stdout.match(/"chat_id"\s*:\s*"(oc_[a-f0-9]+)"/);
  if (!m) {
    throw new Error(`lark-cli +chat-create 返回无法解析: ${stdout.slice(0, 500)}`);
  }
  return m[1];
}

/**
 * Task #4337：建群后邀请用户进群（bridge 用 wrapper 同时支持端口）
 *
 * 实际上 lark-cli 1.0.96 没有 chat-members invite 命令，只有：
 *   - im +chat-create --users "ou_xxx"（建群时直接邀请）
 *   - im +chat-create --bots "cli_xxx"（邀请 bot）
 * 所以**我们做端口合并**：在 createGroupChat 时直接传 initialUserIds 邀请。
 *
 * bridge 端的具体实现：
 *   - ports.createGroupChat 已经支持 initialUserIds
 *   - ports.inviteUser 端口实现为：用桥接的 `_initialUserIds` 重新走 createGroupChat 路径不实用，
 *     所以这里我们直接把 inviteUser 实现为：从 chatName 与现有"skipped"列表取回 originalId，
 *     然后**noop**（实际邀请已经在 createGroupChat 里通过 --users 完成了）
 *
 * 真实工作流：
 *   1. handler 调 ports.createGroupChat({initialUserIds: [operator]}) → 这里 --users 直接传 → 建群就邀请了 ✅
 *   2. handler 调 ports.inviteUser() → noop（防止重复邀请）
 *
 * 注意：handler 的 inviteUser 是 OPTIONAL，未注入时也不会 fail。
 */
async function bridgeInviteUser(_chatId: string, _userOpenId: string, _profile?: string): Promise<void> {
  // 实际邀请在 bridgeCreateGroupChat 的 initialUserIds 里完成。
  // 此端口保留是为了让 handler 测试 mock ports.inviteUser（确认 ctx invitees 字段写入正确）。
  log(`bridgeInviteUser chatId=${_chatId} userOpenId=${_userOpenId}（实际邀请在 createGroupChat --users 里完成）`);
}

/**
 * "解散"群聊 = bot 退群（飞书 API 不支持解散群）
 * 复用 handler 的语义：执行可能失败但不阻断主流程（task.context 由 handler 清）
 */
async function bridgeDeleteGroupChat(chatId: string, profile?: string): Promise<void> {
  const profileFlag = profile ? `--profile ${profile} ` : "";
  // ★ Task #4339：修两个真 bug
  //   1) `/chats/:id/members/me` 是 404 不存在的路径 → 改用
  //      `DELETE /chats/:id/members?member_id_type=app_id` + {"id_list":[appId]}
  //   2) 去掉 `--yes`（`lark-cli api` 不接受该 flag）和 `2>/dev/null`
  //      （旧写法把失败伪装成"逻辑解散完成"，排障时完全看不到真因）
  try {
    const { stdout: authOut } = await exec(`lark-cli ${profileFlag}auth status --json`, 15_000);
    const appId = (JSON.parse(authOut) as { appId?: string }).appId;
    if (!appId) throw new Error("auth status 未返回 appId");

    const cmd =
      `lark-cli ${profileFlag}api DELETE /open-apis/im/v1/chats/${chatId}/members ` +
      `--params '{"member_id_type":"app_id"}' ` +
      `--data ${shellQuote(JSON.stringify({ id_list: [appId] }))} --as bot`;
    const { stdout } = await exec(cmd, 30_000);
    log(`bridgeDeleteGroupChat(${chatId}) ok: ${stdout.slice(0, 200)}`);
  } catch (err) {
    warn(`bridgeDeleteGroupChat(${chatId}) 失败（task.context 仍会清掉）: ${(err as Error).message}`);
  }
}

/** shell 单引号转义（name/description 可能有空格或单引号） */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ========================================================================
// bun:sqlite 端口（读 task / 写 context）
// ========================================================================

const db = new Database(TASK_DB);

interface TaskRow {
  id: number;
  title: string | null;
  description: string | null;
  goals_and_expected_deliverables: string | null;
  priority: string | null;
  type: string | null;
  project_path: string | null;
  parent_task_id: number | null;
  current_status: string | null;
  context: string | null;
}

async function getTask(id: number): Promise<TaskRow | undefined> {
  const row = db
    .query<TaskRow, [number]>(
      `SELECT id, title, description, goals_and_expected_deliverables as goals, priority, type, project_path,
              parent_task_id, current_status, context
       FROM task WHERE id = ?`
    )
    .get(id);
  return row ?? undefined;
}

async function updateTaskContext(id: number, newContext: string): Promise<void> {
  const now = Date.now();
  db.run(`UPDATE task SET context = ?, updated_at = ? WHERE id = ?`, [newContext, now, id]);
  log(`updated task #${id} context (${newContext.length} bytes)`);
}

/** 给 ports.notifier 一个 no-op（handler 内部不调它，但 TS 类型必填） */
const noopNotifier = {
  async startTask() {
    return { messageId: "noop", pinned: false };
  },
  async updateTask() {},
  async finishTask() {},
  async sendRedirectNotice() {
    return true;
  },
};

const ports: CardActionPorts = {
  getTask,
  updateTaskContext,
  createGroupChat: bridgeCreateGroupChat,
  deleteGroupChat: bridgeDeleteGroupChat,
  notifier: noopNotifier as any,
};

// ========================================================================
// NDJSON 解析 + 事件分发
// ========================================================================

function parseActionValue(raw: unknown): { action?: string; taskId?: number | string; [k: string]: unknown } | null {
  if (typeof raw !== "string") return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj as any;
  } catch {
    /* fallthrough */
  }
  return null;
}

async function handleNdjsonLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return; // 跳过日志行（[event] ...）
  let evt: any;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (evt?.type !== "card.action.trigger") return;

  const av = parseActionValue(evt.action_value);
  if (!av || !av.action || av.taskId == null) {
    warn(`事件缺 action/action_value: ${trimmed.slice(0, 200)}`);
    return;
  }

  // 过滤：只处理 buildTaskCard schema 期望的 action
  if (av.action !== "create_group" && av.action !== "disband_group") {
    log(`跳过非 B1 action: ${av.action}（taskId=${av.taskId}）`);
    return;
  }

  const event: CardActionEvent = {
    actionValue: { action: av.action as any, taskId: av.taskId as any },
    chatId: String(evt.chat_id ?? ""),
    messageId: String(evt.message_id ?? ""),
    token: String(evt.token ?? ""),
    operatorId: typeof evt.operator_id === "string" ? evt.operator_id : undefined,
    profile: typeof evt.profile === "string" ? evt.profile : undefined,
  };

  if (!event.token || !event.messageId || !event.chatId) {
    warn(`事件缺 token/messageId/chatId: ${trimmed.slice(0, 200)}`);
    return;
  }

  log(`收到 card.action.trigger: action=${av.action} taskId=${av.taskId} chatId=${event.chatId} messageId=${event.messageId}`);

  try {
    const result = await handleCardAction(event, ports);
    log(`handleCardAction 结果: ok=${result.ok} action=${result.action} newChatId=${result.newChatId ?? "(无)"} error=${result.error ?? "(无)"}`);

    if (result.ok && result.cardUpdate) {
      // bridge 用 message_id patch（不用 token，避免 token 失效问题）
      await patchCardByMessageId(event.messageId, result.cardUpdate, event.profile);
      log(`✅ 卡片 patch 成功（按钮已翻面）`);
    } else {
      warn(`handleCardAction 失败: ${result.error}`);
    }
  } catch (err) {
    warn(`handleCardAction 抛异常: ${(err as Error).message}`);
  }
}

// ========================================================================
// Tail -f 风格：监听 log 文件追加
// ========================================================================

let lastSize = 0;
let buffer = "";

async function processLines(lines: string[]): Promise<void> {
  for (const line of lines) {
    if (!line.trim()) continue;
    await handleNdjsonLine(line);
  }
}

async function readNew(): Promise<void> {
  const file = Bun.file(LOG_FILE);
  const stat = await file.stat().catch(() => null);
  if (!stat) {
    warn(`日志文件不存在: ${LOG_FILE}，等待...`);
    return;
  }
  if (stat.size === lastSize) return;
  if (stat.size < lastSize) {
    // 文件被 truncate/rotate，重新从 0 开始
    log(`日志文件 size 变小（${lastSize} → ${stat.size}），重置读指针`);
    lastSize = 0;
    buffer = "";
  }

  const slice = file.slice(lastSize, stat.size);
  const text = await slice.text();
  lastSize = stat.size;
  buffer += text;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // 最后一段可能不完整，留到下次
  await processLines(lines);
}

async function main() {
  log(`bridge 启动`);
  log(`  log file: ${LOG_FILE}`);
  log(`  task db:  ${TASK_DB}`);
  log(`  worktree: ${process.cwd()}`);
  log(`等待 card.action.trigger 事件...`);

  // 初始扫一遍（处理 bridge 启动前已经收到的事件）
  await readNew();

  // 用 fs.watch 监听文件追加（轻量级；不需要 chokidar）
  let debounce: NodeJS.Timeout | null = null;
  watch(LOG_FILE, { persistent: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      readNew().catch((e) => warn(`readNew err: ${(e as Error).message}`));
    }, 200);
  });

  // 兜底轮询（fs.watch 在某些场景可能漏事件）
  setInterval(() => {
    readNew().catch((e) => warn(`poll readNew err: ${(e as Error).message}`));
  }, 2000);
}

main().catch((e) => {
  console.error(`${BRIDGE_TAG} FATAL`, e);
  process.exit(1);
});
