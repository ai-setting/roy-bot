/**
 * @fileoverview Chat Command — Ink-based one-shot query (range C).
 *
 * Task #2610 stage 4: implements the `chat <message>` subcommand as a
 * yargs CommandModule that mounts <ChatTui> (the new Ink TUI from stage 3).
 *
 * Flag parity with the prototype `chat` command:
 *   --model           LLM model to use
 *   --system-prompt   System prompt override
 *   --workdir         Working directory (default cwd)
 *   --max-lines       Truncate response to N lines (0 = unlimited)
 *   --no-markdown     Disable markdown rendering (raw output)
 *
 * Scope C note: this command is ADDED alongside the existing
 * `interactive` command. See run.ts for rationale.
 */

import React from "react";
import { render } from "ink";
import { CommandModule } from "yargs";
import ChatScreen from "../ChatTui.js";
import { setMarkdownEnabled } from "../render/markdown.js";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import { CliQuietModeService } from "../services/quiet-mode.service";
// ★ Task #4571：chat 必须用**真实** session（原实现硬编码 "cli-chat"，
//   而该 session 从未 create → delegate_task 报 "Parent session not found"）。
import {
  createChatSession,
  waitForBackgroundTasks,
  probeUnfinishedTasks,
  DEFAULT_CHAT_WAIT_TIMEOUT_MS,
} from "./shared/chat-session.js";
// ★ Task #4576：chat 也要起 EventHandler + TaskEventHandler（对齐 run/interactive）。
//
//   此前 chat 是 0 处 EventHandler，于是：
//     - 后台任务 notify event 无消费方 → rule-based 通知无落点
//     - 部分 event 无 agent 接管
//   只能靠 chat.ts 自己轮询 listTasks() 等任务结束（#4571 的临时方案）。
import {
  createChatEventHandlers,
  type ChatEventHandlers,
} from "./shared/chat-event-handler.js";
// ★ Task #4576：chat 必须 emit trigger event，否则 delegate 的 replyChannel
//   快照为 undefined → notify event 无目标 → 通知静默丢弃（见设计 F5-F8）。
import {
  emitCliTriggerEvent,
  toCliEnvEvent,
  formatTriggerEcho,
  writeTriggerEcho,
} from "./shared/cli-trigger-event.js";
// ★ Task #4634：CLI --model / --fallback-model → AgentContext 的统一接线
import {
  buildModelAgentContext,
  checkFallbackModelArg,
  FALLBACK_MODEL_DESCRIBE,
  MODEL_DESCRIBE,
} from "./model-flags.js";

export interface ChatOptions {
  model?: string;
  /**
   * ★ Task #4634：兜底模型（providerId/modelId）。
   * 主模型 404/429/额度耗尽/5xx/超时/重试耗尽时，本次 run 自动降级；
   * default agent 与 sub agent 均生效（与 `act` / `interactive` 语义一致）。
   */
  fallbackModel?: string | string[];
  systemPrompt?: string;
  workdir?: string;
  maxLines?: string;
  markdown?: boolean;
  plugins?: string[];
  config?: string;
  env?: string;
  message: string;
}

/**
 * 构建 chat 的 query 入口。
 *
 * ★ Task #4634：导出以支持单测直接捕获 `env.handle_query` 收到的 AgentContext
 *   （handler 本身会挂 Ink 并 `await waitUntilExit()`，单测里跑不动）。
 *   生产调用方仍是下面的 handler。
 */
export async function loadHandleQuery(
  options: ChatOptions
): Promise<{
  handleQuery: (message: string, envEvent?: unknown) => Promise<string>;
  env: any;
  quiet: boolean;
  output: OutputService;
  /** ★ Task #4576：chat 的 EventHandler 组合（调用方负责在 exit 前 stop） */
  chatEventHandlers: ChatEventHandlers;
  /** ★ Task #4576：后台任务 manager（轮询等待用） */
  bgManager: any;
}> {
  const quiet = CliQuietModeService.getInstance().isQuiet();
  const output = new OutputService();
  output.configure({ quiet });
  const envService = new EnvironmentService(output);
  await envService.create({
    envName: options.env,
    configPath: options.config,
    workDir: options.workdir,
    loadPlugins: true,
    plugins: options.plugins,
    commandName: "chat",
  });
  const env = envService.getEnvironment();
  if (!env) {
    throw new Error("Failed to create environment");
  }

  // ★ Task #4571（方案 B，用户 2026-10-27 拍板）：先 create 真实 session，
  //   再用它的 id 调 handle_query。
  //
  //   原实现写死 `sessionId: "cli-chat"`，而该值从未注册进 session store。
  //   delegate_task → BackgroundTaskManager.createTask() 第一步就是
  //   `sessionComponent.get(parentSessionId)`，拿到 undefined 即抛
  //   「Parent session not found: cli-chat」⇒ chat 里任何委托 100% 失败。
  //
  //   为什么在 env 创建之后、handle_query 之前（而不是在 handler 里）：
  //     - 一次 chat 调用 = 一个 session，和 handleQuery 同生命周期，放一起最直观
  //     - sessionComponent 只有 env 就绪后才可拿
  //
  //   为什么 session 保留不删（Q1 = 方案 b）：
  //     - 后台任务的 task.parentSessionId 会指向它，删了会导致
  //       `query_background_process` 复盘时拿不到父会话上下文
  //     - 清理有现成能力：`roy-bot sessions delete --older-than N`
  const sessionComponent = env.getComponent?.("session") as any;
  const { sessionId, title } = await createChatSession(sessionComponent, {
    // 用户原始 query —— 用于生成可辨识的 session title + 留档
    message: options.message,
  });
  if (!quiet) {
    // ★ 写 stderr 而不是 output.info(console.log)：
    //   这一行打印在 `render()` **之前**，Ink 接管终端时会整屏重绘把它抹掉
    //   （交叉验证 LOW：session id 实际从未可见）。同样走 stderr 绕开 Ink。
    try {
      process.stderr.write(`会话: ${title} (${sessionId})\n`);
    } catch {
      // 终端已关闭等极端情况：忽略
    }
  }

  /**
   * ★ Task #4576：统一的通知落点 —— 一律走 stderr。
   *
   * 为什么不走 stdout / OutputService：
   *   - `console.log`（stdout）会被 Ink 的整帧重绘覆盖或错序
   *     （Task #4568 的 `writeTriggerEcho` 已为此专门绕道 stderr）
   *   - `OutputService.info/success/warn` 在 quiet 模式（默认）下全是 no-op
   *     （#4571 实测：等待 13s 但一条提示都看不到）
   */
  const notice = (text: string) => {
    try {
      process.stderr.write(`${text}\n`);
    } catch {
      // 终端已关闭等极端情况：忽略，绝不影响主流程
    }
  };

  /**
   * 跑一轮 agent。
   *
   * @param message  用户 query 或格式化后的通知文案
   * @param envEvent 触发本轮的 EnvEvent
   *                 - 用户轮：由 `emitCliTriggerEvent` 造出的 CLI trigger event
   *                 - 通知轮：EventHandler 原样透传的后台任务事件
   *
   * ★ 判据用「envEvent 是否存在」区分用户轮 / 通知轮（与 run.ts:221 一致）：
   *   通知轮**不能**再 emit trigger event，否则 notify → agent → delegate →
   *   notify 无限套娃。
   */
  /**
   * ★ 交叉验证 M1：chat 自己那一轮是否在跑。
   *
   * 用途：注入给 EventHandler 当 `isIdle` / `isSessionIdle`，让**通知轮不与
   * 用户轮并发**跑同一个 session。
   *
   * 为什么需要：`delegate_task` 立即返回，子任务常在 1s 内完成 —— 也就是用户轮
   * **还在写回复**时 `task.background.completed` 就到了。没有门禁的话，通知轮
   * 会立刻并发 `env.handle_query`，两轮同时写同一 session（历史交错 + 抢配额）。
   *
   * 为什么现在不怕"自己等自己"：`EventHandler.waitForIdle()` 在 lane **出队前**
   * 只查一次，而 chat 自己那一轮从不在 lane 里记账 ⇒ 真判据不会自等。
   * （原实现写死 `() => true` 并声称会死锁，xval 指出该理由不成立。）
   */
  // ★ 交叉验证 N6：用**计数器**而不是布尔。
  //
  //   布尔的问题：用户轮与通知轮理论上不会重叠（M1 的门禁就是为了不重叠），
  //   但门禁是 check-then-act（`waitForIdle()` 检查通过到真正开跑之间有窗口）。
  //   万一两者短暂重叠，先结束的那个会把 flag 清零 → 门禁提前重开 → 第三个
  //   轮次可趁虚而入。计数器把这类"重叠即破"的 bug 整类消掉。
  let activeChatTurns = 0;

  const handleQuery = async (message: string, envEvent?: unknown) => {
    const isUserTurn = !envEvent;
    activeChatTurns++;
    try {
      return await runQuery(message, envEvent, isUserTurn);
    } finally {
      activeChatTurns--;
    }
  };

  const runQuery = async (
    message: string,
    envEvent: unknown,
    isUserTurn: boolean,
  ) => {
    const cliTrigger = isUserTurn
      ? await emitCliTriggerEvent({
          command: "chat",
          query: message,
          sessionId,
        })
      : null;

    // 与 run/interactive 一致：--no-quiet 时回显 triggerEventId
    if (cliTrigger) {
      const echo = formatTriggerEcho(cliTrigger.triggerEventId, { quiet });
      if (echo) writeTriggerEcho(echo);
    }

    // ★ 优先用传入的 envEvent（通知轮），其次用刚 emit 的 CLI trigger event。
    //   两者都缺时**不传** envEvent —— 绝不把上一轮的 replyChannel 串过来。
    //
    //   显式 as any：`AgentContext.envEvent` 要求完整 `EnvEvent<unknown>`
    //   （id/type/timestamp/metadata/payload 全必填），而通知轮透传的是
    //   `unknown`；run.ts 里走的是 QueryExecutor（ctx 是 any）所以不报。
    //   这里不为了过类型检查去伪造字段 —— 那是污染。
    const envEventForRun = envEvent
      ? envEvent
      : cliTrigger
        ? toCliEnvEvent(cliTrigger, message)
        : undefined;

    const result = await env.handle_query(message, {
      sessionId,
      // ★ Task #4634：`--model` 此前只传给了 ChatScreen（纯显示），
      //   从未进入 AgentContext ⇒ chat 下的 `--model` 实际**不生效**。
      //   现在与 act / interactive / run 统一走 buildModelAgentContext。
      ...buildModelAgentContext(options),
      ...(envEventForRun ? { envEvent: envEventForRun as any } : {}),
    });
    return String(result ?? "");
  };

  // ========== ★ Task #4576：EventHandler + TaskEventHandler ==========
  // 启动时机：session 就绪之后（EventHandler 要靠 sessionComponent 把
  // `cli:<sid>` 解析回原 session）、首个 query 之前（`task.background.started`
  // 在 delegate 返回前就 publish 了，晚起会丢第一条 —— #2728 在 run.ts 上修的
  // 就是这个坑）。
  const chatEventHandlers = createChatEventHandlers({
    env,
    sessionComponent: sessionComponent as unknown,
    notice,
    runAgentTurn: (message, ev) => handleQuery(message, ev),
    // ★ 交叉验证 M1：真实门禁（不是写死 true）—— 通知轮等用户轮跑完再起。
    isIdle: () => activeChatTurns === 0,
    isSessionIdle: () => activeChatTurns === 0,
  });

  // ★ Task #4576（Q1）：后台任务 manager 提前取，供 handler 忙碌组合等待用。
  const taskComponent = env.getComponent?.("task") as any;
  const bgManager =
    taskComponent?._backgroundTaskManager ?? taskComponent?.backgroundTaskManager;

  return { handleQuery, env, quiet, output, chatEventHandlers, bgManager };
}

export function createChatCommand(): CommandModule<object, ChatOptions> {
  return {
    command: "chat <message>",
    describe: "Send a single message to the agent and get a response (Ink TUI)",
    builder: (yargs) =>
      yargs
        .positional("message", {
          type: "string",
          demandOption: true,
          describe: "The message to send",
        })
        .option("model", {
          alias: "m",
          type: "string",
          describe: MODEL_DESCRIBE,
        })
        // ★ Task #4634：兜底模型（providerId/modelId）
        .option("fallback-model", {
          type: "string",
          describe: FALLBACK_MODEL_DESCRIBE,
        })
        // ★ Task #4724 review2 MINOR-1/MINOR-2：非法的显式兜底值
        //   在**参数解析阶段**就报错退出，不静默放行。
        .check(checkFallbackModelArg)
        .option("system-prompt", {
          alias: "s",
          type: "string",
          describe: "System prompt override",
        })
        .option("workdir", {
          alias: "w",
          type: "string",
          describe: "Working directory",
          default: process.cwd(),
        })
        .option("max-lines", {
          type: "string",
          describe: "Truncate response to N lines (0 = unlimited)",
          default: "500",
        })
        .option("markdown", {
          type: "boolean",
          describe: "Render markdown (default: true)",
          default: true,
        })
        .option("plugins", {
          alias: "p",
          type: "string",
          array: true,
          describe: "Enable plugins",
        })
        .option("config", {
          type: "string",
          describe: "Path to config file",
        })
        .option("env", {
          type: "string",
          describe: "Environment name",
        }),
    handler: async (argv) => {
      if (argv.markdown === false) {
        setMarkdownEnabled(false);
      } else {
        setMarkdownEnabled(true);
      }
      const maxLines = Number.parseInt(argv.maxLines ?? "500", 10);
      const { handleQuery, env, quiet, output, chatEventHandlers, bgManager } =
        await loadHandleQuery(argv);

      const { waitUntilExit } = render(
        React.createElement(ChatScreen, {
          handleQuery,
          message: argv.message,
          model: argv.model,
          workdir: argv.workdir,
          maxLines,
          markdownEnabled: argv.markdown !== false,
        }),
        { exitOnCtrlC: true }
      );

      try {
        // ★ Task #4571（Q4）：等本轮启动的后台任务结束，再退出。
        //
        // 为什么必须等（真机实测时序）：
        //   20:47:57  task.background.started   ← delegate 刚启动子任务
        //   20:48:00  ChatTui 拿到回复 → exit() ← 进程 process.exit(0)
        //   （无 completed / timeout / failed）  ← 子任务被一起带走，从未跑到终态
        //
        // 结果：agent 对用户说的「任务已启动，完成后会自动通知你」是**假话** ——
        //   进程都没了，既不会有通知，子 agent 也被 SIGTERM。
        //
        // 为什么是「有界等待」而不是持久后台化：
        //   chat 是**一次性命令**（`chat <message>` 语义 = 问一句、拿答案、退）。
        //   真要持久化得把子任务 detach 成独立进程，那是另一个量级的改动。
        //   这里选择：最多等 DEFAULT_CHAT_WAIT_TIMEOUT_MS（30s），
        //   超时就**明确告知**用户「仍在后台跑 + 怎么查」，绝不静默。
        // ⚠️ 真机 + 交叉验证双重抓到的回归（我在本 commit 里误删了这一行）：
        //   没有它 render() 返回后立刻进 finally → process.exit(0) →
        //   ChatTui 的 useEffect 还没跑完，**用户什么都看不到**。
        //   它是 chat 的"主等待"：等 Ink 把整轮问答复完、ChatTui 自己
        //   `setTimeout(() => exit(), 100)` 触发退出。
        //   ★ 必须排在后台任务等待**之前** —— 否则 UI 还没渲染就先等后台了。
        await waitUntilExit();

        // ★ 用 probe 而不是 hasUnfinishedTasks：要能区分「没有任务」与
        //   「查不出来」。后者若静默跳过等待，就回到"后台任务被 exit 掐死"的
        //   原始 bug，而且用户完全不知道（交叉验证 MEDIUM）。
        const bgProbe = probeUnfinishedTasks(bgManager);

        if (bgProbe.queryFailed) {
          process.stderr.write(
            `⚠️ 无法查询后台任务状态（${bgProbe.error ?? "unknown"}）—— ` +
              `若本次启动过后台任务，它会在进程退出时被中断。\n`,
          );
        } else if (
          bgProbe.hasAnyTask === true ||
          bgProbe.unfinished ||
          bgProbe.awaitingUser ||
          chatEventHandlers.isBusy()
        ) {
          // ★ 交叉验证 N1（M2 外层修复）：真正放宽到「**存在任何任务**」。
          //
          //   上一版写的是 `unfinished || awaitingUser || isBusy()`，注释却说
          //   已放宽到"存在任何任务" —— **注释与代码不符**，而剩下的那个洞正是
          //   M2 本体：
          //
          //     t0  task.status = "completed"        ← 记录还在，但 unfinished=false
          //     t1  await resolveAssociatedTaskId…   ← 窗口
          //     t2  publishBackgroundEvent()         ← handleEvent 不 await
          //     t3  … formatEvent → enqueue          ← 队列才非空
          //
          //   在 [t0, t3) 内三个旧判据**全为 false** → 跳过整个等待块 → exit(0)
          //   → 通知丢失。`hasAnyTask` 用"记录是否还在"判定，能跨过这个窗口。
          //
          //   为什么不担心挂住：`waitForBackgroundTasks` 内部有 30s 上限，
          //   最坏情况只是多等一会儿然后如实报告。**宁可多等，不可漏通知**。
          // ★ Task #4576：`isBusy()` 也必须进来。
          //
          //   时序：后台任务可能已经跑到终态（`listTasks()` 空了），但
          //   EventHandler 刚收到 `task.background.completed` 正在跑**通知轮
          //   agent**。这条路径下 `bgProbe.unfinished === false`，若不看
          //   `isBusy()` 就会直接跳过等待 → `process.exit(0)` 把通知轮腰斩。
          // ⚠️ 为什么用 process.stderr.write 而不是 output.info：
          //
          //   `OutputService.info/success/warn` 在 quiet 模式（**默认**）下
          //   全部是 no-op（见 output.service.ts:55/71/80 的 `if (!this.quiet)`）。
          //   真机实测：delegate 成功、task.background.completed 也真的到了，
          //   但用户**一条等待提示都看不到** —— 静默等待 13s 和卡死无法区分。
          //
          //   这里写 stderr 的理由与 Task #4568 的 `[Trigger]` 一致：
          //     - 不污染 stdout（答案正文 / 管道解析）
          //     - Ink 独占 stdout 做整帧重绘，stderr 不会破坏布局
          //     - 用户 `2>/dev/null` 可静默
          const notice = (msg: string) => {
            try {
              process.stderr.write(`${msg}\n`);
            } catch {
              // 终端已关闭等极端情况：忽略，绝不影响主流程
            }
          };

          // ★ 交叉验证 L7：这句话不能只说"有后台任务在跑" —— 走进来也可能
          //   只是因为 handler 还在处理通知（此时没有后台任务在跑，说了就是假话）。
          notice(
            `⏳ 有后台任务或通知正在处理，等待完成（最多 ${Math.round(DEFAULT_CHAT_WAIT_TIMEOUT_MS / 1000)}s）…`,
          );
          const waited = await waitForBackgroundTasks(bgManager, {
            timeoutMs: DEFAULT_CHAT_WAIT_TIMEOUT_MS,
            // ★ Task #4576（Q1）：把 EventHandler 的忙碌也算进等待。
            //
            //   为什么 listTasks() 不够：EventHandler 的通知轮 agent run **不注册成
            //   background task**，轮询完全看不见它。若不等，`process.exit(0)` 会把
            //   通知轮腰斩 —— 输出丢失（这正是「event 进 agent」在 chat 上唯一的
            //   落地风险，见设计 Q4）。
            isExtraBusy: () => chatEventHandlers.isBusy(),
            // ★ 交叉验证 M2：判定"全清"前要求连续 300ms 都空闲。
            //
            //   `task.status = "completed"` 早于 `publishBackgroundEvent()`，中间
            //   还夹着一个 await。若首发探测正落在那个窗口里，`listTasks()` 空了、
            //   handler 队列也还空着 —— 两路同时报"没事了"，于是跳过等待直接
            //   exit(0)，通知丢失。
            //
            //   ⚠️ 交叉验证 LOW-4：settle 检查只发生在**轮询边界**上，而默认
            //   pollIntervalMs 是 500ms —— 所以 300 的实际保证窗口 = 一个轮询
            //   周期（500ms > 300ms），并不是 300ms。为避免"注释描述 300ms、
            //   代码按 500ms 生效"的错位，这里显式写明：保证窗口 ≈ 一个轮询周期，
            //   300ms 只是在**更短轮询间隔**下才会成为约束。
            settleMs: 300,
            onTick: (elapsed) => {
              // 每 10s 报一次，避免用户以为卡死（30s 内最多 3 条）
              if (elapsed > 0 && elapsed % 10_000 < 500) {
                notice(`⏳ 仍在等待后台任务…（${Math.round(elapsed / 1000)}s）`);
              }
            },
          });

          // ★ 按 outcome 三方态渲染（交叉验证 MEDIUM #1）：
          //   `finished: true` **不等于**"成功完成" —— 任务可能停在
          //   `awaiting-user`（暂停等输入）。把它报成"✅ 已完成"就是撒谎，
          //   而 chat 根本没渠道让它继续。所以必须分开三种说法。
          const secs = Math.round(waited.waitedMs / 1000);

          // ★ 交叉验证 NEW-1 / NEW-2（round 4）：**先**把"任务失败"这个事实说出来，
          //   再走结局分支。
          //
          //   为什么不能放在链尾：`failed` 会被更靠前的 awaiting-user /
          //   stillBusyOnly / stillRunning 三个分支抢先匹配 —— 那样用户只会看到
          //   「停在等输入」或「未结束」，**永远不知道有任务挂了**。
          //   失败是最重要的事实，不能因为分支顺序被吞。
          if (waited.failed) {
            notice(
              `⚠️ 有后台任务未成功完成（失败 / 超时 / 已停止）。`,
            );
          }

          if (waited.queryFailed || waited.outcome === "unknown") {
            // 轮询途中/收尾时查询炸了 —— 不确定还剩什么，如实说
            process.stderr.write(
              `⚠️ 等待期间无法查询后台任务状态（${waited.error ?? "unknown"}），` +
                `已停止等待。若仍有任务在跑，它会随进程退出而中断。\n`,
            );
          } else if (waited.outcome === "awaiting-user") {
            // ★ 关键修正：不能报"已完成"，也不能说"还在跑"
            notice(
              `⚠️ 后台任务停在「等待用户输入」（ask_user），不是已完成。`,
            );
            notice(
              `  chat 是一次性命令，没有渠道让它继续 —— 该任务**不会**再产生通知。` +
                `如需回答它并续跑，请改用 \`roy-bot run\`（REPL，常驻）。`,
            );
          } else if (waited.stillBusyOnly) {
            // ★ Task #4576：后台任务其实**全都结束了**，只是 handler 的通知轮
            //   还没跑完。绝不能报成「后台任务未结束」—— 那是撒谎。
            notice(
              `⚠️ 后台任务已全部结束，但处理其通知的 agent 在 ${secs}s 内未完成，` +
                `进程即将退出。`,
            );
            notice(
              "  如需完整接管通知，请改用 `roy-bot run`（REPL，常驻）。",
            );
          } else if (!waited.finished && waited.stillRunning) {
            // ★ 超时也要说真话：不能假装任务已完成，也不能假装还会有通知
            notice(
              `⚠️ 后台任务在 ${secs}s 内未结束，` +
                `进程即将退出 —— 该任务**不会**再产生通知（chat 是一次性命令）。`,
            );
            notice(
              "  如需后台长期运行，请改用 `roy-bot run`（REPL，常驻）" +
                " 或 `roy-bot interactive`。",
            );
          } else if (waited.failed || waited.outcome === "failed") {
            // 失败事实已在上面统一说过；这里只补操作指引，避免重复刷屏。
            notice(
              "  可用 `roy-bot tasks list` / `query_background_process` 查看详情。",
            );
          } else if (
            waited.outcome === "settled" &&
            waited.finished &&
            // ★ 交叉验证 NEW-4：还要求"证明成功"（所有任务明确 completed），
            //   不能只凭"没有活跃任务"就报成功 —— 未知状态会被误报成已完成。
            waited.stillRunning === false
          ) {
            // ★ 交叉验证 LOW-1：只有**明确 settled 且 finished** 才敢报成功。
            //   原来这里是 else，会让 `outcome:"timeout"` + `stillRunning:false`
            //   （任务恰好在 30s 边界翻到终态）也打印「✅ 已完成」。
            notice(`✅ 后台任务已完成（等待 ${secs}s）`);
          } else {
            // 剩下的情况（边界 timeout / 未知组合）：不知道就别假装知道
            notice(
              `⚠️ 未能确认后台任务已全部完成（等待 ${secs}s，结局 ${waited.outcome ?? "unknown"}）。`,
            );
          }
        }
      } finally {
        // ★ Task #4576：先停 handler 再退出。
        //
        //   不 stop 直接 exit，in-flight 的 processItem 里那一轮 agent 会被
        //   SIGTERM 腰斩（与 #4571 修的「后台任务被 exit 掐死」同类问题）。
        //   stop() 自身幂等且不抛，放在 exit 之前是唯一的正确时机。
        try {
          chatEventHandlers.stop();
        } catch {
          // stop 内部已兜底；这里再兜一层，绝不允许阻止进程退出
        }
        process.exit(0);
      }
    },
  };
}

export const ChatCommand = createChatCommand();