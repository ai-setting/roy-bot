/**
 * @fileoverview Task #4467 — task:before.create 的 decision 检测插件
 *
 * 契约：/tmp/task-create-verdict-contract-v2.md
 *
 * 形态：**只提示，不拦截**。
 *   创建照常发生，插件只把建议文本写进 `ctx.options.context.decision_hint`，
 *   由调用方 agent 自己决定是否调 `task_update` 修正。
 *
 * 门槛（契约 §4.1）：
 *   候选 0 个 → 放行，不调模型
 *   候选 1 个 → 不调模型，直接给「建议复用 #id」hint
 *   候选 ≥2 个 → 调 decision model 做 Stage A 判定
 *
 * Stage A 判「新建 vs 复用」；Stage B（仅当新建）判「新建 root vs 挂到某 root」。
 * status → 动作（reopen / enhance）是**纯规则**推导，不需要模型。
 */

import {
  parseSimilarTaskIds,
  deriveActionFromStatus,
  deriveReopenStatus,
  buildHintText,
  writeDecisionHint,
  renderCandidateKey,
  renderCandidateValue,
  formatRelativeAge,
  type HintInput,
} from "../hooks/verdict";
import type { DecisionPort, DecisionRequest, DecisionResponse, DecisionAnswer } from "./decision-port";
import { systemoneRenderer } from "./decision-renderers";
import type { TaskCreateContext } from "../hooks/contexts";
import type { Task } from "../types";
import { createLogger } from "../../log-trace/logger";
// Task #4494 — 核心逻辑 trace 插桩
import { TracedAs } from "../../log-trace/decorator";

const logger = createLogger("plugin:decision-hint");

/**
 * 归一化 hook 上下文：接受裸 `TaskCreateContext` 或框架 `HookContext`（载荷在 `.data`）。
 * 交叉验证 P1 —— 见 `execute()` 注释。
 */
function normalizeHookCtx(
  ctx: TaskCreateContext | { data: TaskCreateContext },
): TaskCreateContext {
  const maybe = ctx as { data?: TaskCreateContext } & Partial<TaskCreateContext>;
  return maybe && typeof maybe === "object" && maybe.data ? maybe.data : (ctx as TaskCreateContext);
}

// ========================================================================
// 参数（数值依据见契约 §9 参数总表）
// ========================================================================

/** Stage A 候选上限（P1） */
const MAX_STAGE_A_CANDIDATES = 20;
/** Stage B root 候选：longterm 全量（P2） */
const MAX_LONGTERM_ROOTS = 6;
/** Stage B root 候选：关键词匹配 top-N（P3） */
const MAX_KEYWORD_ROOTS = 10;
/** 兜底检索 top-N（P6） */
const FALLBACK_TOP_N = 5;
/** 复用采纳阈值（P10） */
const REUSE_ADOPT_THRESHOLD = 0.6;
/** 软提示下限（P11） */
const SOFT_HINT_THRESHOLD = 0.4;
/** root 祖先链深度上限（P18） */
const MAX_ROOT_ANCESTOR_DEPTH = 20;

// ========================================================================
// Types
// ========================================================================

/** 只读能力面 —— 避免与 TaskComponent 产生类型循环依赖（契约 §3.3） */
export interface TaskComponentReadonly {
  getTask(id: number): Promise<Task | undefined>;
  listTasks(options?: any): Promise<{ tasks: Task[]; total: number }>;
  searchTasksByKeywords(
    keywords: string[],
    options?: any,
  ): Promise<{ tasks: Task[]; total: number }>;
  getChildTasks(taskId: number, options?: any): Promise<{ tasks: Task[]; total: number }>;
}

export interface DecisionHintPluginOptions {
  /** 注入的决策端口（测试用假 port；生产用 SystemOneDecisionPort） */
  decisionPort: DecisionPort;
  /** 上下文读取（生产用 getEnvContextOrEmpty().parentTaskId） */
  envParentTaskIdProvider?: () => number | undefined | null;
  /**
   * 渲染策略 —— 决定 state / criteria / choice 映射的形态。
   *
   * ⚠️ Task #4620：**不同载体的训练格式不同，必须显式选**。
   *   - `systemone`（默认）：阿里百炼 systemone 的习惯 —— state 是 JSON 对象，
   *     criteria key = `#<id> [<type>] <title>`（#4107 模板）
   *   - `laya`：#4614 的 Laya 微调模型训练时的格式 —— state 是中文文本
   *     （【新任务标题】/【新任务描述】/【候选任务】），criteria key = `#<id> <title[:50]>`
   *
   * 实测（200 条 held-out，laya-train/scripts/format_probe.py）：
   *   laya 格式 79.00% vs systemone 格式 46.50% → **用 laya 载体必须选 laya 渲染**。
   */
  renderer?: DecisionRenderer;
  /**
   * 「建议复用」硬提示的置信度门禁（默认 0.6 = #4467 Q4 的 routing 档）。
   *
   * ⚠️ Task #4620：Laya 载体用 **0.85**（#4467 Q4 的「不新建」破坏性档）。
   *   896 条实测：thr=0.85 → 提示精确率 80.5%（coverage 28.7%），
   *   thr=0.9 → 84.9%，thr=0.95 → 87.0%。
   */
  reuseThreshold?: number;
  /**
   * 低于此置信度**完全不出提示**（默认 0.4）。
   *
   * ⚠️ Task #4620：Laya 载体把它设成与 `reuseThreshold` 同值（0.85），
   *   语义就是「< 0.85 一律不出提示」（任务书的硬要求）。
   */
  softHintThreshold?: number;
  /**
   * 「只有 1 个候选 → 不调模型，直接给建议复用 hint」的捷径。
   *
   * 默认 true（#4467 契约 §4.1）。Laya 载体设成 false —— 快捷路径**没有置信度**，
   * 与「必须 confidence 门禁 ≥ 0.85」冲突，所以让它也走模型。
   */
  singleCandidateShortcut?: boolean;
}

/**
 * 渲染策略接口 —— 把「候选 → state/questions」和「choice → task id」两件事
 * 抽象出来，让同一套判定逻辑能服务不同载体的训练分布。
 */
export interface DecisionRenderer {
  /** 渲染 Stage A 的请求 */
  buildStageA(input: {
    title: string;
    description: string;
    goals: string;
    tags: string[];
    projectPath: string;
    candidates: Task[];
    now: number;
  }): DecisionRequest;
  /** 把模型回的 choice 映射回候选 task id（映射不到返回 undefined） */
  matchChoice(choice: string, candidates: Task[]): number | undefined;
}

// ========================================================================
// Plugin
// ========================================================================

export class DecisionHintPlugin {
  readonly name = "decision-hint";
  readonly version = "1.0.0";
  readonly description =
    "Task #4467 — task:before.create 的 decision 检测：判定新建/复用 + root/子挂载，只提示不拦截";

  private readonly decisionPort: DecisionPort;
  private readonly envParentTaskIdProvider: () => number | undefined | null;
  private readonly renderer: DecisionRenderer;
  private readonly reuseThreshold: number;
  private readonly softHintThreshold: number;
  private readonly singleCandidateShortcut: boolean;

  constructor(options: DecisionHintPluginOptions) {
    this.decisionPort = options.decisionPort;
    this.envParentTaskIdProvider = options.envParentTaskIdProvider ?? (() => undefined);
    this.renderer = options.renderer ?? systemoneRenderer;
    this.reuseThreshold = options.reuseThreshold ?? REUSE_ADOPT_THRESHOLD;
    this.softHintThreshold = options.softHintThreshold ?? SOFT_HINT_THRESHOLD;
    this.singleCandidateShortcut = options.singleCandidateShortcut ?? true;
  }

  /**
   * hook 入口 —— 任何异常都不得抛出（契约 §8 总原则）。
   *
   * ⚠️ 形状兼容（交叉验证 P1）：框架 `HookManager` 派发的是 `HookContext`
   * （载荷在 `ctx.data`，见 `hook/hook-manager.ts` createContext），而本插件
   * 内部按裸 `TaskCreateContext` 工作。这里两种形状都接受，避免按标准
   * `registerHook({ execute: (ctx) => plugin.execute(ctx) })` 接入时静默失效。
   */
  @TracedAs("task.decision.hint.onBeforeCreate", {
    recordParams: true,
    recordResult: true,
    log: false,
    // 只记判定必要的字段摘要 —— title/goals 可能是长文本，description 可能上万字
    paramFilter: (args) => {
      const raw = (args[0] ?? {}) as any;
      const ctx = raw?.data ?? raw;
      const opts = ctx?.options ?? {};
      const decisionHint = typeof opts.context === "string" ? opts.context : "";
      return {
        hasTaskComponent: Boolean(ctx?.taskComponent),
        titleLen: typeof opts.title === "string" ? opts.title.length : 0,
        title: typeof opts.title === "string" ? opts.title.slice(0, 120) : null,
        tagsCount: Array.isArray(opts.tags) ? opts.tags.length : 0,
        hasParentTaskId: opts.parent_task_id != null,
        contextLen: decisionHint.length,
        // 解析出的候选 id 数量 —— 这是"门槛逻辑是否走到模型"的直接证据
        similarTaskIdsCount: /similar_task_ids/.test(decisionHint) ? "present" : "absent",
        hookCtxShape: raw?.data ? "HookContext" : "bare",
      };
    },
    resultFilter: (_res: void) => ({ ok: true }),
  })
  async execute(ctx: TaskCreateContext | { data: TaskCreateContext }): Promise<void> {
    try {
      await this.run(normalizeHookCtx(ctx));
    } catch (err) {
      logger.warn(`[decision-hint] degraded to pass-through: ${(err as Error)?.message}`);
    }
  }

  private async run(ctx: TaskCreateContext): Promise<void> {
    const taskComponent = (ctx as any).taskComponent as TaskComponentReadonly | undefined;
    if (!taskComponent) {
      logger.warn("[decision-hint] taskComponent not injected — skip");
      return;
    }

    // ① 解析 similar_task_ids
    const explicitIds = parseSimilarTaskIds(ctx.options.context);

    // ② 空 → 兜底检索（tags 精确子串匹配 title+tags，top-5）
    let candidates: Task[] = [];
    if (explicitIds.length > 0) {
      for (const id of explicitIds) {
        const t = await taskComponent.getTask(id);
        if (t) candidates.push(t);
      }
    } else {
      candidates = await this.fallbackCandidates(taskComponent, ctx.options.tags);
    }

    // ③ 门槛
    if (candidates.length === 0) {
      logger.debug("[decision-hint] 0 candidates — pass through");
      return;
    }

    if (candidates.length === 1 && this.singleCandidateShortcut) {
      // 1 个候选 → 不调模型，直接给「建议复用 #id」hint
      // ⚠️ Task #4620：这条捷径**没有置信度**，与「必须门禁 ≥0.85」冲突 →
      //   Laya 载体把 singleCandidateShortcut 设成 false，让它也走模型。
      const hint = buildHintText(this.reuseHintInput(candidates[0], 1));
      writeDecisionHint(ctx.options, hint);
      return;
    }

    const trimmed = candidates.slice(0, MAX_STAGE_A_CANDIDATES);

    // ④ Stage A
    const stageA = await this.runStageA(ctx, trimmed);
    if (!stageA) return;

    if (stageA.kind === "reuse") {
      const target = trimmed.find((t) => t.id === stageA.targetTaskId);
      if (!target) return;
      const hint = buildHintText(this.reuseHintInput(target, stageA.confidence));
      writeDecisionHint(ctx.options, hint);
      return;
    }

    // ⚠️ Task #4627 — 修复「静默档漏进 Stage B」。
    //
    //   runStageA 的注释写的是「静默档：不产生任何 hint，**也不进入 Stage B**」
    //   （契约 §4.4），但原实现**没有**这个分支 → `kind === "silent"` 会
    //   直接落到下面的 Stage B → **第二次调用模型**（浪费一次 HTTP），
    //   而且 Stage B 可能独立判出一个「建议挂到某个 root」的 hint，
    //   违反「置信度不足 → 静默无 hint」的硬要求（任务书 C4）。
    //
    //   实测（RED）：x_jev_confidence=0.5 的 Stage A 被判定 silent 后，
    //   Stage B 仍被调用（decide 调了 2 次），并且确实产出了 hint。
    if (stageA.kind === "silent") {
      logger.debug("[decision-hint] Stage A silent — skip Stage B (no hint)");
      return;
    }

    // ⑤ Stage B（仅当判定为新建）
    const stageB = await this.runStageB(ctx, taskComponent);
    if (!stageB) return;

    if (stageB.kind === "remount") {
      const hint = buildHintText({
        scenario: "remount",
        newTaskId: stageB.newTaskId,
        recommendedRootId: stageB.recommendedRootId,
        recommendedRootTitle: stageB.recommendedRootTitle,
        currentParentId: stageB.currentParentId,
        currentRootAncestorId: stageB.currentRootAncestorId,
      });
      writeDecisionHint(ctx.options, hint);
    }
  }

  // ======================================================================
  // 兜底检索
  // ======================================================================

  @TracedAs("task.decision.hint.fallbackCandidates", {
    recordParams: true,
    recordResult: true,
    log: false,
    paramFilter: (args) => ({
      tags: (args[1] ?? []) as string[],
    }),
    resultFilter: (res: Task[]) => ({
      count: Array.isArray(res) ? res.length : -1,
      ids: Array.isArray(res) ? res.map((t) => t.id).join(",") : "",
    }),
  })
  private async fallbackCandidates(
    taskComponent: TaskComponentReadonly,
    tags: string[] | undefined,
  ): Promise<Task[]> {
    const cleanTags = (tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (cleanTags.length === 0) return [];

    try {
      const res = await taskComponent.searchTasksByKeywords(cleanTags, {
        limit: FALLBACK_TOP_N,
        // ⚠️ 必须包含 archived —— 否则 reopen 已归档任务永远选不到（契约 §2.5）
        include_archived: true,
      });
      // searchTasksByKeywords 同时扫 description/goals —— 二次收紧到 title+tags
      return (res.tasks ?? [])
        .filter((t) => {
          const titleHit = cleanTags.some((k) => t.title.toLowerCase().includes(k.toLowerCase()));
          const tagHit = (t.tags ?? []).some((tag) =>
            cleanTags.some((k) => tag.toLowerCase().includes(k.toLowerCase())),
          );
          return titleHit || tagHit;
        })
        .slice(0, FALLBACK_TOP_N);
    } catch (err) {
      logger.warn(`[decision-hint] fallback retrieval failed: ${(err as Error)?.message}`);
      return [];
    }
  }

  // ======================================================================
  // Stage A
  // ======================================================================

  @TracedAs("task.decision.hint.stageA", {
    recordParams: true,
    recordResult: true,
    log: false,
    paramFilter: (args) => {
      const ctx = (args[0] ?? {}) as TaskCreateContext;
      const candidates = (args[1] ?? []) as Task[];
      return {
        candidateCount: candidates.length,
        candidateIds: candidates.map((c) => c.id).join(","),
        title: (ctx?.options?.title ?? "").slice(0, 120),
        tagsCount: Array.isArray(ctx?.options?.tags) ? ctx.options.tags.length : 0,
      };
    },
    // kind 是判定结果：reuse / create / silent / null —— 直接反映门槛与阈值走向
    resultFilter: (res: any) => ({
      kind: res?.kind ?? "null",
      targetTaskId: res?.targetTaskId ?? null,
      confidence: res?.confidence ?? null,
    }),
  })
  private async runStageA(
    ctx: TaskCreateContext,
    candidates: Task[],
  ): Promise<
    | { kind: "reuse"; targetTaskId: number; confidence: number }
    | { kind: "create" }
    | { kind: "silent" }
    | null
  > {
    const now = Date.now();
    const request = this.buildStageARequest(ctx, candidates, now);

    let response: DecisionResponse;
    try {
      response = await this.decisionPort.decide(request);
    } catch (err) {
      logger.warn(`[decision-hint] Stage A decision failed: ${(err as Error)?.message}`);
      return null;
    }

    const answer = response?.answers?.["reuse_or_create"];
    if (!answer || typeof answer.choice !== "string") {
      logger.warn("[decision-hint] Stage A answer malformed — pass through");
      return null;
    }

    // ⚠️ Task #4627：门禁读 **x_jev_confidence**（Jev 公式置信度），
    //    不是 confidence（归一化熵）。见 pickGateConfidence 的注释。
    const confidence = pickGateConfidence(answer);

    // 静默档：不产生任何 hint，也不进入 Stage B（契约 §4.4）
    if (confidence < this.softHintThreshold) {
      return { kind: "silent" };
    }

    // NEW_TASK → 判定为「新建」，进入 Stage B
    if (answer.choice === "NEW_TASK") {
      return { kind: "create" };
    }

    // choice 必须在候选 key 集合里（模型可能回完整渲染 key，也可能只回裸 #id）
    // ⚠️ Task #4620：映射逻辑交给 renderer —— 不同载体的 key 形态不同
    //   （systemone: `#<id> [<type>] <title>` / laya: `#<id> <title[:50]>`）
    const targetTaskId = this.renderer.matchChoice(answer.choice, candidates);
    if (targetTaskId === undefined) {
      logger.warn(`[decision-hint] Stage A choice not in candidate set: ${answer.choice}`);
      return null;
    }

    return { kind: "reuse", targetTaskId, confidence };
  }

  private buildStageARequest(ctx: TaskCreateContext, candidates: Task[], now: number): DecisionRequest {
    // ⚠️ Task #4620：渲染委托给 renderer —— 不同载体的训练格式不同
    //   （systemone 用 JSON state；laya 用【新任务标题】中文文本 state）
    return this.renderer.buildStageA({
      title: ctx.options.title,
      description: ctx.options.description ?? "",
      goals: ctx.options.goals_and_expected_deliverables ?? "",
      tags: ctx.options.tags ?? [],
      projectPath: ctx.options.project_path ?? "",
      candidates,
      now,
    });
  }

  // ======================================================================
  // Stage B
  // ======================================================================

  @TracedAs("task.decision.hint.stageB", {
    recordParams: true,
    recordResult: true,
    log: false,
    paramFilter: (args) => {
      const ctx = (args[0] ?? {}) as TaskCreateContext;
      return {
        title: (ctx?.options?.title ?? "").slice(0, 120),
        hasExplicitParent: ctx?.options?.parent_task_id != null,
        explicitParentId: ctx?.options?.parent_task_id ?? null,
        projectPath: ctx?.options?.project_path ?? null,
      };
    },
    resultFilter: (res: any) => ({
      kind: res?.kind ?? "null",
      recommendedRootId: res?.recommendedRootId ?? null,
      currentParentId: res?.currentParentId ?? null,
      currentRootAncestorId: res?.currentRootAncestorId ?? null,
    }),
  })
  private async runStageB(
    ctx: TaskCreateContext,
    taskComponent: TaskComponentReadonly,
  ): Promise<
    | {
        kind: "remount";
        newTaskId: number;
        recommendedRootId: number;
        recommendedRootTitle: string;
        currentParentId: number;
        currentRootAncestorId: number;
      }
    | null
  > {
    const now = Date.now();
    const roots = await this.collectRootCandidates(taskComponent, ctx);
    if (roots.length === 0) return null;

    const criteria: Record<string, string> = {};
    const rootCandidates = roots.map((t) => {
      const key = renderCandidateKey(t);
      criteria[key] = renderCandidateValue({
        id: t.id,
        status: t.status,
        ago: formatRelativeAge(t.updatedAt, now),
        description: t.description ?? "",
        tags: t.tags ?? [],
      });
      return {
        id: t.id,
        type: t.type,
        ago: formatRelativeAge(t.updatedAt, now),
        title: t.title,
        snippet: truncateSnippet(t.description ?? ""),
        tags: t.tags ?? [],
      };
    });
    criteria["NEW_ROOT"] = "新建为顶级根任务（与所有现有根任务均无明确关联）";

    const request: DecisionRequest = {
      state: {
        task_to_route: {
          title: ctx.options.title,
          description: ctx.options.description ?? "",
          goals: ctx.options.goals_and_expected_deliverables ?? "",
          tags: ctx.options.tags ?? [],
          project_path: ctx.options.project_path ?? "",
          has_explicit_parent: ctx.options.parent_task_id != null,
          env_parent_task_id: this.envParentTaskIdProvider() ?? null,
          available_roots_count: roots.length,
          pool_size_before_prune: roots.length,
          pool_size_after_prune: roots.length,
          candidates_truncated: false,
          now: new Date(now).toISOString(),
        },
        root_candidates: rootCandidates,
      },
      questions: {
        root_choice: {
          type: "choice",
          instructions:
            "判断本次『新任务』应该新建为独立根任务，还是挂载到某个已有根任务下。若新任务和所有现有根任务都没明确关联，选 NEW_ROOT。输出 choice/confidence/probabilities。",
          criteria,
        },
      },
    };

    let response: DecisionResponse;
    try {
      response = await this.decisionPort.decide(request);
    } catch (err) {
      logger.warn(`[decision-hint] Stage B decision failed: ${(err as Error)?.message}`);
      return null;
    }

    const answer = response?.answers?.["root_choice"];
    if (!answer || typeof answer.choice !== "string") return null;

    // ⚠️ Task #4627：同上，读 x_jev_confidence
    const confidence = pickGateConfidence(answer);
    if (confidence < this.softHintThreshold) return null;

    const keyById = new Map(roots.map((t) => [renderCandidateKey(t), t]));
    let recommended = keyById.get(answer.choice);
    if (!recommended && answer.choice.startsWith("#")) {
      // 模型可能只回裸 #id（而不是完整渲染 key）
      const bareId = Number(answer.choice.slice(1));
      if (Number.isInteger(bareId)) recommended = roots.find((t) => t.id === bareId);
    }
    if (!recommended) return null;

    // NEW_ROOT → 不提示（尊重用户意图）
    const currentParentId = ctx.options.parent_task_id ?? undefined;
    if (currentParentId === undefined) return null;

    const currentRootAncestorId = await this.resolveRootAncestor(taskComponent, currentParentId);
    if (currentRootAncestorId === recommended.id) {
      // 同一 root → 静默通过（层级差异属合理选择）
      return null;
    }

    return {
      kind: "remount",
      // 新任务还没创建（hint 在 create-tool 侧拼接时才知道 id）→ 用占位 0
      newTaskId: 0,
      recommendedRootId: recommended.id,
      recommendedRootTitle: recommended.title,
      currentParentId,
      currentRootAncestorId,
    };
  }

  private async collectRootCandidates(
    taskComponent: TaskComponentReadonly,
    ctx: TaskCreateContext,
  ): Promise<Task[]> {
    try {
      const all = (await taskComponent.listTasks({ depth: 0, include_archived: true }))?.tasks ?? [];
      const longterm = all.filter((t) => t.type === "longterm").slice(0, MAX_LONGTERM_ROOTS);

      const keywords = (ctx.options.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
      let matched: Task[] = [];
      if (keywords.length > 0) {
        matched = all.filter((t) => {
          const titleHit = keywords.some((k) => t.title.toLowerCase().includes(k.toLowerCase()));
          const tagHit = (t.tags ?? []).some((tag) =>
            keywords.some((k) => tag.toLowerCase().includes(k.toLowerCase())),
          );
          return titleHit || tagHit;
        });
      }

      const seen = new Set<number>();
      const out: Task[] = [];
      for (const t of [...longterm, ...matched]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
      }
      return out.slice(0, MAX_LONGTERM_ROOTS + MAX_KEYWORD_ROOTS);
    } catch (err) {
      logger.warn(`[decision-hint] root collection failed: ${(err as Error)?.message}`);
      return [];
    }
  }

  /**
   * 解析 root 祖先链（**防环** —— tasks.db 里存在手改 parent_task_id 造成的环）。
   */
  private async resolveRootAncestor(
    taskComponent: TaskComponentReadonly,
    taskId: number,
  ): Promise<number> {
    const visited = new Set<number>([taskId]);
    let current = taskId;

    for (let depth = 0; depth < MAX_ROOT_ANCESTOR_DEPTH; depth++) {
      const t = await taskComponent.getTask(current);
      const parentId = t?.parent_task_id;
      if (parentId === undefined || parentId === null) return current;
      if (visited.has(parentId)) {
        logger.warn(`[decision-hint] root ancestor cycle detected at #${parentId}`);
        return current;
      }
      visited.add(parentId);
      current = parentId;
    }
    return current;
  }

  // ======================================================================
  // Helpers
  // ======================================================================

  private reuseHintInput(target: Task, confidence: number): HintInput {
    const action = deriveActionFromStatus(target.status);
    const scenario =
      action === "reopen"
        ? "reopen"
        : confidence >= this.reuseThreshold
          ? "reuse"
          : "soft_reuse";
    return {
      scenario,
      newTaskId: 0, // 写入时新任务还没有 id → 占位符（create-tool 侧替换）
      targetTaskId: target.id,
      targetTask: { title: target.title, status: target.status, type: target.type },
      confidence,
    };
  }
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value > 1) return 1;
  if (value < 0) return 0;
  return value;
}

/**
 * Task #4627 — 选取**门禁用的置信度**（#302 的核心）。
 *
 * ⚠️ `confidence` 是**归一化熵**，**不是** Jev 公式置信度。
 *   laya 同时返回 `confidence`（熵）与 `x_jev_confidence`（Jev 公式），
 *   60 条实测里 20 条差异 > 0.05 —— 读错字段会让门禁形同虚设。
 *
 *   选源顺序：`x_jev_confidence` → `answer_confidence` → `confidence`。
 *
 *   ⚠️ 为什么不在载体侧做完就算：`LayaDecisionPort.normalize()` 已经把
 *   `confidence` 覆盖成选源后的值，但那是**载体专属**的归一化 —— 换载体
 *   （systemone 就没有 x_jev_confidence）就失效。判定层自己再选一次源，
 *   保证「门禁永远读 Jev 公式置信度」这条不变量与载体解耦。
 */
export function pickGateConfidence(answer: DecisionAnswer | undefined): number {
  if (!answer) return 0;
  const jev = typeof answer.x_jev_confidence === "number" ? answer.x_jev_confidence : undefined;
  const answerConf =
    typeof answer.answer_confidence === "number" ? answer.answer_confidence : undefined;
  const entropy = typeof answer.confidence === "number" ? answer.confidence : undefined;
  const picked = jev ?? answerConf ?? entropy;
  return clampConfidence(picked);
}

function truncateSnippet(text: string): string {
  if (text.length <= 45) return text;
  return text.slice(0, 45) + "…";
}
