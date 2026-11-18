/**
 * @fileoverview 真实 session 回放 + **压缩后 resume 验证** harness (Task #4933 C 方案)
 *
 * 用户点名的两条硬验收：
 *   3.1 压缩后 session resume：「压缩后还可以继续基于压缩内容进行对话」
 *   3.2 压缩效果与时长
 *
 * 本 harness 做的事：
 *   Phase A — 回放 & 压缩
 *     1. 从生产 sessions.db（**只读**）读某个真实 session 的未归档消息
 *     2. 灌进完全隔离的临时 sqlite db（临时目录，不碰生产库）
 *     3. 用**真实** minimax/MiniMax-M3.1-Flash 跑两阶段压缩
 *        （compact-hint → hint 注入 → compact → 整段自然语言 checkpoint）
 *     4. 测耗时 / 输入规模 / checkpoint 正文长度
 *
 *   Phase B — resume 验证（核心）
 *     5. 断言压缩后新的 LLM 上下文**只含 checkpoint 消息 + 之后的消息**
 *        （旧消息全部归档，不泄漏）
 *     6. 从 checkpoint 正文里提取一个「事实探针」（只有在读 checkpoint 才可能知道
 *        的具体细节：文件名 / 命令 / 报错 / 参数）
 *     7. 用一个**全新 agent 会话**（干净的 conversation，只有 checkpoint 消息作为历史）
 *        问一个只有读 checkpoint 才能答对的问题
 *     8. 校验 assistant 回答是否命中了探针事实 → 证明 resume 真的基于压缩内容
 *
 *   Phase C — 旧格式 checkpoint resume
 *     9. 构造一个旧格式（五栏位）checkpoint → 读时适配 → resume 对话正常
 *
 * ⚠️ 纪律：
 *   - 生产库只用 readonly 打开，绝不写
 *   - 临时 db 在 os.tmpdir()，跑完自动删除
 *   - 真实调用 LLM（消耗额度）
 */

import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// 运行时选择（Bun: bun:sqlite / Node 22.5+: node:sqlite / 旧 Node: better-sqlite3）
// ——与 storage/sqlite.ts 同源策略（Task #5592 CV 返工：补 node:sqlite 分支）
function getDatabaseClass(): new (path: string, opts?: any) => any {
  // @ts-ignore - Bun global
  if (typeof Bun !== "undefined") {
    return (require("bun:sqlite") as any).Database;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite");
    if (typeof DatabaseSync === "function") {
      return DatabaseSync as any;
    }
  } catch {
    // node < 22.5 没有 node:sqlite —— 落到 better-sqlite3。
  }
  return require("better-sqlite3");
}

import { SessionComponent } from "../session-component";
import type { ConfigComponent } from "../../../config/config-component";
import type { Environment } from "../../interface";
import type { SessionCheckpoint } from "../types";

// ============================================================================
// 生产库读取（只读）
// ============================================================================

interface RawMessage {
  role: string;
  content: string;
  parts: string | null;
  metadata: string | null;
  is_archived: number;
  timestamp: number;
}

export function getProdDbPath(): string {
  const home = process.env.HOME || "/tmp";
  return path.join(home, ".local", "share", "roy-bot", "sessions.db");
}

/**
 * 从生产库读取某 session 的**未归档**消息（只读连接）。
 */
export function readSessionMessages(
  sessionId: string,
  limit?: number
): { messages: RawMessage[]; total: number } {
  const dbPath = getProdDbPath();
  if (!fsSync.existsSync(dbPath)) {
    throw new Error(`Production sessions.db not found: ${dbPath}`);
  }
  const Database = getDatabaseClass();
  const db = new Database(dbPath, { readonly: true });
  try {
    const total = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM message WHERE session_id = ? AND is_archived = 0"
        )
        .get(sessionId) as { c: number }
    ).c;

    const rows = db
      .prepare(
        `SELECT role, content, parts, metadata, is_archived, timestamp
         FROM message
         WHERE session_id = ? AND is_archived = 0
         ORDER BY timestamp ASC, rowid ASC`
      )
      .all(sessionId) as RawMessage[];

    // ★ 边界对齐：不能从 tool-call / tool-result 中间切 —— 否则首条可能是
    //   tool-result 而对应的 tool-call 已被切掉，AI SDK / 网关会报
    //   `tool result's tool id(...) not found` (400)。
    //   往前找最近的一条 user 消息作为切点。
    let sliced = rows;
    if (limit && limit < rows.length) {
      let start = rows.length - limit;
      while (start > 0 && rows[start].role !== "user") start--;
      sliced = rows.slice(start);
    }
    return { messages: sliced, total };
  } finally {
    db.close();
  }
}

// ============================================================================
// 隔离环境
// ============================================================================

function createIsolatedEnv(
  agentComponent: any,
  configComponent: ConfigComponent
): Environment {
  return {
    name: "bench-env",
    version: "1.0.0",
    getComponent: (name: string) => {
      if (name === "agent") return agentComponent;
      if (name === "config") return configComponent;
      return undefined;
    },
    hasComponent: (name: string) => name === "agent" || name === "config",
    logger: () => {},
    trace: () => {},
  } as unknown as Environment;
}

// ============================================================================
// 事实探针抽取 + 命中判定
// ============================================================================

/**
 * 从 checkpoint 正文里抽「事实探针」—— 只有在读到 checkpoint 内容时才可能知道的
 * 具体细节（路径 / 命令 / 报错码 / 版本号 / 长标识符）。
 *
 * 策略：抓形如以下的高辨识度 token：
 *   - 文件路径 `/a/b/c.ts`
 *   - 命令 `bun test` / `git commit`
 *   - 版本 `v1.2.3` / `1.7.71`
 *   - 长标识符 `session_xxx` / `Minimax-M3.1-Flash` / 反引号内容
 *   - 数字+单位 `4731 条` / `P50=118s`
 */
export function extractFactProbes(content: string, max = 12): string[] {
  const probes: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length < 4 || t.length > 80) return;
    if (!probes.includes(t)) probes.push(t);
  };

  // 1. 反引号内联代码
  for (const m of content.matchAll(/`([^`\n]{4,80})`/g)) push(m[1]);
  // 2. 文件路径
  for (const m of content.matchAll(/(?:\/|\.\/)?[\w.-]+(?:\/[\w.-]+){1,6}\.(?:ts|tsx|js|json|jsonc|md|py|yaml|yml|sql|db)/g)) push(m[0]);
  // 3. 版本号 / 模型 id
  for (const m of content.matchAll(/\b(?:v?\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g)) push(m[0]);
  // 4. 长标识符（下划线 / 连字符结构）
  for (const m of content.matchAll(/\b[a-zA-Z][\w-]*(?:_[\w-]+){1,4}\b/g)) push(m[0]);
  // 5. 错误码 / 数字断言
  for (const m of content.matchAll(/\b\d{3,6}\b/g)) push(m[0]);

  return probes.slice(0, max);
}

/**
 * 判定回答是否命中了探针（关键词命中率）。
 *
 * 归一化：小写 + 去空白，避免中英文混排 / 空格差异造成假阴性。
 */
export function scoreAnswerHit(
  answer: string,
  probes: string[]
): { hits: string[]; hitRate: number } {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const a = norm(answer);
  const hits = probes.filter((p) => a.includes(norm(p)));
  return {
    hits,
    hitRate: probes.length ? Number((hits.length / probes.length).toFixed(3)) : 0,
  };
}

// ============================================================================
// 结果类型
// ============================================================================

export interface ResumeProbeResult {
  /** 用于追问的问题 */
  question: string;
  /** 从 checkpoint 抽出的事实探针 */
  probes: string[];
  /** assistant 的回答 */
  answer: string;
  /** 命中的探针 */
  hits: string[];
  /** 命中率 */
  hitRate: number;
  /** 回答长度 */
  answerLength: number;
  /** 本次追问耗时 */
  resumeMs: number;
  /** resume 时 LLM 看到的历史消息数（应为 checkpoint + 之后的消息） */
  contextMessageCount: number;
  /** resume 时历史里是否含归档前的老消息（泄漏检测） */
  leakedArchivedContent: boolean;
}

export interface ReplayResult {
  sessionId: string;
  totalMessagesInSession: number;
  replayedMessages: number;
  inputChars: number;
  compactModel: string;

  phase1Ms: number;
  phase2Ms: number;
  totalMs: number;

  hint: string;
  hintLength: number;
  hintInjected: boolean;
  hintOverlapTokens: number;

  checkpoint: {
    title: string;
    contentLength: number;
    contentPreview: string;
    /** C 方案：正文是否含伪造的五小节标题（应为 false） */
    hasForgedSectionHeaders: boolean;
  };
  checkpointMessagePreview: string;

  /** ★ resume 验证结果 */
  resume: ResumeProbeResult | null;

  errors: string[];
}

// ============================================================================
// 主流程
// ============================================================================

export async function replay(args: {
  sessionId: string;
  limit?: number;
  bootstrapAgentComponent: (configComponent: ConfigComponent) => Promise<any>;
  /** 跳过 resume 验证（只测压缩） */
  skipResume?: boolean;
  /** 自定义追问问题（默认自动生成） */
  resumeQuestion?: string;
  /**
   * 旧格式 checkpoint 模式：不跑真实压缩，而是注入一个旧格式 checkpoint
   * 来验证读时适配 + resume。
   */
  legacyCheckpoint?: {
    title: string;
    processKeyPoints: string[];
    currentState: string;
    nextSteps: string[];
    userIntents: string[];
    summary?: string;
  };
}): Promise<ReplayResult> {
  const { sessionId, limit, bootstrapAgentComponent, skipResume, resumeQuestion } = args;
  const result: ReplayResult = {
    sessionId,
    totalMessagesInSession: 0,
    replayedMessages: 0,
    inputChars: 0,
    compactModel: "",
    phase1Ms: 0,
    phase2Ms: 0,
    totalMs: 0,
    hint: "",
    hintLength: 0,
    hintInjected: false,
    hintOverlapTokens: 0,
    checkpoint: {
      title: "",
      contentLength: 0,
      contentPreview: "",
      hasForgedSectionHeaders: false,
    },
    checkpointMessagePreview: "",
    resume: null,
    errors: [],
  };

  // 1. 读生产库（只读）
  const { messages, total } = readSessionMessages(sessionId, limit);
  result.totalMessagesInSession = total;
  result.replayedMessages = messages.length;
  result.inputChars = messages.reduce(
    (n, m) => n + (m.content?.length ?? 0) + (m.parts?.length ?? 0),
    0
  );
  if (messages.length < 3) {
    throw new Error(`session ${sessionId} has only ${messages.length} active messages`);
  }

  // 2. 隔离临时 db
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "roy-replay-c-"));
  const tempDbPath = path.join(tempDir, "sessions.db");

  // 3. ConfigComponent（读用户真实配置，compactModel 生效）
  const { ConfigComponent } = require("../../../config/config-component");
  const configComponent = new ConfigComponent();
  const configDir = path.join(process.env.HOME || "/tmp", ".roy-bot");
  configComponent.setXdgDataHome(configDir);
  configComponent.registerSource({
    type: "file",
    relativePath: path.join(configDir, "config.jsonc"),
    optional: true,
    watch: false,
  });

  // 4. AgentComponent（真实 LLM 路径）
  const agentComponent = await bootstrapAgentComponent(configComponent);

  // 5. SessionComponent（隔离 db）
  const benchEnv = createIsolatedEnv(agentComponent, configComponent) as any;
  const component = new SessionComponent();
  await component.init({
    name: "session",
    version: "1.0.0",
    enabled: true,
    env: benchEnv,
    options: {
      configComponent,
      config: { storage: { type: "sqlite", dbPath: tempDbPath } } as any,
    },
  } as any);
  const agentEnv = (agentComponent as any).env;
  agentEnv?.registerComponent?.(component);

  try {
    result.compactModel =
      (configComponent.get("session.compactModel") as string) ?? "(default chain)";

    // 6. 建隔离 session + 灌真实消息
    const session = await component.create({
      title: `replay ${sessionId.slice(0, 24)}`,
    });
    const store = (component as any).store;
    for (const m of messages) {
      let parts: unknown[] = [];
      if (m.parts) {
        try { parts = JSON.parse(m.parts); } catch { parts = []; }
      }
      let metadata: Record<string, unknown> | undefined;
      if (m.metadata) {
        try { metadata = JSON.parse(m.metadata); } catch { metadata = undefined; }
      }
      await store.addMessage(session.id, {
        role: m.role,
        content: m.content ?? "",
        parts,
        metadata,
      });
    }

    // ========================================================================
    // Phase A — 压缩
    // ========================================================================
    if (args.legacyCheckpoint) {
      // 旧格式 checkpoint 模式：直接写一个旧格式 checkpoint + 归档全部消息
      const legacy = args.legacyCheckpoint;
      const cpId = `cp_legacy_${Date.now()}`;
      await store.saveCheckpoint(session.id, {
        id: cpId,
        messageIndex: 0,
        title: legacy.title,
        summary: legacy.summary ?? "",
        processKeyPoints: legacy.processKeyPoints,
        currentState: legacy.currentState,
        nextSteps: legacy.nextSteps,
        userIntents: legacy.userIntents,
        messageCountBefore: messages.length,
        createdAt: Date.now(),
        type: "compact",
      } as unknown as SessionCheckpoint);
      // 用适配后的内容建 checkpoint 消息（模拟生产 createCheckpointMessage 路径）
      const adapted = (await component.getCheckpoint(session.id, cpId))!;
      const { createCheckpointContent } = require("../compact-checkpoint-content");
      await store.addMessage(session.id, {
        role: "user",
        content: createCheckpointContent(adapted),
        metadata: {
          isCheckpoint: true,
          checkpointId: cpId,
          checkpointMeta: {
            id: cpId,
            messageIndex: 0,
            title: legacy.title,
            summary: legacy.summary ?? "",
            processKeyPoints: legacy.processKeyPoints,
            currentState: legacy.currentState,
            nextSteps: legacy.nextSteps,
            userIntents: legacy.userIntents,
            messageCountBefore: messages.length,
            createdAt: Date.now(),
            type: "compact",
          },
        },
      });
      await store.archiveMessages(session.id, cpId, messages.length);

      result.checkpoint = {
        title: adapted.title,
        contentLength: adapted.content.length,
        contentPreview: adapted.content.slice(0, 600),
        hasForgedSectionHeaders: false,
      };
      const ctx0 = await component.getContext(session.id, { fullHistory: false });
      const cpMsg0 = ctx0.messages.find((m: any) => m.metadata?.isCheckpoint);
      result.checkpointMessagePreview = (cpMsg0?.content ?? "").slice(0, 2000);
      result.phase1Ms = 0;
      result.phase2Ms = 0;
      result.totalMs = 0;
      result.compactModel = "(legacy checkpoint, no LLM compaction)";
    } else {
      // Phase 1：hint
      const t1 = Date.now();
      try {
        result.hint = await component.generateCompactHint(session.id);
      } catch (e) {
        result.errors.push(`phase1: ${e instanceof Error ? e.message : String(e)}`);
      }
      result.phase1Ms = Date.now() - t1;
      result.hintLength = result.hint.length;

      // Phase 2：compact（hint 注入）
      const t2 = Date.now();
      let compactResult;
      try {
        compactResult = await component.compact(session.id, {
          // ★ Task #4933（C 方案）：CompactOptions 只剩 scenarioHint
          scenarioHint: result.hint,
        });
      } catch (e) {
        result.errors.push(`phase2: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      result.phase2Ms = Date.now() - t2;
      result.totalMs = result.phase1Ms + result.phase2Ms;

      const cp = compactResult.checkpoint;
      const forged = /^\s*##\s+(Summary|Process Key Points|Current State|Next Steps|User Intents)\s*$/m
        .test(cp.content);
      result.checkpoint = {
        title: cp.title,
        contentLength: cp.content.length,
        contentPreview: cp.content.slice(0, 600),
        hasForgedSectionHeaders: forged,
      };

      // hint 影响判定（词面交集）
      if (result.hint.length > 0) {
        const hintTokens = result.hint
          .split(/[\s,，。.;；、:：!！?？()（）\[\]【】"']+/)
          .filter((t) => t.length >= 2);
        const overlap = hintTokens.filter((t) => cp.content.includes(t));
        result.hintInjected = overlap.length > 0;
        result.hintOverlapTokens = overlap.length;
      }

      const ctx = await component.getContext(session.id, { fullHistory: false });
      const cpMsg = ctx.messages.find((m: any) => m.metadata?.isCheckpoint);
      result.checkpointMessagePreview = (cpMsg?.content ?? "").slice(0, 2000);
    }

    // ========================================================================
    // Phase B — resume 验证（核心）
    // ========================================================================
    if (!skipResume) {
      const resumeT0 = Date.now();

      // B1. 取压缩后的上下文（agent 实际会看到的）
      const ctxAfter = await component.getContext(session.id, {
        fullHistory: false,
        minUserMessages: 100,
      });
      result.resume = {
        question: "",
        probes: [],
        answer: "",
        hits: [],
        hitRate: 0,
        answerLength: 0,
        resumeMs: 0,
        contextMessageCount: ctxAfter.messages.length,
        leakedArchivedContent: false,
      };

      // B2. 泄漏检测：归档前的老消息内容不应出现在压缩后上下文里
      const activeContent = ctxAfter.messages.map((m: any) => m.content).join("\n");
      // 取第一条原始消息的前 40 字符作为「老内容指纹」
      const fingerprint = (messages[0]?.content ?? "").slice(0, 40).trim();
      if (fingerprint.length >= 10) {
        result.resume.leakedArchivedContent = activeContent.includes(fingerprint);
      }

      // B3. 从 checkpoint 正文抽事实探针
      const cpContent =
        (ctxAfter.messages.find((m: any) => m.metadata?.isCheckpoint) as any)?.content ?? "";
      result.resume.probes = extractFactProbes(cpContent, 12);

      // B4. 构造追问（只有读 checkpoint 才答得出）
      const question =
        resumeQuestion ??
        "基于你之前这段会话的 checkpoint（在上下文里），回答两个问题，尽量具体、给原文细节：\n" +
        "1) 之前的工作进行到哪一步了？\n" +
        "2) 卡住的地方 / 接下来要做的下一步分别是什么？\n" +
        "要求：只引用 checkpoint 里确实出现过的具体信息（文件名、命令、报错、参数、数字），" +
        "不要泛泛而谈，也不要编造 checkpoint 里没有的内容。";
      result.resume.question = question;

      // B5. 用**真实 agent** 在压缩后的上下文里继续对话（真正的 resume）
      //
      // ★ Task #4933 收尾修正：这里**必须**走 agentComponent.run()，不能直接
      //   llm.invoke()。原因（上一轮实测踩到）：
      //     - 直连 `llm.invoke({providerId:"minimax", model:"MiniMax-M3.1-Flash"})`
      //       返回 **404 Page not found**（该 provider 的直连路径不通）；
      //     - 真正的压缩调用走 agent-component，它内部有 fallback 链
      //       （minimax → opencodego/deepseek-v4.1-flash）所以能成功；
      //     - 直连 invoke 绕过了这条 fallback 链，导致 resume 答案恒为空，
      //       验证结论是**假阴性**（看起来"resume 失败"其实是 harness 的缺陷）。
      //   走 agentComponent.run() 既能正确降级，也更贴近真实场景：
      //   用户 resume 会话时就是 agent 带着压缩后的 history 继续跑。
      try {
        const runRes = await (agentComponent as any).run("roy", question, {
          sessionId: session.id,
          persistSession: false,
          // 不指定 model → 走默认链 + fallback（与生产一致）
        });
        const answer = (runRes?.finalText ?? "").toString();
        result.resume.answer = answer;
        result.resume.answerLength = answer.length;
        if (!answer) {
          result.errors.push(
            `resume: empty finalText (iterations=${runRes?.iterations}, ` +
            `stopReason=${runRes?.stopReason ?? "n/a"})`
          );
        }
        const scored = scoreAnswerHit(answer, result.resume.probes);
        result.resume.hits = scored.hits;
        result.resume.hitRate = scored.hitRate;
      } catch (resumeErr) {
        result.errors.push(
          `resume: agent run failed: ${
            resumeErr instanceof Error ? resumeErr.message.slice(0, 300) : String(resumeErr)
          }`
        );
      }

      result.resume.resumeMs = Date.now() - resumeT0;
    }

    return result;
  } finally {
    try { await component.stop(); } catch {}
    try { fsSync.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
