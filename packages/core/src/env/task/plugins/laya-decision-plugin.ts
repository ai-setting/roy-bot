/**
 * @fileoverview Task #4620 — Laya 决策插件：把 #4467 的 decision 检测接到本地 Laya 服务
 *
 * 与 `DecisionHintPlugin`（#4481，阿里百炼 provider）的关系：
 *   - `DecisionHintPlugin` 是**载体无关**的判定逻辑（Stage A/B、门槛、hint 渲染）
 *   - 本文件是**载体接入层**：读 `~/.roy-bot/auth.json` 的 `providers["laya-decision"]`，
 *     构造 `LayaDecisionPort`，再把 port 注入 `DecisionHintPlugin`
 *
 * 形态：**只提示，不拦截**（与 #4467 契约一致）。
 *
 * ── fail-open 总原则（硬要求） ────────────────────────────────────────────────
 *
 * 本插件挂在 `task:before.create` 上，**任何**异常都不得影响 task_create：
 *   - auth.json 读不到 / provider 不存在 → 不装 port → 插件直接跳过
 *   - 网络错误 / 超时 / HTTP 非 2xx / 响应结构不对 → 判定降级为 null → 不出 hint
 *   - 熔断后 → isDisabled() → 跳过
 *   - 候选为空 → 不调模型
 *
 * 因此这里的**每一个** await 都有 try/catch 包裹，且 catch 里只记日志、绝不 rethrow。
 *
 * ── 置信度门禁 ──────────────────────────────────────────────────────────────
 *
 * 复用建议（"应复用 #X"）是**破坏性建议**（用户可能因此不建新任务），
 * 按 #4467 的 Q4 拍板用高门槛（`REUSE_ADOPT_THRESHOLD` 之上单独一档；
 * Task #4643 起默认 **≥ 0.92**）。
 * laya 的 `x_jev_confidence` 在 896 条实测中：thr=0.85 → 提示精确率 80.5%、
 * thr=0.90 → 84.9%、thr=0.95 → 87.0%（coverage 28.7% / 25.9% / 18.9%）。
 * ⚠️ Task #4643 live 实测（25 条 gold unseen）：0.85~0.92 区间零 case，
 * 误报的 jev 全部 ≥0.938 —— 该模型「错得自信」，单纯提阈值滤不掉误报。
 */

import { DecisionHintPlugin } from "./decision-hint-plugin";
import { LayaDecisionPort, loadLayaAuth } from "./laya-port";
import { layaRenderer } from "./decision-renderers";
import type { DecisionPort } from "./decision-port";
import type { TaskCreateContext } from "../hooks/contexts";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("plugin:laya-decision");

/** 复用建议的置信度门禁（#4467 Q4：破坏性动作门槛；Task #4643 提到 0.92） */
export const LAYA_REUSE_THRESHOLD = 0.92;

export interface LayaDecisionPluginOptions {
  /** auth.json 路径（默认 ~/.roy-bot/auth.json） */
  authPath?: string;
  /** 硬超时（默认 2000ms） */
  timeoutMs?: number;
  /** 连续超时多少次后自我禁用（默认 3） */
  maxStrikes?: number;
  /** 置信度来源（默认 auto：x_jev_confidence 优先） */
  confidencePref?: "auto" | "jev" | "entropy";
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof globalThis.fetch;
  /** 注入 port（测试用；给了就不读 auth.json） */
  decisionPort?: DecisionPort;
  /** 注入上下文读取（生产用 getEnvContextOrEmpty().parentTaskId） */
  envParentTaskIdProvider?: () => number | undefined | null;
  /**
   * 「建议复用」硬提示的置信度门禁（默认 LAYA_REUSE_THRESHOLD = 0.92）。
   * 896 条实测：0.85 → 精确率 80.5%（coverage 28.7%）、0.9 → 84.9%、0.95 → 87.0%。
   */
  reuseThreshold?: number;
  /** 低于此置信度完全不出提示（默认与 reuseThreshold 同值 = 0.92） */
  softHintThreshold?: number;
  /**
   * 单候选快捷路径（默认 false）。
   * 开启后「只有 1 个候选 → 不调模型直接提示」—— 该路径**没有置信度**，
   * 与「必须门禁 ≥0.92」冲突，所以默认关掉。
   */
  singleCandidateShortcut?: boolean;
}

/**
 * Laya 决策插件 —— 挂在 `task:before.create` 上。
 *
 * 用法：
 * ```ts
 * const plugin = new LayaDecisionPlugin();
 * await plugin.execute(ctx);   // ctx: TaskCreateContext | { data: TaskCreateContext }
 * ```
 *
 * ⚠️ `execute()` **永远不抛**。
 */
export class LayaDecisionPlugin {
  readonly name = "laya-decision";
  readonly version = "1.0.0";
  readonly description =
    "Task #4620 — task:before.create 决策检测（本地 Laya 服务载体，只提示不拦截）";

  private readonly options: LayaDecisionPluginOptions;
  private port: DecisionPort | null = null;
  private portResolved = false;
  private inner: DecisionHintPlugin | null = null;

  constructor(options: LayaDecisionPluginOptions = {}) {
    this.options = options;
    // ⚠️ 注入的 port 立刻接管 —— 否则 isDisabled() 在第一次 execute() 之前
    // 永远返回 false（port 是懒解析的），观测接口会说谎。
    if (options.decisionPort) {
      this.port = options.decisionPort;
      this.portResolved = true;
    }
  }

  /** 当前是否已自我禁用（熔断）—— 供观测 */
  isDisabled(): boolean {
    return this.port?.isDisabled() ?? false;
  }

  /**
   * hook 入口 —— **永不抛**。
   *
   * 失败路径一律是「不出 hint」，不影响 task_create 的成功语义。
   */
  async execute(ctx: TaskCreateContext | { data: TaskCreateContext }): Promise<void> {
    try {
      const inner = await this.ensureInner();
      if (!inner) {
        logger.debug("[laya-decision] no decision port configured — skip");
        return;
      }
      await inner.execute(ctx);
    } catch (err) {
      // ⚠️ 兜底：DecisionHintPlugin 内部已经 catch 过了；这里再兜一层，
      // 保证「插件永不抛」这条硬约束在任何情况下都成立。
      logger.warn(`[laya-decision] unexpected failure, ignored: ${(err as Error)?.message}`);
    }
  }

  /** 懒加载 + 缓存 port（读 auth.json 只做一次） */
  private async ensureInner(): Promise<DecisionHintPlugin | null> {
    if (this.inner) return this.inner;

    const port = await this.resolvePort();
    if (!port) return null;

    this.inner = new DecisionHintPlugin({
      decisionPort: port,
      envParentTaskIdProvider: this.options.envParentTaskIdProvider,
      // ⚠️ Task #4620：必须用 laya 渲染器 —— Laya 模型是在 laya 的训练格式上训的，
      //   发成 systemone 的 JSON state 实测准确率从 79.0% 掉到 46.5%。
      renderer: layaRenderer,
      // ⚠️ 门禁：#4467 Q4 的「不新建」是破坏性动作 → 门槛 ≥0.92
      //   （Task #4643：0.85 → 0.92；live 实测 0.85~0.92 区间零 case）
      reuseThreshold: this.options.reuseThreshold ?? LAYA_REUSE_THRESHOLD,
      // 语义等价于「<0.92 一律不出提示」
      softHintThreshold: this.options.softHintThreshold ?? LAYA_REUSE_THRESHOLD,
      // 单候选捷径没有置信度 → 关掉，让它也走模型过门禁
      singleCandidateShortcut: this.options.singleCandidateShortcut ?? false,
    });
    return this.inner;
  }

  private async resolvePort(): Promise<DecisionPort | null> {
    if (this.portResolved) return this.port;
    this.portResolved = true;

    // 测试注入优先
    if (this.options.decisionPort) {
      this.port = this.options.decisionPort;
      return this.port;
    }

    let cfg: Awaited<ReturnType<typeof loadLayaAuth>> = null;
    try {
      cfg = await loadLayaAuth(this.options.authPath);
    } catch (err) {
      // loadLayaAuth 内部已 catch；这里是双保险
      logger.warn(`[laya-decision] auth load failed: ${(err as Error)?.message}`);
      return null;
    }
    if (!cfg) {
      logger.info("[laya-decision] providers['laya-decision'] not configured in auth.json — skip");
      return null;
    }

    try {
      this.port = new LayaDecisionPort({
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: this.options.timeoutMs,
        maxStrikes: this.options.maxStrikes,
        fetchImpl: this.options.fetchImpl,
        confidencePref: this.options.confidencePref,
      });
      logger.info(
        `[laya-decision] port ready: ${cfg.baseURL} model=${cfg.model} ` +
          `timeout=${this.options.timeoutMs ?? 2000}ms strikes=${this.options.maxStrikes ?? 3}`,
      );
      return this.port;
    } catch (err) {
      logger.warn(`[laya-decision] port construction failed: ${(err as Error)?.message}`);
      return null;
    }
  }
}

// ============================================================================
// Plugin factory — 适配 roy-bot 的 **task hook** 通道
// ============================================================================

/**
 * Task #4627 — 进程级共享的 LayaDecisionPlugin 实例。
 *
 * ⚠️ 为什么需要共享：
 *   `handle_query` 每次调用都会重新注册 hook（幂等要求），如果每次都
 *   `new LayaDecisionPlugin()`：
 *     ① auth.json 会被反复读取（每次 task_create 都读一遍磁盘）
 *     ② `LayaDecisionPort` 的 3-strike 熔断计数会**每次归零**
 *        → 服务「慢而不挂」时熔断永远攒不满 3 次 → 熔断形同虚设
 *
 * 共享后：auth.json 只读一次，熔断计数跨查询累计。
 *
 * ⚠️ 测试注入不受影响：`registerLayaDecisionTaskHook(taskComponent, options)`
 *    传了 options 时**不**走这个缓存（测试要拿到独立的假 port）。
 */
let sharedPlugin: LayaDecisionPlugin | null = null;

/** 取进程级共享实例（仅生产路径用；传了 options 就新建，避免测试串味） */
export function getSharedLayaDecisionPlugin(
  options?: LayaDecisionPluginOptions,
): LayaDecisionPlugin {
  if (options && Object.keys(options).length > 0) {
    return new LayaDecisionPlugin(options);
  }
  if (!sharedPlugin) {
    sharedPlugin = new LayaDecisionPlugin();
  }
  return sharedPlugin;
}

/**
 * Task #4627 — 把 LayaDecisionPlugin 包成**可注册到 task hook** 的形态。
 *
 * ⚠️ 为什么不是 Agent `Plugin`：
 *   - `AgentComponent.registerPlugin(agentName, plugin)` 只把 plugin 放进
 *     `agent.plugins` Map，**不写 globalHookManager**。
 *   - `agent.plugins` 只由 `executePluginHooks()` 派发，且只在 **agent 作用域**
 *     的 hook 点被调用（`agent:before.start` / `agent:before.llm` / `agent:before.tool`
 *     / `agent:after.tool` / `agent:on.iteration` / `agent:after.react`
 *     / `agent:after.complete` / `agent:on.error` / `on.error`）
 *     —— **不含 `task:before.create`**。
 *   - `task:before.create` 真正的派发路径是：
 *     `TaskComponent.createTask()` → `executeHook(TaskHookPoints.BEFORE_CREATE, createCtx)`
 *     → `globalHookManager.execute("task:before.create", data, metadata)`
 *   - 所以正确注册方式是 `taskComponent.registerHook(TaskHookPoints.BEFORE_CREATE, {...})`。
 *
 *   附带类型问题（Agent `Plugin` 这条路本身走不通）：
 *   - `agent/types.ts` 的 `HookPoint` 联合类型里**没有** `"task:before.create"`
 *     （旧代码用 `as HookPoint` 强转绕过 → 运行期不报错但永远不触发）
 *   - `hook/types.ts` 的 `HookResult` 是 `{stopped?, action?, results?}`，
 *     **没有** `continue` 字段（旧代码 `return { continue: true }` 不匹配）
 *
 * 本工厂返回的是 `Hook` 形态（`hook/types.ts`），由
 * `registerLayaDecisionTaskHook()` 负责注册到 task hook 通道。
 *
 * ⚠️ fail-open：注册失败不影响 agent 启动（调用方自行 try/catch）。
 */
export function createLayaDecisionPlugin(
  options?: LayaDecisionPluginOptions,
): {
  /** Hook 唯一名称（用于幂等去重 / unregister） */
  name: string;
  /** 执行优先级 */
  priority: number;
  /** hook 执行体 —— 永不抛 */
  execute: (ctx: unknown) => Promise<void>;
  /** 内层插件实例（供观测 / 测试） */
  plugin: LayaDecisionPlugin;
} {
  const inner = getSharedLayaDecisionPlugin(options);
  return {
    name: "laya-decision",
    priority: 20,
    execute: async (ctx: unknown) => {
      const data =
        ctx && typeof ctx === "object" && "data" in ctx
          ? (ctx as { data: unknown }).data
          : ctx;
      await inner.execute(data as TaskCreateContext);
    },
    plugin: inner,
  };
}
