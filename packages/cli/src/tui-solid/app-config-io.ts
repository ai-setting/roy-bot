/**
 * @fileoverview Task #5116 P7.1 —— auth.json / config.jsonc 配置 IO（纯函数层）。
 *
 * ## 为什么独立模块 + 显式 homeDir
 *
 * - `llm.ts::resolveFallbackProviderConfig` 读侧已定义了
 *   `~/.roy-bot/auth.json` 的形状（providers.{name}.{apiKey,baseURL}），
 *   写侧必须与它**同构**（写完读侧立刻能用）。
 * - 全部函数接受 `homeDir` 显式参数 ⇒ 测试可注入 mkdtemp 临时目录，
 *   **绝不触碰真实 ~/.roy-bot**（生产密钥）。
 *
 * ## 契约
 *
 * - auth.json 是**纯 JSON**（llm.ts:169 同款假设）；
 *   顶层未知字段（如 `_note`）**必须保留**（未知字段不丢）。
 * - config.jsonc 是 **JSONC**（带注释）⇒ 写回必须走
 *   jsonc-parser `modify`+`applyEdits`（最小 diff，注释保留）。
 * - 原子写：同目录 tmp 文件 + `rename`（同文件系统 ⇒ 原子）。
 * - 损坏容错：读 auth.json 解析失败 ⇒ 返回错误标记而非 throw
 *   （弹窗不能因为一个坏文件崩溃），**写**操作遇到损坏文件 ⇒ 报错不覆盖。
 */

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseJSONCInternal, modify as modifyJSONC, applyEdits } from "jsonc-parser";
// ★ Task #5592：必须用包名 specifier 导入（不能写 "../../../core/src/config/index"）。
//   bunup 的 `packages: "external"` 只外部化「package.json 里声明过的 bare
//   specifier」，相对路径导入必然被 inline —— 一旦 inline，core/config 链上的
//   CJS 三方依赖（jsonc-parser UMD / better-sqlite3 / bindings / yaml /
//   xdg-basedir）会整体被编进 dist/bin/roy-bot.js：
//     · jsonc-parser 的 UMD 工厂里 `require("./impl/format")` 会按 dist/bin/
//       解析 ⇒ 全新环境 `roy-bot --version` 直接 MODULE_NOT_FOUND（1.7.91 事故）
//     · bindings 的 __filename 会把构建机绝对路径烘进产物
//   core 的 package.json exports 已声明 "./config"，走包名即保持 external。
import { guardConfigWrite } from "@ai-setting/roy-bot-core/config";

/** auth.json providers 单条（与 llm.ts 读侧形状一致）。 */
export interface AuthProviderEntry {
  name: string;
  apiKey: string;
  baseURL: string;
}

/** 读 auth.json 的结果（损坏时 ok=false + error）。 */
export interface AuthReadResult {
  ok: boolean;
  error?: string;
  providers: AuthProviderEntry[];
  /** 保留的原始顶层对象（未知字段所在）；损坏时为 null。 */
  raw: Record<string, unknown> | null;
}

// ★ P7.3 F1：文件名（相对**配置目录**）—— dirFromHome
//   已把 homeDir/resolveUserConfigDir 归一到配置目录，
//   直接拼文件名（.roy-bot 拼接只在 dirFromHome 一处）。
const AUTH_FILE_NAME = "auth.json";
const CONFIG_FILE_NAME = "config.jsonc";

// ---------------------------------------------------------------------------
// ★ Task #5129 P7.3 F1 —— config 读侧路径统一
//
// 背景（#5125 DS review M1）：EnvironmentService（environment.service.ts
// `getUserConfigDir()`）读 `$XDG_CONFIG_HOME/roy-bot`，而本模块原先硬编码
// `~/.roy-bot` ⇒ XDG 场景下「boot 读」与「弹窗读写」指两个文件。
//
// 统一语义（与 environment.service.ts 一致）：
//   1. 显式 homeDir 参数（测试注入 / 已知目录）—— 永远赢；
//   2. $XDG_CONFIG_HOME/roy-bot（XDG 标准）；
//   3. ~/.roy-bot（用户家目录，默认）。
//
// 迁移兼容：**不搬迁**用户文件。boot 读侧（environment.service.ts）
// 是 XDG 路径直用（无文件即用 XDG 路径，无 home 回退）；
// 本改动让弹窗读写与 boot **指向同一文件**，不再有第二路径。
// ---------------------------------------------------------------------------

/**
 * 统一解析「用户配置目录」。
 *
 * @param homeDirOverride 显式 home 目录（测试注入）；未传走 env/home 链。
 */
export function resolveUserConfigDir(homeDirOverride?: string): string {
  if (homeDirOverride) return homeDirOverride;
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) return path.join(xdgConfigHome, "roy-bot");
  return path.join(os.homedir(), ".roy-bot");
}

/** 解析配置目录（兼容既有签名，P7.3 M1 两轮 review 收敛）。
 *
 * ★ 三种输入形态（语义唯一，杜绝双语义）：
 *   1. undefined ⇒ resolveUserConfigDir()（生产默认链：
 *      XDG 优先 → home 回退，与 boot 读侧同源）；
 *   2. 显式值 = **配置目录**（basename 是 "roy-bot" 或
 *      ".roy-bot"——覆盖 XDG 形态 roy-bot 与 home
 *      形态 .roy-bot 两种目录名）⇒ 原样使用；
 *   3. 其余显式值 = **家目录**（测试注入 mkdtemp 临时
 *      HOME）⇒ 拼 .roy-bot。
 *   （上一轮 basename 只认 roy-bot 漏了 home 回退形态
 *   .roy-bot ⇒ ~/.roy-bot/.roy-bot 幻影目录，r2
 *   review MAJOR-1 实测。）
 */
function dirFromHome(homeDir?: string): string {
  if (!homeDir) return resolveUserConfigDir();
  const base = path.basename(homeDir);
  if (base === "roy-bot" || base === ".roy-bot") return homeDir;
  return path.join(homeDir, ".roy-bot");
}


/** apikey 脱敏：尾 4 位（≤8 位全部打码）。 */
export function redactApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `••••${key.slice(-4)}`;
}

/**
 * 读 auth.json（损坏容错）。
 *
 * - 文件不存在 ⇒ ok=true, providers=[]（首例）。
 * - JSON 解析失败 / providers 非对象 ⇒ ok=false（弹窗显示错误，**不提供写入**）。
 */
export async function readAuthProviders(homeDir?: string): Promise<AuthReadResult> {
  const authPath = path.join(dirFromHome(homeDir), AUTH_FILE_NAME);
  let text: string;
  try {
    text = await fs.readFile(authPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, providers: [], raw: null };
    }
    return { ok: false, error: `read failed: ${(err as Error).message}`, providers: [], raw: null };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "auth.json is not an object", providers: [], raw: null };
    }
    const raw = parsed as Record<string, unknown>;
    const providersRaw = raw.providers;
    const providers: AuthProviderEntry[] = [];
    if (providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)) {
      for (const [name, entry] of Object.entries(providersRaw as Record<string, unknown>)) {
        if (entry === null || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        providers.push({
          name,
          apiKey: typeof e.apiKey === "string" ? e.apiKey : "",
          baseURL: typeof e.baseURL === "string" ? e.baseURL : "",
        });
      }
    }
    return { ok: true, providers, raw };
  } catch (err) {
    return { ok: false, error: `parse failed: ${(err as Error).message}`, providers: [], raw: null };
  }
}

/** 同目录原子写：tmp + rename。 */
async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, file);
  } finally {
    // rename 失败时清理 tmp（成功时 ENOENT 忽略）。
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export interface UpsertProviderInput {
  name: string;
  apiKey: string;
  baseURL: string;
}

export interface UpsertProviderResult {
  ok: boolean;
  error?: string;
  /** 写入后该 provider 是否为**新增**（区别于更新）。 */
  created: boolean;
}

/**
 * 新增/更新一个 provider（写侧持久化）。
 *
 * - 原子写；未知顶层字段保留（只动 providers.{name} 一个键）。
 * - 读到损坏文件 ⇒ ok=false（绝不覆盖用户文件）。
 * - name 非法（空 / 非标识符）⇒ ok=false。
 */
export async function upsertAuthProvider(
  homeDir: string,
  input: UpsertProviderInput,
): Promise<UpsertProviderResult> {
  const name = input.name.trim();
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, error: `invalid provider name: "${input.name}"`, created: false };
  }
  const read = await readAuthProviders(homeDir);
  if (!read.ok) {
    return { ok: false, error: `refusing to overwrite corrupt auth.json: ${read.error}`, created: false };
  }
  const raw = read.raw ?? {};
  const providers = { ...((raw.providers as Record<string, unknown>) ?? {}) };
  const created = !(name in providers);
  providers[name] = { apiKey: input.apiKey, baseURL: input.baseURL };
  const next = { ...raw, providers };
  const authPath = path.join(dirFromHome(homeDir), AUTH_FILE_NAME);
  try {
    // ★ Task #5194 MAJOR-1 修复：auth.json 写入走护栏（写前快照 + 审计）
    fsSync.mkdirSync(path.dirname(authPath), { recursive: true });
    const ok = guardConfigWrite(path.dirname(authPath), AUTH_FILE_NAME, () => {
      // 同步版原子写：tmp + rename（atomicWrite 为 async，此处等价语义）
      const tmp = path.join(
        path.dirname(authPath),
        `.${AUTH_FILE_NAME}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
      );
      try {
        fsSync.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
        fsSync.renameSync(tmp, authPath);
      } finally {
        try { fsSync.rmSync(tmp, { force: true }); } catch { /* noop */ }
      }
    });
    if (!ok) return { ok: false, error: "write failed (guard snapshot taken; see audit.log)", created };
    return { ok: true, created };
  } catch (err) {
    return { ok: false, error: `write failed: ${(err as Error).message}`, created };
  }
}

// ---------------------------------------------------------------------------
// config.jsonc —— 模型罗列 + default 写回（保注释）
// ---------------------------------------------------------------------------

/** config.jsonc 里罗列出的一个模型。 */
export interface ConfigModelEntry {
  provider: string;
  model: string;
  /** 该 provider 的 defaultModel（有则标记）。 */
  isProviderDefault?: boolean;
  /**
   * ★ Task #5138 P7.4 —— 该条目是否是**当前全局 default**
   * （`llm.defaultModel` + `llm.defaultProvider`；用户实际
   * 正在用的模型）。与 provider 级 isProviderDefault 正交：
   * 一个 config 只有 0/1 条 true。
   */
  isCurrentDefault?: boolean;
}

/**
 * ★ Task #5138 P7.4 —— 剥离**自身** provider 前缀（纯函数）。
 *
 * 背景：config 里模型名可能写成 full id（`provider/model`）。若原样
 * 交给弹窗，RunScreen 的 item.id 会变成 `${provider}/${provider}/${model}`
 * （双前缀）⇒ 选中后写回 config 时产生双前缀 id（用户 bug1 同类形态）。
 *
 * 只剥**自身**前缀（带尾 "/" 保证词边界）：别的 provider 的 full id
 * 原样保留（外来前缀不剥 ⇒ 写回时 round-trip 幂等，不会越剥越短）。
 */
export function stripOwnProviderPrefix(provider: string, name: string): string {
  const own = `${provider}/`;
  return name.startsWith(own) ? name.slice(own.length) : name;
}

/** 读 config.jsonc 的结果。 */
export interface ConfigModelsResult {
  ok: boolean;
  error?: string;
  models: ConfigModelEntry[];
}

/**
 * 罗列 config.jsonc 中配置的模型。
 *
 * 来源：`llm.providers.{name}.models[]`（有则逐条），
 * 无 models 数组但有 defaultModel ⇒ 单条 defaultModel。
 */
export async function readModelsFromConfig(homeDir?: string): Promise<ConfigModelsResult> {
  const configPath = path.join(dirFromHome(homeDir), CONFIG_FILE_NAME);
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    return { ok: false, error: `read failed: ${(err as Error).message}`, models: [] };
  }
  try {
    const errors: unknown[] = [];
    const config = parseJSONCInternal(text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as {
      llm?: {
        providers?: Record<string, unknown>;
        defaultModel?: string;
        defaultProvider?: string;
      };
    } | undefined;
    if (config === undefined || config === null || errors.length > 0) {
      return { ok: false, error: "config.jsonc is corrupt", models: [] };
    }
    // ★ Task #5138 P7.4 —— 当前全局 default（llm.defaultModel
    //   是 `${providerId}/${modelId}` 格式 → 首个 "/" 切 provider；
    //   用户现场 defaultModel 含 `/`（如 "tong/GLM-5.3-Flash"），
    //   也兼容历史裸名（defaultProvider 兜底）。
    const rawDefault = config.llm?.defaultModel;
    const cfgProvider = config.llm?.defaultProvider;
    let globalDefault: { provider: string; model: string } | undefined;
    if (typeof rawDefault === "string" && rawDefault) {
      const idx = rawDefault.indexOf("/");
      if (idx > 0) {
        globalDefault = {
          provider: rawDefault.slice(0, idx),
          model: rawDefault.slice(idx + 1),
        };
      } else if (typeof cfgProvider === "string" && cfgProvider) {
        globalDefault = { provider: cfgProvider, model: rawDefault };
      }
    }
    const models: ConfigModelEntry[] = [];
    const providers = config.llm?.providers ?? {};
    for (const [provider, entry] of Object.entries(providers)) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as { models?: unknown; defaultModel?: unknown };
      const list = Array.isArray(e.models) ? e.models : [];
      if (list.length > 0) {
        // ★ Task #5138 P7.4（DS r3 MINOR-1/2）—— 归一化后去重：
        //   models 里同时出现 "X" 与 "prov/X" 时归一成同一 model，
        //   不去重会出现两条同 id 的弹窗行（重复行 + 双 badge）。
        const seen = new Set<string>();
        for (const m of list) {
          if (typeof m === "string" && m) {
            // models[] 分支与 fallback 分支同源：models 里写 full id 时，
            // 不剥离会让弹窗 item.id 变双前缀 ⇒ 与 fallback 分支同源的缺陷。
            const bareModel = stripOwnProviderPrefix(provider, m);
            const key = `${provider}/${bareModel}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // isProviderDefault 与 model 字段**同源**（都用归一化值比较）：
            // provider 的 defaultModel 写 full id、models[] 写裸名时，
            // 原值比较会丢 provider default badge（假阴性）。
            const providerDefaultBare =
              typeof e.defaultModel === "string"
                ? stripOwnProviderPrefix(provider, e.defaultModel)
                : undefined;
            models.push({
              provider,
              model: bareModel,
              isProviderDefault: providerDefaultBare === bareModel,
              isCurrentDefault:
                globalDefault !== undefined &&
                globalDefault.provider === provider &&
                globalDefault.model === bareModel,
            });
          }
        }
      } else if (typeof e.defaultModel === "string" && e.defaultModel) {
        // ★ Task #5138 P7.4（DS review r2 M1）—— fallback 分支
        //   （provider 无 models[]，只有 defaultModel）若 defaultModel
        //   是 **full id**（"minimax/MiniMax-M3.1-Flash"），原样落库会
        //   让 RunScreen 的 item.id 变成 "minimax/minimax/..."（双前缀）
        //   → 写回 config 时产生双前缀 id（用户 bug1 同类形态）。
        const bareModel = stripOwnProviderPrefix(provider, e.defaultModel);
        models.push({
          provider,
          model: bareModel,
          isProviderDefault: true,
          isCurrentDefault:
            globalDefault !== undefined &&
            globalDefault.provider === provider &&
            globalDefault.model === bareModel,
        });
      }
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: `parse failed: ${(err as Error).message}`, models: [] };
  }
}

export interface SetDefaultModelResult {
  ok: boolean;
  error?: string;
}

/**
 * 把 defaultModel/defaultProvider 写回 config.jsonc（**保注释**）。
 *
 * 实现：jsonc-parser `modify` + `applyEdits` 最小 diff —— 只替换
 * `llm.defaultModel` / `llm.defaultProvider` 两个值，其余字节不动
 * （实测尾注释/独立注释全部保留）。
 * 写回后**回读校验**：parseJSONC 后字段值必须等于写入值（否则报错不落盘）。
 */
export async function setDefaultModel(
  homeDir: string,
  provider: string,
  model: string,
): Promise<SetDefaultModelResult> {
  const configPath = path.join(dirFromHome(homeDir), CONFIG_FILE_NAME);
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    return { ok: false, error: `read failed: ${(err as Error).message}` };
  }
  const errors2: unknown[] = [];
  const probe = parseJSONCInternal(text, errors2, { allowTrailingComma: true, disallowComments: false });
  if (errors2.length > 0 || probe === undefined || typeof probe !== "object" || Array.isArray(probe)) {
    return { ok: false, error: "config.jsonc is corrupt (refusing to write)" };
  }
  const formatting = { tabSize: 2, insertSpaces: true } as const;
  let next = text;
  // ★ Task #5129 P7.3 F2 —— 必须写**完整 id** `${provider}/${model}`：
  //   boot 读侧（llm.resolveRequest）按首个 "/" 切 provider。
  //   裸 model（P7.1 原实现）对单段名无歧义，但多段模型名
  //   （OpenRouter 风格 org/model）重启后会被误切
  //   （providerId=org → API key not found，取证实测复现）。
  //   完整 id 与 boot config 的 defaultModel 格式一致。
  for (const [p, v] of [
    ["llm.defaultModel", `${provider}/${model}`],
    ["llm.defaultProvider", provider],
  ] as const) {
    const segments = p.split(".");
    const edits = modifyJSONC(next, segments, v, { formattingOptions: formatting });
    next = applyEdits(next, edits);
  }
  // 回读校验（防 formatting/modify 静默产出坏文件）。
  const errors: unknown[] = [];
  const check = parseJSONCInternal(next, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { llm?: { defaultModel?: string; defaultProvider?: string } }
    | undefined;
  if (errors.length > 0 || !check?.llm) {
    return { ok: false, error: "post-write validation failed (would corrupt config)" };
  }
  if (
    check.llm.defaultModel !== `${provider}/${model}` ||
    check.llm.defaultProvider !== provider
  ) {
    return { ok: false, error: `post-write mismatch: got ${check.llm.defaultModel}/${check.llm.defaultProvider}` };
  }
  try {
    // ★ Task #5194 MAJOR-1 修复：config.jsonc 写入走护栏（写前快照 + 审计）
    const ok = guardConfigWrite(path.dirname(configPath), CONFIG_FILE_NAME, () => {
      const tmp = path.join(
        path.dirname(configPath),
        `.${CONFIG_FILE_NAME}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
      );
      try {
        fsSync.writeFileSync(tmp, next, "utf-8");
        fsSync.renameSync(tmp, configPath);
      } finally {
        try { fsSync.rmSync(tmp, { force: true }); } catch { /* noop */ }
      }
    });
    if (!ok) return { ok: false, error: "write failed (guard snapshot taken; see audit.log)" };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `write failed: ${(err as Error).message}` };
  }
}
