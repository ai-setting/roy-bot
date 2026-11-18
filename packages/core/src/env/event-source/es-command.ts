/**
 * @fileoverview Task #5302 — `es` command（eventsource 管理斜杆命令）
 *
 * 用户需求（飞书明令 2026-11-11 10:11）：
 *   1. 斜杆命令 `/es add|list|del|mod` 管理 eventsource
 *   2. 飞书 `##command##: es <sub>` 触发（复用 Task #4722 command 子系统）
 *   3. interactive TUI 也要支持（见 packages/cli/src/tui-solid/interactive-slash-commands.ts）
 *
 * ## 数据面
 *
 * 直接读写 `~/.roy-bot/event-sources.json`（EventSourceComponent
 * 的持久化文件，格式 `{version, sources: EventSourceConfig[]}`）。
 *
 * 为什么不走组件实例：command 子系统是**无状态纯函数**（es 前端 /
 * CLI / interactive 三个前端共享），拿不到运行中的 EventSourceComponent；
 * 且 component.register() 会触发 saveConfig() 竞态。直接文件读写 +
 * 写后重读校验，与 reset-command.ts 同级简单度。
 *
 * ⚠️ 与运行中 daemon 的关系：本命令改的是**磁盘配置**。运行中的
 * EventSourceComponent 不会自动 reload（它只在启动时 loadConfig），
 * 改完需 `##command##: reset` 重启进程生效 —— 在输出里明确提示。
 *
 * ## 安全
 *
 * - add 重名拒绝（与 component.register 一致）
 * - mod 只允许白名单字段（enabled/name/interval/cron/profile）；
 *   command/url 属于命令注入面，mod 明确不允许（需 del + add）
 * - 写失败（磁盘/权限）→ ok:false，不静默
 *
 * ## 已知限制
 *
 * 参数按空白切分（飞书 `##command##:` 与 interactive `/es` 同规则），
 * 因此含空格的值（如 cron 表达式）无法经这两个前端写入；
 * CLI 侧可用引号传入。需要时用 CLI 或手工编辑 event-sources.json。
 */

import * as fs from "fs";
import * as path from "path";
import type {
  CommandContext,
  CommandDefinition,
  CommandResult,
} from "./command-registry";
import { renderTextCard, type LarkCard } from "./command-cards";

/** mod 允许修改的字段白名单（id/type 永不可改） */
const MOD_ALLOWED_FIELDS = [
  "enabled",
  "name",
  "interval",
  "cron",
  "profile",
] as const;

interface EsFileShape {
  version: string;
  sources: Record<string, unknown>[];
}

/** 从 configPath（config.jsonc）推导同目录的 event-sources.json */
export function resolveEsFilePath(configPath?: string): string {
  const dir = configPath ? path.dirname(configPath) : defaultRoyDir();
  return path.join(dir, "event-sources.json");
}

function defaultRoyDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.join(home, ".roy-bot");
}

function readEsFile(esFile: string): EsFileShape {
  if (!fs.existsSync(esFile)) {
    return { version: "1.0.0", sources: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(esFile, "utf-8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.sources)) {
      return parsed as EsFileShape;
    }
  } catch {
    /* fallthrough */
  }
  throw new Error(`event-sources.json 解析失败：${esFile}`);
}

/**
 * 原子写：temp 文件 + rename（★ DS review MINOR-3）。
 *
 * 直接覆盖写在崩溃/断电时可能留下半截 JSON（下次启动 loadConfig 直接失败）。
 * temp+rename 在同分区上是原子的，代价可忽略。
 */
function writeEsFile(esFile: string, data: EsFileShape): void {
  fs.mkdirSync(path.dirname(esFile), { recursive: true });
  const tmp = `${esFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, esFile);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw new Error(`写入 ${esFile} 失败：${(err as Error).message}`);
  }
}

function dualResult(text: string): CommandResult {
  return {
    ok: true,
    output: {
      text,
      card: renderTextCard("⚙️ EventSource 管理", text) as LarkCard,
      kind: "card",
    },
  };
}

const USAGE = [
  "用法：##command##: es <子命令> [参数]",
  "",
  "子命令：",
  "  list                    列出所有事件源",
  "  add <name> <type>       新增事件源（enabled=true）",
  "  del <name|id>           删除事件源（别名 remove）",
  "  mod <name|id> k=v       修改字段（enabled/name/interval/cron/profile；别名 update）",
  "",
  "  ⚠️ command/url 不可经 mod 修改（避免命令注入面）；如需改请 del 后 add。",
  "",
  "注意：修改的是磁盘配置，运行中的进程需「##command##: reset」重启后生效。",
].join("\n");

function findSource(
  sources: Record<string, unknown>[],
  nameOrId: string
): Record<string, unknown> | undefined {
  return sources.find(
    (s) => s.name === nameOrId || s.id === nameOrId
  );
}

/** 解析 k=v（v 尽量转原生类型） */
function parseKv(pair: string): { key: string; value: unknown } | null {
  const idx = pair.indexOf("=");
  if (idx <= 0) return null;
  const key = pair.slice(0, idx).trim();
  const rawValue = pair.slice(idx + 1).trim();
  let value: unknown = rawValue;
  if (rawValue === "true") value = true;
  else if (rawValue === "false") value = false;
  else if (rawValue !== "" && !Number.isNaN(Number(rawValue))) {
    value = Number(rawValue);
  }
  return { key, value };
}

function renderList(sources: Record<string, unknown>[]): string {
  if (sources.length === 0) {
    return "当前没有已配置的事件源。\n（可用「##command##: es add <name> <type>」新增）";
  }
  const lines = sources.map((s) => {
    const name = String(s.name ?? "?");
    const type = String(s.type ?? "?");
    const enabled = s.enabled === false ? "disabled" : "enabled";
    const id = String(s.id ?? "");
    return `- ${name}  [${type}]  ${enabled}  (${id})`;
  });
  return `事件源列表（${sources.length} 个）：\n${lines.join("\n")}`;
}

export const esCommand: CommandDefinition = {
  name: "es",
  description: "管理事件源（list/add/del/mod），改磁盘配置",
  usage: "##command##: es <list|add|del|mod> [参数]",

  async execute(ctx: CommandContext): Promise<CommandResult> {
    try {
      return await executeEsCommand(ctx);
    } catch (err) {
      // ★ DS review MAJOR-2：文件读写/解析异常**绝不向上抛**（command 契约要求
      //   ok:false + 可读 error；抛出会让 es 前端只看到「命令执行异常」泛化文案）。
      return {
        ok: false,
        error: `event-sources.json 读写失败：${(err as Error).message}`,
      };
    }
  },
};

/** 实际子命令实现（异常由外层 execute 统一兜底） */
async function executeEsCommand(ctx: CommandContext): Promise<CommandResult> {
  {
    const esFile = resolveEsFilePath(ctx.configPath);
    const [sub, ...rest] = ctx.args;

    switch (sub) {
      // ============================================================
      // list
      // ============================================================
      case "list":
      case undefined: {
        const data = readEsFile(esFile);
        return dualResult(renderList(data.sources));
      }

      // ============================================================
      // add <name> <type>
      // ============================================================
      case "add": {
        const [name, type] = rest;
        if (!name || !type) {
          return { ok: false, error: `用法：##command##: es add <name> <type>\n${USAGE}` };
        }
        const data = readEsFile(esFile);
        if (findSource(data.sources, name)) {
          return {
            ok: false,
            error: `事件源「${name}」已存在（add 拒绝重名）。可用 es mod 修改或 es del 删除后重建。`,
          };
        }
        const id = `es-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const source: Record<string, unknown> = {
          id,
          name,
          type,
          enabled: true,
        };
        data.sources.push(source);
        writeEsFile(esFile, data);
        return dualResult(
          `✅ 已新增事件源「${name}」[${type}]（id=${id}，enabled）。` +
            `重启进程后生效（##command##: reset）。`
        );
      }

      // ============================================================
      // del <name|id>
      // ============================================================
      case "del":
      case "remove": {
        const target = rest[0];
        if (!target) {
          return { ok: false, error: `用法：##command##: es del <name|id>\n${USAGE}` };
        }
        const data = readEsFile(esFile);
        const src = findSource(data.sources, target);
        if (!src) {
          return { ok: false, error: `未找到事件源「${target}」。` };
        }
        data.sources = data.sources.filter((s) => s !== src);
        writeEsFile(esFile, data);
        return dualResult(
          `✅ 已删除事件源「${String(src.name)}」（id=${String(src.id)}）。` +
            `重启进程后生效（##command##: reset）。`
        );
      }

      // ============================================================
      // mod <name|id> k=v [k=v...]
      // ============================================================
      case "mod":
      case "update": {
        const [target, ...pairs] = rest;
        if (!target || pairs.length === 0) {
          return {
            ok: false,
            error: `用法：##command##: es mod <name|id> k=v [k=v...]\n${USAGE}`,
          };
        }
        const data = readEsFile(esFile);
        const src = findSource(data.sources, target);
        if (!src) {
          return { ok: false, error: `未找到事件源「${target}」。` };
        }
        const applied: string[] = [];
        for (const pair of pairs) {
          const kv = parseKv(pair);
          if (!kv) {
            return { ok: false, error: `参数格式错误：「${pair}」（应为 k=v）\n${USAGE}` };
          }
          if (!(MOD_ALLOWED_FIELDS as readonly string[]).includes(kv.key)) {
            return {
              ok: false,
              error: `字段「${kv.key}」不允许修改（白名单：${MOD_ALLOWED_FIELDS.join("/")}；id/type 不可改）。`,
            };
          }
          // ★ DS review MINOR-4：改 name 不能与他人重名（否则 del/findSource 歧义）
          if (
            kv.key === "name" &&
            typeof kv.value === "string" &&
            kv.value !== src.name &&
            data.sources.some((s0) => s0 !== src && s0.name === kv.value)
          ) {
            return {
              ok: false,
              error: `名称「${String(kv.value)}」已被其它事件源占用，改 name 拒绝。`,
            };
          }
          // ★ DS review MINOR-6：enabled 强制布尔化（避免 enabled=1 写成 number）
          let value: unknown = kv.value;
          if (kv.key === "enabled") {
            value =
              kv.value === true ||
              kv.value === 1 ||
              kv.value === "1" ||
              kv.value === "true" ||
              kv.value === "yes" ||
              kv.value === "on";
          }
          src[kv.key] = value;
          applied.push(`${kv.key}=${String(value)}`);
        }
        writeEsFile(esFile, data);
        return dualResult(
          `✅ 已修改事件源「${String(src.name)}」：${applied.join("，")}。` +
            `重启进程后生效（##command##: reset）。`
        );
      }

      default:
        return {
          ok: false,
          error: `未知子命令「${sub}」。\n${USAGE}`,
        };
    }
  }
}
