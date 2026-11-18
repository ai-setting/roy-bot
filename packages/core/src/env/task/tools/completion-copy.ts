/**
 * @fileoverview Task #4834 — F3: task_complete 验收文案同源锚点
 *
 * 背景（reports/goals-criteria-rules-e2e-rebase.md §遗留 F3）：
 *   prompts-index.ts 的 COMPLETE 生命周期步骤与工具描述
 *   （TASK_COMPLETE_DESCRIPTION）**不同源** —— 文案漂移会
 *   稀释工具描述的遵循度。
 *
 * 方案：三个关键短语定义于此，complete-tool 与
 * prompts-index（default prompt）都引用同一常量，
 * 文案一致性由 completion-copy-consistency.test.ts 守住。
 *
 * ⚠️ 本模块必须保持**零依赖**（不 import 任何其他模块），
 *   以便 prompts-index（超大模板串）与 tools 层都能安全引用。
 */

/** 逐条验收短语（工具描述 / default prompt 共用） */
export const TASK_COMPLETE_ITEM_BY_ITEM = "按子项逐条验收";

/** hint 锚点 token（completion hook 写入 task context 的标记） */
export const TASK_COMPLETION_HINT_ANCHOR = "TASK_COMPLETION_HINT";

/** 核实义务短语（收到 hint 后必须核实，二选一） */
export const TASK_COMPLETE_VERIFY_DUTY = "核实义务";

/** F3 同源文案集合（聚合导出，便于测试解构） */
export const TASK_COMPLETE_ACCEPTANCE = {
  itemByItem: TASK_COMPLETE_ITEM_BY_ITEM,
  hintAnchor: TASK_COMPLETION_HINT_ANCHOR,
  verifyDuty: TASK_COMPLETE_VERIFY_DUTY,
} as const;

/**
 * Task #5060 — 终态 current_status 文案同源锚点
 *
 * 背景：`task_complete` / `task_cancel` 原来只改 status/progress，
 * **完全不碰 current_status** ⇒ 任务落终态后 current_status 仍留着
 * 完成前的旧文案（如「按用户方案 X 决定暂停：未 commit」），出现
 * 「status=completed 但描述说没做完」的自相矛盾状态。
 *
 * 修复：终态工具在同一次 updateTask 里把 current_status 一起写成终态语义。
 * 下面的短语是「终态 current_status」的**唯一措辞来源** ——
 * task-component（完成）/ cancel-tool（取消）都引用它，避免两处漂移。
 */

/** 完成态 current_status 的核心语义词 */
export const TASK_COMPLETED_STATUS_WORD = "已完成";

/** 取消态 current_status 的核心语义词 */
export const TASK_CANCELLED_STATUS_WORD = "已取消";

/** 交付物已记录的前缀（跟在终态词之后） */
export const TASK_DELIVERABLE_RECORDED = "交付物已记录";

/**
 * Task #5063 — 归档态 current_status 的核心语义词
 *
 * 背景（Task #5060 的 follow-up，DS review 留档 MINOR m2）：
 *   `archived` 是「终态 current_status 不刷新」这个 bug 的**第四个出口**。
 *   #5060 只修了 completed / cancelled 两条路径，导致走归档路径
 *   （`tasks complete --archive`、批量归档工具、通用 task_update）
 *   的任务完成后 current_status 仍留着归档前的旧文案。
 *
 *   本锚点与 TASK_COMPLETED_STATUS_WORD / TASK_CANCELLED_STATUS_WORD 并列，
 *   是「归档态 current_status」的**唯一措辞来源**。
 */
export const TASK_ARCHIVED_STATUS_WORD = "已归档";

/**
 * Task #5067 — reopen（终态 → 非终态）后 current_status 的核心语义词
 *
 * 背景（Task #5063 DS review 留档 MINOR m1）：
 *   #5063 只收口了「**迁入**终态时刷新 current_status」，**反向**路径没管：
 *   任务从终态被 reopen 回 active/todo 时，current_status 仍停在终态文案
 *   （"已归档" / "已取消" / "已完成"）⇒ 出现
 *       status: active / current_status: "已归档"     ← 说反了
 *
 * 为什么措辞是「已重新打开」而不是清空：
 *   卡片渲染（lark-card-patch-notifier.ts）与 CLI（tasks get / tasks search）
 *   都用 `if (current_status)` 守卫 —— **空串会让整行消失**，用户看到的是
 *   一张没有「📶 当前状态」行的卡片，而不是「已重新打开」。
 *   「已重新打开」非空、可渲染、语义明确（区别于「已完成」这类终态词）。
 */
export const TASK_REOPENED_STATUS_WORD = "已重新打开";

/**
 * Task #5073 — 待验证（to_validate）current_status 的核心语义词
 *
 * 两阶段验收（#5007 的机制化落地）：
 *   sub-agent 干完 → `task_pre_complete` → status=to_validate，
 *   current_status 刷成「待验证」；default agent `task_complete`
 *   校验通过后才落 completed（措辞 TASK_COMPLETED_STATUS_WORD）。
 *
 * 与终态措辞（TASK_COMPLETED_STATUS_WORD 等）并列但**不入**
 * TASK_TERMINAL_STATUS_WORDS —— to_validate 是**非终态**
 * （reopen 反向收口管不着它：从 to_validate 迁出时 current_status
 * 本来就该带「待验证」语义，由 withTerminalCurrentStatus 的
 * 非终态分支按调用方意图处理）。
 */
export const TASK_TO_VALIDATE_STATUS_WORD = "待验证";
/**
 * Task #5067 — 终态 current_status 措辞锚点集合（reopen 判定的**唯一**依据）
 *
 * 用途：`withTerminalCurrentStatus` 在「迁出终态」时，需要判断当前
 * current_status 是不是**系统写的终态文案**（而不是调用方自己写的）。
 * 判定方式 = current_status 以本集合中任一锚点**开头**。
 *
 * ⚠️ 为什么用 startsWith 而不是 includes：
 *   终态文案可能带后缀（如「已归档：批量整理」「已完成（交付物已记录：/x.md）」），
 *   但**开头**的锚点才是系统写的语义主体。反过来，包含判断会误伤
 *   调用方自己写的「已完成的部分：A/B/C」这类正常文案。
 *
 * ⚠️ 边界取舍（已知且接受）：
 *   若调用方**恰好手动写了**以「已完成」/「已取消」/「已归档」开头的文案，
 *   且任务当时正处于终态，reopen 时该文案会被系统措辞替换。
 *   这是「值比对」方案的固有代价 —— 用「前态 status 是终态」这一额外条件
 *   把它压到极窄（只在真的从终态迁出、且文案形状与系统措辞完全一致时触发）。
 */
export const TASK_TERMINAL_STATUS_WORDS = [
  TASK_COMPLETED_STATUS_WORD,
  TASK_CANCELLED_STATUS_WORD,
  TASK_ARCHIVED_STATUS_WORD,
] as const;

/**
 * ★ Task #5073（DS review r4 MINOR-3）— 终态护栏集合的同源锚点：
 *   已终态（cancelled / archived）任务**不可**被「验收通过」翻转成
 *   completed。消费点：TaskComponent.completeTask（组件层护栏，
 *   兜底 CLI / 直连通道）+ complete-tool.ts（tool 层友好报错）。
 *
 *   ⚠️ to_validate / active / todo / paused **不在**集合里 ——
 *   规范路径 to_validate → completed 与兜底路径 active →
 *   completed（#5054 补验收）都必须放行。
 */
export const TERMINAL_NON_ACCEPTABLE_STATUSES = [
  "cancelled",
  "archived",
] as const;
