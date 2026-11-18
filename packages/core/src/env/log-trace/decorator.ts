/**
 * @fileoverview @Traced 装饰器实现
 * 
 * 提供函数包装和装饰器来自动创建 Span
 * 支持注解到 async 函数和非 async 函数上
 * 使用 OpenTelemetry 标准方式
 */

import { getTracerProvider, type OTelTracer, type OTelSpan } from "./opentelemetry/tracer-provider";
import { createLogger, simplifyFilePath, getMaxOutput } from "./logger";
import { isTraceFullMode } from "./trace-filters";

export interface TracedOptions {
  name?: string;
  recordParams?: boolean;
  /**
   * ★ 2026-10-22：**result 是否写进 DB**（默认 **true** = 写）。
   *
   * 为什么默认是 true：单个返回值通常并不大，真正把 traces.db 撑到 169GB 的是
   * **不断累积的入参**（每轮 LLM 请求都带完整 system prompt + 全量历史）。
   * 所以默认保留 result（不改变既有调用方的数据可见性），瘦身交给
   * `paramFilter` / `resultFilter`：需要截断的 span 显式声明摘要即可。
   *
   * 现在的语义：
   * - 有 `resultFilter` → 存 filter 产出的摘要（filter 失效时退回本选项裁决）
   * - `recordResultToDb: true` → 强制存**完整** result（优先于 resultFilter）
   * - 否则按本选项：`true`（默认）存完整 result / `false` 显式不存
   *
   * 「日志里要不要打」由 `logResult` 单独控制，与本选项解耦。
   */
  recordResult?: boolean;
  /**
   * ★ 2026-10-22：**强制把完整 result 写进 DB**，即使 `recordResult: false`。
   *
   * 背景：`recordResult` 原本只控制日志，DB 里始终存全量 result，导致
   * traces.db 膨胀到 169GB。修复后 `recordResult: false` 意味着「不入库」，
   * 但少数场景确实需要完整返回值（例如把 result 当业务数据读的下游）。
   * 这些场景用本选项显式声明 —— **默认不存，需要就显式开**。
   */
  recordResultToDb?: boolean;
  /**
   * ★ 2026-10-22：**日志里是否打印 result**（与「DB 存不存」解耦）。
   *
   * 背景：改造前 `recordResult` 同时控制日志与 DB。DB 瘦身时把它改成 false，
   * 会连带让 app.log 里的 LLM 响应消失 —— DB 省了体积，排障能力也一起没了。
   *
   * 语义：不设时跟随 `recordResult`（向后兼容）；
   * 显式设 `true` 可实现「DB 不存完整 result，但日志照打」。
   */
  logResult?: boolean;
  recordError?: boolean;
  log?: boolean;
  maxLogSize?: number;
  paramFilter?: (args: any[], argNames?: string[]) => Record<string, any>;
  /**
   * result filter —— 把返回值压成一份**摘要**。
   *
   * 摘要的键会被摊平到 span 的顶层属性（便于 `debug trace` 直接看字段），
   * ⚠️ **同时它就是 DB 里 `result` 列的内容** —— 也就是说这个 filter 不只是
   * 「额外加几个属性」，它**替换**了原本要存的完整返回值。
   *
   * 想保留完整 result，请显式设 `recordResultToDb: true`（它优先于本 filter）。
   *
   * 若 filter 抛异常或没有返回可用对象，会**退回** `recordResult` 的裁决，
   * 不会静默丢掉调用方明确要求记录的 result。
   */
  resultFilter?: (result: any) => Record<string, any>;
  /**
   * NEW: when true (default false), spread paramFilter output keys to top-level
   * attributes in addition to attributes['params']. Used to expose named
   * parameter fields (e.g. serverIds, workspaceRoot) for cli-e2e-test.
   */
  flattenParamFilter?: boolean;
  /**
   * NEW: 返回值驱动的 ERROR 状态。
   *
   * 返回 Error（或任意 truthy）→ 即使函数**正常返回**，也把 span 标成 ERROR；
   * 返回 undefined / null / false → 保持 OK。
   *
   * 解决什么：有些 API 用返回值而不是抛异常来表达失败，例如工具执行返回
   * `{ success: false, error: "Tool not found: bash" }`。旧行为下 span.status
   * 仍是 `ok`（错误只落在 result 属性里），`roy-bot debug trace --list`
   * 聚合出来的 status 全是 ok —— 2026-10-16 的空 checkpoint 事故就是这样
   * 静默了几周，直到人工翻 25GB trace DB 才发现。
   *
   * 为什么不用抛异常：ReAct 循环需要把失败作为 tool result 回灌给模型
   * （AI SDK v6 要求 tool-call / tool-result 1:1 配对）。抛异常会破坏配对，
   * 所以只能在「返回值已是失败」的前提下补一个 span 状态。
   */
  errorIf?: (result: any) => Error | string | undefined | null | false;
}

/**
 * @Traced 装饰器工厂
 *
 * 同时支持两种调用约定，避免 toolchain 差异导致崩溃：
 *   1. Legacy（TS experimentalDecorators）: (target, propertyKey, descriptor)
 *      — 改写 descriptor.value，返回 descriptor。
 *   2. Standard（TC39 / Bun __decorateElement）: (value, context)
 *      — 返回包装后的函数；context.name 作为默认 span 名。
 *
 * 背景：同一 tsconfig（experimentalDecorators: true）下，Bun 对个别文件
 * （如 event-store.ts）会走 standard 装饰器路径，只传 2 个参数，导致旧实现
 * `descriptor.value` 读到 undefined 崩溃。
 */
export function Traced(options?: TracedOptions) {
  const buildOptions = () => ({
    recordParams: options?.recordParams ?? true,
    recordResult: options?.recordResult ?? false,
    recordResultToDb: options?.recordResultToDb ?? false,
    logResult: options?.logResult,
    recordError: options?.recordError ?? true,
    log: options?.log ?? false,
    maxLogSize: options?.maxLogSize,
    paramFilter: options?.paramFilter,
    resultFilter: options?.resultFilter,
    flattenParamFilter: options?.flattenParamFilter,
    errorIf: options?.errorIf,
  });

  return function (target: any, propertyKey?: any, descriptor?: any) {
    // ---- Legacy: (target, propertyKey, descriptor) ----
    if (
      descriptor !== undefined &&
      descriptor !== null &&
      typeof descriptor === "object" &&
      "value" in descriptor
    ) {
      const originalFn = descriptor.value;
      const spanName = options?.name || String(propertyKey);
      descriptor.value = wrapFunction(originalFn, spanName, buildOptions());
      return descriptor;
    }

    // ---- Standard: (value, context) ----
    const value = target;
    const context = propertyKey || {};
    if (typeof value === "function") {
      const spanName =
        options?.name || (context?.name ? String(context.name) : "anonymous");
      return wrapFunction(value, spanName, buildOptions());
    }
    // 非方法（field/accessor）暂不支持：原样返回，避免抛错。
    return value;
  };
}

/**
 * @TracedAs 装饰器工厂 - 使用自定义名称
 */
export function TracedAs(name: string, options?: Omit<TracedOptions, "name">) {
  return Traced({ name, ...options });
}

/**
 * @TracedLightweight 装饰器工厂 - 轻量级追踪
 */
export function TracedLightweight(options?: { log?: boolean; maxLogSize?: number }) {
  return Traced({ recordParams: false, recordResult: false, log: options?.log ?? false, maxLogSize: options?.maxLogSize });
}

/**
 * 包装函数以自动创建 Span
 * 
 * 同时支持 async 函数和非 async 函数：
 * - async 函数：自动检测 Promise 并正确处理
 * - 非 async 函数：同步执行，直接返回结果
 */
export function wrapFunction<T extends (...args: any[]) => any>(
  fn: T,
  name: string,
  options?: {
    recordParams?: boolean;
    recordResult?: boolean;
    recordResultToDb?: boolean;
    logResult?: boolean;
    recordError?: boolean;
    log?: boolean;
    maxLogSize?: number;
    paramFilter?: (args: any[], argNames?: string[]) => Record<string, any>;
    resultFilter?: (result: any) => Record<string, any>;
    flattenParamFilter?: boolean;
    errorIf?: (result: any) => Error | string | undefined | null | false;
  }
): T {
  // ★ 2026-10-22：**在这里归一化默认值**，而不是只在 `Traced()` 里做。
  //
  // 背景：`wrapFunction` 可以被直接调用（CLI 的 workflow 命令就用了 5 处），
  // 这时 options 是调用方原样传入的裸对象。归一化后两条入口行为完全一致：
  // 不传 `recordResult` 时一律按默认 **true**（存 result），显式 `false` 才跳过。
  const opts = {
    recordParams: options?.recordParams ?? true,
    recordResult: options?.recordResult ?? true,
    recordResultToDb: options?.recordResultToDb ?? false,
    logResult: options?.logResult,
    recordError: options?.recordError ?? true,
    log: options?.log ?? false,
    maxLogSize: options?.maxLogSize,
    paramFilter: options?.paramFilter,
    resultFilter: options?.resultFilter,
    flattenParamFilter: options?.flattenParamFilter ?? false,
    errorIf: options?.errorIf,
  };
  const shouldLog = opts.log;

  const getMaxLogSize = (): number => {
    if (opts.maxLogSize !== undefined) {
      return opts.maxLogSize;
    }
    const configMaxOutput = getMaxOutput();
    return configMaxOutput !== undefined ? configMaxOutput : 500;
  };

  const truncate = (obj: any): any => {
    if (obj === undefined) return undefined;
    if (obj === null) return null;
    
    const maxLogSize = getMaxLogSize();
    let str: string;
    try {
      str = typeof obj === "string" ? obj : JSON.stringify(obj, null, 0).replace(/\n/g, "");
    } catch (e) {
      str = `[Object with circular reference: ${e instanceof Error ? e.message : String(e)}]`;
    }
    if (maxLogSize > 0 && str.length > maxLogSize) {
      return str.slice(0, maxLogSize) + " [TRUNCATED]";
    }
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  };

  const truncateString = (obj: any): string => {
    if (obj === undefined) return "undefined";
    if (obj === null) return "null";
    
    const maxLogSize = getMaxLogSize();
    let str: string;
    try {
      str = typeof obj === "string" ? obj : JSON.stringify(obj, null, 0).replace(/\n/g, "");
    } catch (e) {
      str = `[Object with circular reference: ${e instanceof Error ? e.message : String(e)}]`;
    }
    return maxLogSize > 0 && str.length > maxLogSize ? str.slice(0, maxLogSize) + " [TRUNCATED]" : str;
  };

  /**
   * ★ 2026-10-16：**DB attribute 专用**序列化 —— 永不截断。
   *
   * 背景：`truncate()` 原先同时服务两个用途：
   *   1. 写入 DB 的 span attributes（params / result / resultFilter）
   *   2. 写日志行（logFn → truncateString）
   * 二者共用一个 `maxOutput`（默认 5000）上限，导致 DB 里的 params/result
   * **在写入时就被截断**，事后无论用 `debug trace` / `debug span` / 直接查 sqlite
   * 都只能看到 `[TRUNCATED]` 标记，无法分析问题。
   *
   * 现在的分工：
   *   - `toDbValue()`  → DB attributes：**完整保留**（含换行；只做循环引用兜底）
   *   - `truncate()` / `truncateString()` → 日志输出：仍受 `maxLogSize` 限制
   *     （否则 app.log 会被 system prompt / 消息历史刷爆）
   *
   * 注意：本改动会让 spans.db / traces.db 显著增大 —— 单条
   * `agent.component.invokeLLM` 的 params 就包含完整 system prompt + 全量 messages。
   * 需要配套的清理/保留策略（见 commit message）。
   */
  const toDbValue = (obj: any): any => {
    if (obj === undefined) return undefined;
    if (obj === null) return null;
    // 字符串原样保留（不 replace 换行、不切片）
    if (typeof obj === "string") return obj;
    try {
      // 归一化：去掉 undefined / 函数等非 JSON 值；保留换行（存进 JSON 字符串时会被转义）
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      return `[Object with circular reference: ${e instanceof Error ? e.message : String(e)}]`;
    }
  };

  const TRACE_LOG_PREFIX = "[TRACE]";

  /**
   * ★ 2026-10-22：**安全地跑一个 filter —— 失败时「放行」（fail-open）。
   *
   * 为什么必须这样：`paramFilter` / `resultFilter` 是**用户提供的回调**。
   * 改造前 resultFilter 的异常只会让 span 少几个属性；改造后它参与了
   * 「result 是否入库」的裁决，如果它抛异常：
   * - async 路径：异常发生在 `.then()` 里 → **业务成功的调用变成 rejected promise**
   * - sync 路径：异常直接冒泡 → 被装饰的业务函数失败
   *
   * 也就是说，**一个 tracing 辅助函数的 bug 会让业务代码挂掉** ——
   * 这是绝对不能接受的。trace 只是观测手段，绝不能影响主流程。
   *
   * 失败时返回 `undefined`（= 没有摘要），让上层按「无 filter 产物」处理：
   * 上层逻辑会退回到 recordResult / recordResultToDb 的默认裁决，不丢数据、
   * 不改变业务语义，同时把异常记到日志里便于排查。
   */
  const safeRunFilter = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      try {
        createLogger("traced:" + name).warn(
          `[trace] filter threw, ignoring: ${e instanceof Error ? e.message : String(e)}`,
        );
      } catch {
        // 日志本身失败也不能影响业务
      }
      return undefined;
    }
  };

  /**
   * ★ 2026-10-22：**决定「DB 里存什么 result」**。
   *
   * 背景：改造前 `recordResult` 只影响**日志**输出，`attributes['result']`
   * 和 `result` 列是**无条件全量写入**的；而 traces.db 一度膨胀到 169GB 的主因其实是
   * **不断累积的 params**（每轮 LLM 请求都带完整 system prompt + 全量历史），
   * 单个返回值通常不大。
   *
   * 因此默认 **保留 result**（不改变既有调用方的可见性），瘦身靠 filter：
   *   1. 有 `resultFilter` → 存**过滤后的摘要**（resultFilter 的产物即 DB 里的 result）
   *   2. 无 `resultFilter` 且 `recordResult === false` → **完全不存** result（显式选择）
   *   3. 其余（含默认 `recordResult: true`）→ 存完整 result
   *
   * ⚠️ 逃逸阀：`recordResultToDb: true` 可强制存完整 result（优先于 filter，
   * 用于「既要 filter 摊平字段、又要完整返回值」的少数场景）。
   */
  const resolveDbResult = (
    result: any,
    precomputedFiltered?: { ran: boolean; value: Record<string, any> | undefined },
  ): { value: any; store: boolean } => {
    // ★ 2026-10-22 修复：`recordResultToDb` 必须**先于** `resultFilter` 判断。
    //
    // 原顺序（filter 在前）导致：只要 span 带了 resultFilter，
    // `recordResultToDb: true` 就永远走不到 —— 逃逸阀形同虚设，
    // 恰恰在最需要它的场景（既有 filter 又要完整 result）失效。
    if (opts.recordResultToDb === true) {
      return { value: result, store: true };
    }
    // ★ 2026-10-22 修复：全量模式必须能恢复 **result**，而不只是 params。
    //
    // 原实现里全量逻辑只存在于 filter 函数内部（filter 返回 { args }），
    // 而 result 的去留由本函数决定 —— 于是 `ROY_TRACE_FULL=1` 对
    // 「recordResult:false 且无 resultFilter」的 span 无效：
    // params 恢复了，result 仍然是 null。文档承诺的「不改代码即可全量排查」
    // 因此是假的。
    if (isTraceFullMode()) {
      return { value: result, store: true };
    }
    if (opts.resultFilter) {
      // 优先用调用方已经算好的 filter 产物，避免 filter 在每个 span 上跑两遍。
      //
      // ⚠️ 两个坑在这里一起处理：
      // 1) filter 抛异常 → 调用方已跑过一次并标记了 ran:true，
      //    这里**不能**再调一次（那会让 filter 每个 span 跑两遍）
      // 2) filter 没产出可用摘要（抛异常 / 返回非对象 / 返回数组）时，
      //    **不能**直接判定「不存」—— 那样 recordResult:true 想要的完整 result
      //    会被静默丢掉。应继续往下走 recordResult 的裁决。
      const filtered = precomputedFiltered?.ran
        ? precomputedFiltered.value
        : safeRunFilter(() => opts.resultFilter!(result));
      if (filtered && typeof filtered === "object" && !Array.isArray(filtered)) {
        return { value: filtered, store: true };
      }
      // filter 没给出可用摘要 → 落到下面的 recordResult 裁决
    }
    if (opts.recordResult === false) {
      return { value: undefined, store: false };
    }
    return { value: result, store: true };
  };


  const getCallerLocation = (): string => {
    const originalLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 15;
    const err = new Error();
    Error.captureStackTrace(err, getCallerLocation);
    const stack = err.stack?.split("\n") || [];
    Error.stackTraceLimit = originalLimit;

    for (let i = 1; i < stack.length; i++) {
      const line = stack[i];
      if (line.includes("decorator.ts") || line.includes("decorator.js") || line.includes("logFn") || line.includes("getCallerLocation")) continue;
      const match = line.match(/at\s+.+\s+\((.+):(\d+):\d+\)/) || line.match(/at\s+(.+):(\d+):\d+/);
      if (match) {
        const filePath = match[1];
        if (!filePath || filePath === "native") continue;
        const relativePath = simplifyFilePath(filePath);
        return `${relativePath}:${match[2]}`;
      }
    }
    return "";
  };

  const logFn = (event: "enter" | "quit" | "error", argsOrData?: any, callerLocation?: string) => {
    if (!shouldLog) return;
    const logger = createLogger("traced:" + name);

    const tag = event === "enter" ? ">>>" : event === "quit" ? "<<<" : "!!!";
    const prefix = `${TRACE_LOG_PREFIX} ${tag} ${name}`;
    const originalFnLocation = callerLocation || getCallerLocation();

    const logMessage = (msg: string, data?: any) => {
      if (data !== undefined) {
        logger.info(`${prefix} ${msg}: ${truncateString(data)}`, { callerLocation: originalFnLocation });
      } else {
        logger.info(`${prefix} ${msg}`, { callerLocation: originalFnLocation });
      }
    };

    if (event === "enter") {
      logMessage("enter", argsOrData);
    } else if (event === "quit") {
      logMessage("quit", (opts.logResult ?? opts.recordResult) ? argsOrData : undefined);
    } else {
      logMessage("error", argsOrData);
    }
  };

  // 包装函数 - 支持 async 和非 async 函数
  return function(this: any, ...args: any[]) {
    const tracer: OTelTracer = getTracerProvider().getTracer("roy-tracer");

    const attributes: Record<string, any> = {};

    if (opts.recordParams !== false) {
      if (opts.paramFilter) {
        const filtered = safeRunFilter(() => opts.paramFilter!(args));
        attributes["params"] = toDbValue(filtered);
        // NEW: spread paramFilter output to top-level attributes when requested.
        // Lets plan-required named fields (serverIds, workspaceRoot, filePath,
        // serverId, etc.) appear as top-level span attributes for cli-e2e-test.
        if (opts.flattenParamFilter && filtered && typeof filtered === "object" && !Array.isArray(filtered)) {
          for (const [key, value] of Object.entries(filtered)) {
            if (!(key in attributes)) {
              attributes[key] = toDbValue(value);
            }
          }
        }
      } else {
        attributes["params"] = toDbValue(args);
      }
    }

    // 在 enter 时获取调用位置并保存
    const callerLocation = getCallerLocation();
    
    // 启动 OTel Span (错误容忍：如果 span 创建失败，继续执行函数)
    let span: OTelSpan | undefined;
    try {
      span = tracer.startSpan(name, { attributes });
    } catch {
      // Span creation failed, continue without span
    }
    
    logFn("enter", args, callerLocation);

    try {
      const result = fn.call(this, ...args);

      // 处理 Promise
      if (result && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).then(
          (resolved) => {
            if (span) {
              // ★ 2026-10-22：resultFilter 只跑一次 —— 产物同时用于
              //   (a) 摊平到顶层 attributes（既有行为）
              //   (b) 作为 DB 里的 result（替代全量返回值）
              // 之前分成两处调用，filter 会在每个 span 上白跑一倍。
              const filterRan = opts.resultFilter !== undefined;
              const filteredResult = opts.resultFilter
                ? safeRunFilter(() => opts.resultFilter!(resolved))
                : undefined;
              // ⚠️ 谓词必须与 resolveDbResult 一致（都排除数组）：
              // 否则 filter 返回数组时，attributes 会摊平成 {"0":..,"1":..}
              // 而 result 列是 null —— 两边自相矛盾。
              if (
                filteredResult &&
                typeof filteredResult === "object" &&
                !Array.isArray(filteredResult)
              ) {
                for (const [key, value] of Object.entries(filteredResult)) {
                  span.setAttribute(key, toDbValue(value) as any);
                }
              }
              // resultFilter 摘要优先；否则按 recordResult 决定是否入库
              const dbResult = resolveDbResult(resolved, { ran: filterRan, value: filteredResult });
              if (dbResult.store) {
                span.setAttribute('result', JSON.stringify(toDbValue(dbResult.value)));
              }
              // errorIf：返回值驱动的 ERROR 状态（见 TracedOptions.errorIf 注释）
              // ⚠️ 同样必须 fail-open —— errorIf 也是用户提供的回调，
              // 它抛异常时 async 路径会 reject 业务 promise、sync 路径会让业务函数失败。
              const resultError = opts.errorIf
                ? safeRunFilter(() => opts.errorIf!(resolved))
                : undefined;
              if (resultError) {
                const err = resultError instanceof Error
                  ? resultError
                  : new Error(String(resultError));
                span.setAttribute('error', err.message);
                span.end(undefined, err);
              } else {
                span.end(dbResult.store ? dbResult.value : undefined);
              }
            }
            // ★ 2026-10-22：日志与 DB 解耦。
            //
            // 改造前 `recordResult` 同时控制「日志里打不打 result」和「DB 存不存
            // result」（后者其实没生效）。现在 DB 由 recordResult/resultFilter/
            // recordResultToDb 裁决，**日志不应该跟着 DB 一起丢** ——
            // 否则 `recordResult: true → false` 会让 app.log 里也看不到 LLM 响应，
            // 这是排障能力的净损失（DB 省了体积，但日志也没了）。
            //
            // 新的日志开关 `logResult`：默认跟随 recordResult；
            // 需要「DB 不存但日志要打」的 span 显式设 `logResult: true`。
            logFn("quit", (opts.logResult ?? opts.recordResult) ? resolved : undefined, callerLocation);
            return resolved;
          },
          (rejected) => {
            if (span) {
              span.setAttribute('error', String(rejected));
              span.end(undefined, rejected instanceof Error ? rejected : new Error(String(rejected)));
            }
            logFn("error", (rejected as Error).message, callerLocation);
            throw rejected;
          }
        );
      }

      // 同步方法
      if (span) {
        // ★ 2026-10-22：resultFilter 只跑一次（与 async 路径一致）
        const syncFilterRan = opts.resultFilter !== undefined;
        const syncFilteredResult = opts.resultFilter
          ? safeRunFilter(() => opts.resultFilter!(result))
          : undefined;
        // ⚠️ 谓词与 resolveDbResult / async 路径保持一致（都排除数组）
        if (
          syncFilteredResult &&
          typeof syncFilteredResult === "object" &&
          !Array.isArray(syncFilteredResult)
        ) {
          for (const [key, value] of Object.entries(syncFilteredResult)) {
            span.setAttribute(key, toDbValue(value) as any);
          }
        }
        // resultFilter 摘要优先；否则按 recordResult 决定是否入库
        const syncDbResult = resolveDbResult(result, { ran: syncFilterRan, value: syncFilteredResult });
        if (syncDbResult.store) {
          span.setAttribute('result', JSON.stringify(toDbValue(syncDbResult.value)));
        }
        // errorIf：返回值驱动的 ERROR 状态（见 TracedOptions.errorIf 注释）
        // ⚠️ 同样必须 fail-open（与 async 路径一致）
        const syncResultError = opts.errorIf
          ? safeRunFilter(() => opts.errorIf!(result))
          : undefined;
        if (syncResultError) {
          const err = syncResultError instanceof Error
            ? syncResultError
            : new Error(String(syncResultError));
          span.setAttribute('error', err.message);
          span.end(undefined, err);
        } else {
          span.end(syncDbResult.store ? syncDbResult.value : undefined);
        }
      }
      // ★ 2026-10-22：日志与 DB 解耦（见 async 路径的说明）
      logFn("quit", (opts.logResult ?? opts.recordResult) ? result : undefined, callerLocation);
      return result;

    } catch (error) {
      if (span) {
        span.setAttribute('error', String(error));
        span.end(undefined, error instanceof Error ? error : new Error(String(error)));
      }
      logFn("error", (error as Error).message, callerLocation);
      throw error;
    }
  } as T;
}
