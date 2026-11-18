/**
 * @fileoverview 装饰器 result 语义测试（Task #4479）
 *
 * 覆盖 `resolveDbResult` 的完整决策矩阵，以及「resultFilter 只跑一次」的性能约束。
 *
 * 背景：改造前 `recordResult: false` 只影响日志，DB 里始终存全量 result
 * （而且存了两份：attributes.result + result 列）—— 这是 traces.db 膨胀的主因。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapFunction } from "./decorator";
import { getTracerProvider, resetTracerProvider } from "./opentelemetry/tracer-provider";
import { SQLiteSpanStorage } from "./span-storage";
import { setConfigComponent, setLogDirOverride } from "./logger";
import { resetTraceFullModeCache } from "./trace-filters";

/** 在真实 SQLite 里落一个 span 并读回 attributes/result */
async function recordSpan(
  dbPath: string,
  name: string,
  opts: any,
  fn: (...args: any[]) => any,
  ...args: any[]
): Promise<{ attributes: string | null; result: string | null }> {
  const storage = new SQLiteSpanStorage(dbPath);
  await storage.initialize();
  (getTracerProvider() as any).storage = storage;

  const wrapped = wrapFunction(fn, name, opts);
  await wrapped(...args);
  await new Promise((r) => setTimeout(r, 250));

  const db = new Database(dbPath, { readonly: true });
  const row = db.query("SELECT attributes, result FROM span WHERE name = ? LIMIT 1").get(name);
  db.close();
  return { attributes: row?.attributes ?? null, result: row?.result ?? null };
}

describe("装饰器 result 入库语义", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    resetTracerProvider();
    dir = mkdtempSync(join(tmpdir(), "trace-result-sem-"));
    dbPath = join(dir, "traces.db");
  });

  afterEach(() => {
    resetTracerProvider();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("recordResult:false 且无 filter → result 完全不入库（改造前的 bug）", async () => {
    const row = await recordSpan(
      dbPath,
      "sem.no-result",
      { recordResult: false },
      async () => ({ big: "x".repeat(50_000) }),
    );
    expect(row.result === null || row.result === "").toBe(true);
    expect((row.attributes ?? "").includes("result")).toBe(false);
  });

  test("recordResult:true → result 照旧入库（向后兼容）", async () => {
    const row = await recordSpan(
      dbPath,
      "sem.with-result",
      { recordResult: true },
      async () => ({ value: "hello" }),
    );
    expect(row.result).toBeTruthy();
    expect(row.result).toContain("hello");
  });

  test("recordResultToDb:true → 即使 recordResult:false 也存全量（逃逸阀）", async () => {
    const row = await recordSpan(
      dbPath,
      "sem.escape-hatch",
      { recordResult: false, recordResultToDb: true },
      async () => ({ value: "keep-me" }),
    );
    expect(row.result).toBeTruthy();
    expect(row.result).toContain("keep-me");
  });

  test("resultFilter 存在 → result 列存的是摘要，不是全量", async () => {
    const row = await recordSpan(
      dbPath,
      "sem.filtered",
      {
        recordResult: false,
        resultFilter: (r: any) => ({ size: r.text.length }),
      },
      async () => ({ text: "y".repeat(80_000) }),
    );
    expect(row.result).toBeTruthy();
    expect(row.result).toContain("size");
    expect(row.result).not.toContain("y".repeat(1000));
  });

  test("默认 recordResult:true + resultFilter → 仍只存摘要（默认值不会让 filter 失效）", async () => {
    const row = await recordSpan(
      dbPath,
      "sem.filtered-default",
      { resultFilter: (r: any) => ({ size: r.text.length }) },
      async () => ({ text: "w".repeat(80_000) }),
    );
    expect(row.result).toContain("size");
    expect(row.result ?? "").not.toContain("w".repeat(1000));
  });

  test("resultFilter 的产物同时摊平到顶层 attributes", async () => {
    const row = await recordSpan(
      dbPath,
      "sem.flatten",
      {
        recordResult: false,
        resultFilter: (r: any) => ({ size: r.text.length }),
      },
      async () => ({ text: "z".repeat(1000) }),
    );
    const attrs = JSON.parse(row.attributes ?? "{}");
    expect(attrs.size).toBe(1000);
  });

  test("resultFilter 每个 span 只调用一次（不在 async/sync 路径各跑一遍）", async () => {
    let calls = 0;
    const opts = {
      recordResult: false,
      resultFilter: (r: any) => {
        calls++;
        return { n: r.n };
      },
    };

    // async 路径
    calls = 0;
    await recordSpan(dbPath, "sem.calls-async", opts, async () => ({ n: 1 }));
    expect(calls).toBe(1);

    // sync 路径
    calls = 0;
    await recordSpan(dbPath, "sem.calls-sync", opts, () => ({ n: 2 }));
    expect(calls).toBe(1);
  });

  test("resultFilter 返回非对象 → 不入库（不炸）", async () => {
    const row = await recordSpan(
      dbPath,
      "sem.bad-filter",
      { recordResult: false, resultFilter: (() => "not-an-object") as any },
      async () => ({ value: 1 }),
    );
    expect(row.result === null || row.result === "").toBe(true);
  });

  test("没有 recordResult 选项时（默认 true）→ result 照旧入库", async () => {
    const row = await recordSpan(dbPath, "sem.default", {}, async () => ({ value: "x" }));
    expect(row.result ?? "").toContain("x");
  });

  // ─────────────────────────────────────────────────────────────
  // 下面 3 个是交叉验证（claude-minimax）发现的真 bug 的回归防护
  // ─────────────────────────────────────────────────────────────

  test("BUG-1 回归：recordResultToDb 逃逸阀在**有 resultFilter** 时也必须生效", async () => {
    // 原实现里 resultFilter 分支在前，recordResultToDb 永远走不到 ——
    // 逃逸阀形同虚设，恰恰在最需要它的场景失效。
    const row = await recordSpan(
      dbPath,
      "sem.escape-with-filter",
      {
        recordResult: false,
        recordResultToDb: true,
        resultFilter: (r: any) => ({ n: r.n }),
      },
      async () => ({ n: 42, payload: "q".repeat(50_000) }),
    );
    // 存的是**完整** result（含 50KB payload），不是 filter 摘要
    expect(row.result ?? "").toContain("q".repeat(1000));
    expect(row.result ?? "").toContain("42");
  });

  test("BUG-3 回归：ROY_TRACE_FULL=1 时 result 也要恢复（不只是 params）", async () => {
    // 原实现里全量逻辑只在 filter 内部，result 的去留由 resolveDbResult 决定 ——
    // 于是「recordResult:false 且无 resultFilter」的 span，params 恢复了但 result 仍为 null，
    // 文档承诺的「不改代码即可全量排查」是假的。
    process.env.ROY_TRACE_FULL = "1";
    resetTraceFullModeCache();
    try {
      const row = await recordSpan(
        dbPath,
        "sem.full-mode-result",
        { recordResult: false }, // 无 resultFilter
        async () => ({ payload: "z".repeat(20_000) }),
      );
      expect(row.result ?? "").toContain("z".repeat(1000));
    } finally {
      delete process.env.ROY_TRACE_FULL;
      resetTraceFullModeCache();
    }
  });

  test("BUG-4 回归：filter 抛异常不能拖垮被装饰的业务函数（fail-open）", async () => {
    // 原实现里 resultFilter 的异常发生在 async 路径的 .then() 里 →
    // 业务成功的调用变成 rejected promise。trace 只是观测手段，绝不能影响主流程。
    const boom = () => {
      throw new Error("filter boom");
    };

    // async 路径：必须正常 resolve
    const asyncValue = await recordSpan(
      dbPath,
      "sem.filter-throws-async",
      { recordResult: false, resultFilter: boom },
      async () => ({ ok: true }),
    );
    expect(asyncValue).toBeTruthy();

    // sync 路径：必须正常返回
    const syncValue = await recordSpan(
      dbPath,
      "sem.filter-throws-sync",
      { recordResult: false, resultFilter: boom },
      () => ({ ok: true }),
    );
    expect(syncValue).toBeTruthy();

    // paramFilter 抛异常也不能让业务函数失败
    const paramBoom = await recordSpan(
      dbPath,
      "sem.param-filter-throws",
      { paramFilter: boom },
      async () => ({ ok: true }),
    );
    expect(paramBoom).toBeTruthy();
  });

  test("CV-2 回归：errorIf 抛异常也不能拖垮业务函数（fail-open）", async () => {
    // errorIf 也是用户提供的回调，原实现是裸调用的 ——
    // async 路径里它抛异常会 reject 业务 promise。
    const boom = () => {
      throw new Error("errorIf boom");
    };

    const asyncRow = await recordSpan(
      dbPath,
      "sem.errorif-throws-async",
      { recordResult: false, errorIf: boom },
      async () => ({ ok: true }),
    );
    expect(asyncRow).toBeTruthy();

    const syncRow = await recordSpan(
      dbPath,
      "sem.errorif-throws-sync",
      { recordResult: false, errorIf: boom },
      () => ({ ok: true }),
    );
    expect(syncRow).toBeTruthy();
  });

  test("CV-3 回归：filter 失效时退回 recordResult 裁决（不静默丢数据）", async () => {
    // filter 抛异常 / 返回非对象 / 返回数组时，
    // recordResult:true 想要的完整 result 不能被静默丢掉。
    const boom = () => {
      throw new Error("filter boom");
    };

    const threw = await recordSpan(
      dbPath,
      "sem.fallback-threw",
      { recordResult: true, resultFilter: boom },
      async () => ({ keep: "keep-me" }),
    );
    expect(threw.result ?? "").toContain("keep-me");

    const arrayRet = await recordSpan(
      dbPath,
      "sem.fallback-array",
      { recordResult: true, resultFilter: (() => [1, 2]) as any },
      async () => ({ keep: "keep-me-too" }),
    );
    expect(arrayRet.result ?? "").toContain("keep-me-too");
  });

  test("CV-4 回归：filter 抛异常时也只调用一次（不因重试而跑两遍）", async () => {
    let calls = 0;
    const opts = {
      recordResult: false,
      resultFilter: () => {
        calls++;
        throw new Error("filter boom");
      },
    };

    calls = 0;
    await recordSpan(dbPath, "sem.calls-throw-async", opts, async () => ({ n: 1 }));
    expect(calls).toBe(1);

    calls = 0;
    await recordSpan(dbPath, "sem.calls-throw-sync", opts, () => ({ n: 2 }));
    expect(calls).toBe(1);
  });
});

describe("装饰器 logResult（日志与 DB 解耦）", () => {
  let dir: string;
  let dbPath: string;
  let logDir: string;

  beforeEach(() => {
    resetTracerProvider();
    dir = mkdtempSync(join(tmpdir(), "trace-logresult-"));
    dbPath = join(dir, "traces.db");
    logDir = join(dir, "logs");
    mkdirSync(logDir, { recursive: true });
    // logger 通过 ConfigComponent 读日志目录（setLogDirOverride 不影响写盘路径）
    setConfigComponent({
      get: (key: string) => (key === "log-trace.logging.dir" ? logDir : undefined),
    });
  });

  afterEach(() => {
    resetTracerProvider();
    setConfigComponent(undefined as any);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  test("logResult:true → DB 里没有 result，但 app.log 里有", async () => {
    const storage = new SQLiteSpanStorage(dbPath);
    await storage.initialize();
    (getTracerProvider() as any).storage = storage;

    const wrapped = wrapFunction(
      async () => ({ secret: "LOGGED_VALUE_12345" }),
      "sem.log-result",
      { recordResult: false, logResult: true, log: true },
    );
    await wrapped();
    await new Promise((r) => setTimeout(r, 400));

    // DB：没有 result
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT result FROM span WHERE name = ? LIMIT 1").get("sem.log-result");
    db.close();
    expect(row.result === null || row.result === "").toBe(true);

    // 日志：有 result
    const files = readdirSync(logDir).filter((f) => f.endsWith(".log"));
    let content = "";
    for (const f of files) content += readFileSync(join(logDir, f), "utf8");
    expect(content).toContain("LOGGED_VALUE_12345");
  });

  test("logResult 未设 → 跟随 recordResult（向后兼容）", async () => {
    const storage = new SQLiteSpanStorage(dbPath);
    await storage.initialize();
    (getTracerProvider() as any).storage = storage;

    const wrapped = wrapFunction(
      async () => ({ v: "SHOULD_NOT_BE_LOGGED" }),
      "sem.log-default",
      { recordResult: false, log: true },
    );
    await wrapped();
    await new Promise((r) => setTimeout(r, 400));

    const files = readdirSync(logDir).filter((f) => f.endsWith(".log"));
    let content = "";
    for (const f of files) content += readFileSync(join(logDir, f), "utf8");
    expect(content).not.toContain("SHOULD_NOT_BE_LOGGED");
  });
});
