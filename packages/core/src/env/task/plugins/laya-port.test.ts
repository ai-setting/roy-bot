/**
 * @fileoverview Task #4620 — LayaDecisionPort 单测（不真调 API，mock fetch）
 *
 * 覆盖：
 *   - 端点拼接：baseURL 是服务根 → 拼 /v1/systemone；已是 systemone 则不重复拼
 *   - 请求体：state / questions 是**顶层键**（标准 chat/completions 会 400）
 *   - 鉴权 header：Authorization: Bearer <key>
 *   - body.model 默认 task-decision
 *   - 置信度选取：auto(jev→answer→entropy) / jev / entropy 三档（#302）
 *   - state 截断信号：usage.state_tokens_dropped>0 → answer.truncated=true
 *   - 超时 → 熔断计数；连续 3 次超时 → 自我禁用
 *   - 泄漏断言在**发请求之前**执行（不发出请求）
 *   - HTTP 非 2xx → 抛错
 *   - loadLayaAuth：读不到 / 格式错 → null（fail-open 的前提）
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LayaDecisionPort, loadLayaAuth } from "./laya-port";

interface FetchCall {
  url: string;
  init: RequestInit;
}

const BASE = "http://127.0.0.1:8901";

describe("LayaDecisionPort", () => {
  let calls: FetchCall[] = [];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(handler: (call: FetchCall) => { status?: number; body: unknown }): void {
    globalThis.fetch = (async (input: any, init: any) => {
      const call: FetchCall = { url: String(input), init: init ?? {} };
      calls.push(call);
      const res = handler(call);
      const status = res.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => res.body,
      } as any;
    }) as any;
  }

  /** laya 真实响应形态（Task #4620 实测） */
  const layaBody = {
    model: "laya-rl-agent",
    answers: {
      reuse_or_create: {
        type: "choice",
        choice: "#4502 something",
        confidence: 0.9809,
        answer_confidence: 0.9957,
        x_jev_confidence: 0.9948,
        probabilities: { "#4502 something": 0.0008, NEW_TASK: 0.9957 },
        action: { act_probability: 1.0 },
      },
    },
    usage: {
      input_tokens: 512,
      output_tokens: 0,
      state_tokens: 652,
      state_tokens_dropped: 336,
      truncated: true,
      truncated_questions: ["reuse_or_create"],
    },
    routing: { model: "task-decision", repo: "/path/to/checkpoints/base-eng" },
  };

  const req = {
    state: { task_to_route: { title: "t" } },
    questions: { reuse_or_create: { type: "choice", criteria: { "NEW_TASK": "x" } } },
  };

  // ==================================================================
  // 端点与请求体
  // ==================================================================

  test("posts to {baseURL}/v1/systemone (baseURL is the service root)", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({
      baseURL: BASE,
      apiKey: "local-laya-key",
      fetchImpl: globalThis.fetch,
    });

    await port.decide(req);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/v1/systemone`);
  });

  test("does not double-append /v1/systemone when baseURL already has it", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({
      baseURL: `${BASE}/v1/systemone`,
      apiKey: "k",
      fetchImpl: globalThis.fetch,
    });

    await port.decide(req);
    expect(calls[0].url).toBe(`${BASE}/v1/systemone`);
  });

  test("strips trailing slashes from baseURL", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({
      baseURL: `${BASE}///`,
      apiKey: "k",
      fetchImpl: globalThis.fetch,
    });

    await port.decide(req);
    expect(calls[0].url).toBe(`${BASE}/v1/systemone`);
  });

  test("sends Authorization: Bearer header", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({
      baseURL: BASE,
      apiKey: "local-laya-key",
      fetchImpl: globalThis.fetch,
    });

    await port.decide(req);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer local-laya-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("body has state/questions at TOP level (not wrapped in messages)", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({
      baseURL: BASE,
      apiKey: "k",
      fetchImpl: globalThis.fetch,
    });

    await port.decide(req);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.state).toBeDefined();
    expect(body.questions).toBeDefined();
    expect(body.messages).toBeUndefined();
  });

  test("body.model defaults to task-decision and is overridable", async () => {
    mockFetch(() => ({ body: layaBody }));
    await new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch }).decide(req);
    expect(JSON.parse(String(calls[0].init.body)).model).toBe("task-decision");

    calls = [];
    await new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", model: "other", fetchImpl: globalThis.fetch,
    }).decide(req);
    expect(JSON.parse(String(calls[0].init.body)).model).toBe("other");
  });

  // ==================================================================
  // 置信度选取（#302）
  // ==================================================================

  test("auto confidencePref prefers x_jev_confidence over entropy confidence", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch,
    });

    const res = await port.decide(req);
    // x_jev_confidence = 0.9948 —— 不是 entropy 的 0.9809，也不是 answer 的 0.9957
    expect(res.answers.reuse_or_create.confidence).toBeCloseTo(0.9948, 6);
  });

  test("auto falls back to answer_confidence then confidence", async () => {
    mockFetch(() => ({
      body: {
        answers: {
          reuse_or_create: { type: "choice", choice: "NEW_TASK", confidence: 0.7, answer_confidence: 0.8 },
        },
      },
    }));
    const port = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });
    const res = await port.decide(req);
    expect(res.answers.reuse_or_create.confidence).toBeCloseTo(0.8, 6);

    // ⚠️ port 在构造时就固化了 fetchImpl → 换响应要造新 port
    mockFetch(() => ({
      body: { answers: { reuse_or_create: { type: "choice", choice: "NEW_TASK", confidence: 0.7 } } },
    }));
    const port2 = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });
    const res2 = await port2.decide(req);
    expect(res2.answers.reuse_or_create.confidence).toBeCloseTo(0.7, 6);
  });

  test("jev confidencePref uses ONLY x_jev_confidence (missing → 0)", async () => {
    mockFetch(() => ({
      body: {
        answers: { reuse_or_create: { type: "choice", choice: "NEW_TASK", confidence: 0.99 } },
      },
    }));
    const port = new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", confidencePref: "jev", fetchImpl: globalThis.fetch,
    });
    const res = await port.decide(req);
    expect(res.answers.reuse_or_create.confidence).toBe(0);
  });

  test("entropy confidencePref uses the raw confidence field", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", confidencePref: "entropy", fetchImpl: globalThis.fetch,
    });
    const res = await port.decide(req);
    expect(res.answers.reuse_or_create.confidence).toBeCloseTo(0.9809, 6);
  });

  test("preserves probabilities / action / choice from the response", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });
    const res = await port.decide(req);
    const a = res.answers.reuse_or_create;
    expect(a.choice).toBe("#4502 something");
    expect(a.probabilities?.NEW_TASK).toBeCloseTo(0.9957, 6);
    expect(a.action?.act_probability).toBe(1.0);
  });

  // ==================================================================
  // state 截断信号
  // ==================================================================

  test("lifts usage.state_tokens_dropped onto answer.truncated", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });
    const res = await port.decide(req);
    expect(res.answers.reuse_or_create.truncated).toBe(true);
    expect(res.usage?.state_tokens_dropped).toBe(336);
  });

  test("truncated is false when nothing was dropped", async () => {
    mockFetch(() => ({
      body: {
        answers: { reuse_or_create: { type: "choice", choice: "NEW_TASK", confidence: 0.9 } },
        usage: { input_tokens: 848, state_tokens: 652, state_tokens_dropped: 0, truncated: false },
      },
    }));
    const port = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });
    const res = await port.decide(req);
    expect(res.answers.reuse_or_create.truncated).toBe(false);
  });

  // ==================================================================
  // 超时与熔断
  // ==================================================================

  test("timeout aborts the request and throws TimeoutError", async () => {
    globalThis.fetch = (async (_i: any, init: any) => {
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener?.("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });
    }) as any;

    const port = new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", timeoutMs: 30, fetchImpl: globalThis.fetch,
    });

    await expect(port.decide(req)).rejects.toThrow(/timed out|abort/i);
  });

  test("3 consecutive timeouts → port self-disables (isDisabled)", async () => {
    globalThis.fetch = (async (_i: any, init: any) => {
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener?.("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      });
    }) as any;

    const port = new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", timeoutMs: 20, maxStrikes: 3, fetchImpl: globalThis.fetch,
    });

    expect(port.isDisabled()).toBe(false);
    await expect(port.decide(req)).rejects.toThrow();
    await expect(port.decide(req)).rejects.toThrow();
    await expect(port.decide(req)).rejects.toThrow();
    expect(port.isDisabled()).toBe(true);
  });

  test("a disabled port short-circuits WITHOUT calling fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (_i: any, init: any) => {
      fetchCalls += 1;
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener?.("abort", () => {
          const e = new Error("aborted"); e.name = "AbortError"; rej(e);
        });
      });
    }) as any;

    const port = new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", timeoutMs: 20, maxStrikes: 1, fetchImpl: globalThis.fetch,
    });

    await expect(port.decide(req)).rejects.toThrow();
    expect(port.isDisabled()).toBe(true);
    expect(fetchCalls).toBe(1);

    // 已禁用 → 短路，不再发请求
    await expect(port.decide(req)).rejects.toThrow(/self-disabled/);
    expect(fetchCalls).toBe(1);
  });

  test("a successful request resets the strike counter", async () => {
    let callIdx = 0;
    globalThis.fetch = (async (_i: any, init: any) => {
      callIdx += 1;
      // 第 1、3 次超时；第 2 次成功
      if (callIdx !== 2) {
        return new Promise((_res, rej) => {
          init?.signal?.addEventListener?.("abort", () => {
            const e = new Error("aborted"); e.name = "AbortError"; rej(e);
          });
        });
      }
      return { ok: true, status: 200, json: async () => layaBody } as any;
    }) as any;

    const port = new LayaDecisionPort({
      baseURL: BASE, apiKey: "k", timeoutMs: 20, maxStrikes: 3, fetchImpl: globalThis.fetch,
    });

    await expect(port.decide(req)).rejects.toThrow();   // strike 1
    await port.decide(req);                              // success → reset
    await expect(port.decide(req)).rejects.toThrow();    // strike 1 again
    // 1 + reset + 1 = 2 < 3 → still enabled
    expect(port.isDisabled()).toBe(false);
  });

  // ==================================================================
  // 错误与泄漏
  // ==================================================================

  test("non-2xx HTTP status throws", async () => {
    mockFetch(() => ({ status: 503, body: { detail: "unavailable" } }));
    const port = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });
    await expect(port.decide(req)).rejects.toThrow(/HTTP 503/);
  });

  test("leakage assertion runs BEFORE the request is sent", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });

    const leaky = {
      state: { expected_decision: "REUSE" },
      questions: { reuse_or_create: { type: "choice", criteria: { NEW_TASK: "x" } } },
    };

    await expect(port.decide(leaky)).rejects.toThrow();
    // 关键断言：泄漏的 payload 一次都没发出去
    expect(calls).toHaveLength(0);
  });

  test("user free text containing leak-ish words is NOT rejected", async () => {
    mockFetch(() => ({ body: layaBody }));
    const port = new LayaDecisionPort({ baseURL: BASE, apiKey: "k", fetchImpl: globalThis.fetch });

    const freeText = {
      state: { task_to_route: { title: "expected label of the decision should be golden" } },
      questions: { reuse_or_create: { type: "choice", criteria: { NEW_TASK: "x" } } },
    };

    await expect(port.decide(freeText)).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });

  // ==================================================================
  // loadLayaAuth
  // ==================================================================

  test("loadLayaAuth returns null when the file does not exist", async () => {
    const cfg = await loadLayaAuth("/nonexistent/does-not-exist.json");
    expect(cfg).toBeNull();
  });

  test("loadLayaAuth returns null when the provider key is absent", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "laya-auth-"));
    const p = join(dir, "auth.json");
    writeFileSync(p, JSON.stringify({ providers: { openai: { baseURL: "x", apiKey: "y" } } }));

    expect(await loadLayaAuth(p)).toBeNull();
  });

  test("loadLayaAuth returns null on malformed JSON", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "laya-auth-"));
    const p = join(dir, "auth.json");
    writeFileSync(p, "{not json");

    expect(await loadLayaAuth(p)).toBeNull();
  });

  test("loadLayaAuth reads baseURL/apiKey/model from providers['laya-decision']", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "laya-auth-"));
    const p = join(dir, "auth.json");
    writeFileSync(p, JSON.stringify({
      providers: {
        "ali-decision": { baseURL: "https://maas.example/v1/systemone", apiKey: "sk-ali" },
        "laya-decision": { baseURL: "http://127.0.0.1:8901", apiKey: "local-laya-key", model: "task-decision" },
      },
    }));

    const cfg = await loadLayaAuth(p);
    expect(cfg).toEqual({
      baseURL: "http://127.0.0.1:8901",
      apiKey: "local-laya-key",
      model: "task-decision",
    });
  });

  test("loadLayaAuth defaults model to task-decision when absent", async () => {
    const { mkdtempSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "laya-auth-"));
    const p = join(dir, "auth.json");
    writeFileSync(p, JSON.stringify({
      providers: { "laya-decision": { baseURL: "http://x:1", apiKey: "k" } },
    }));

    const cfg = await loadLayaAuth(p);
    expect(cfg?.model).toBe("task-decision");
  });
});
