/**
 * @fileoverview Task #4467 — SystemOneDecisionPort 单测（不真调 API）
 *
 * 契约：/tmp/task-create-verdict-contract-v2.md §7
 *
 * 覆盖：
 *   - 端点拼接：baseURL 本身就是请求地址（不拼 /chat/completions）
 *   - 请求体：state / questions 是**顶层键**（标准 chat/completions 会 400）
 *   - 泄漏断言在**发请求之前**执行
 *   - 超时 → 熔断计数；同 session 连续 3 次超时 → 自我禁用
 *   - 响应解析：answers / confidence / probabilities
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SystemOneDecisionPort } from "./decision-port";

interface FetchCall {
  url: string;
  init: RequestInit;
}

describe("SystemOneDecisionPort", () => {
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

  const okBody = {
    answers: {
      reuse_or_create: {
        type: "choice",
        choice: "#4447",
        confidence: 0.82,
        probabilities: { "#4447": 0.71, "NEW_TASK": 0.29 },
      },
    },
    usage: { input_tokens: 645 },
    latency_ms: 344,
  };

  test("posts to the baseURL itself (no /chat/completions suffix)", async () => {
    mockFetch(() => ({ body: okBody }));
    const port = new SystemOneDecisionPort({
      baseURL: "https://maas.qianwenaiapi.com/compatible-mode/v1/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
    });

    await port.decide({ state: { task_to_route: { title: "x" } }, questions: { reuse_or_create: { type: "choice" } } });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://maas.qianwenaiapi.com/compatible-mode/v1/systemone");
    expect(calls[0].url).not.toContain("/chat/completions");
  });

  test("request body has state and questions as TOP-LEVEL keys", async () => {
    mockFetch(() => ({ body: okBody }));
    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
    });

    await port.decide({ state: { a: 1 }, questions: { q: { type: "choice" } } });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.state).toEqual({ a: 1 });
    expect(body.questions).toEqual({ q: { type: "choice" } });
    expect(body.messages).toBeUndefined();
    expect(body.model).toBe("decision-model-preview");
  });

  test("leakage assertion runs BEFORE the request (no fetch on leak)", async () => {
    mockFetch(() => ({ body: okBody }));
    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
    });

    await expect(
      port.decide({
        state: { task_to_route: { title: "x", expected_decision: "attach" } },
        questions: { reuse_or_create: { type: "choice" } },
      }),
    ).rejects.toThrow();

    // 泄漏的 payload 永远不能被发出去
    expect(calls).toHaveLength(0);
  });

  test("parses answers / confidence / probabilities", async () => {
    mockFetch(() => ({ body: okBody }));
    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
    });

    const res = await port.decide({
      state: { task_to_route: { title: "x" } },
      questions: { reuse_or_create: { type: "choice" } },
    });

    expect(res.answers.reuse_or_create.choice).toBe("#4447");
    expect(res.answers.reuse_or_create.confidence).toBe(0.82);
    expect(res.answers.reuse_or_create.probabilities?.["#4447"]).toBe(0.71);
    expect(res.usage?.input_tokens).toBe(645);
    expect(res.latency_ms).toBe(344);
  });

  test("non-200 → throws", async () => {
    mockFetch(() => ({ status: 500, body: { error: "boom" } }));
    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
    });

    await expect(
      port.decide({ state: { task_to_route: { title: "x" } }, questions: { reuse_or_create: { type: "choice" } } }),
    ).rejects.toThrow();
  });

  test("timeout → throws, counts towards the 3-strike breaker", async () => {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { ok: true, status: 200, json: async () => okBody } as any;
    }) as any;

    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
      timeoutMs: 50,
      sessionId: "sess-x",
    });

    await expect(
      port.decide({ state: { task_to_route: { title: "x" } }, questions: { reuse_or_create: { type: "choice" } } }),
    ).rejects.toThrow();
    expect(port.isDisabled()).toBe(false);
  });

  test("3 consecutive timeouts in the same session → port self-disables", async () => {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { ok: true, status: 200, json: async () => okBody } as any;
    }) as any;

    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
      timeoutMs: 30,
      sessionId: "sess-y",
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        port.decide({ state: { task_to_route: { title: "x" } }, questions: { reuse_or_create: { type: "choice" } } }),
      ).rejects.toThrow();
    }

    expect(port.isDisabled()).toBe(true);
  });

  test("different sessions do NOT share the breaker counter", async () => {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { ok: true, status: 200, json: async () => okBody } as any;
    }) as any;

    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
      timeoutMs: 30,
      sessionId: "sess-a",
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        port.decide({ state: { task_to_route: { title: "x" } }, questions: { reuse_or_create: { type: "choice" } } }),
      ).rejects.toThrow();
    }

    // 换一个 session → 新端口实例 → 计数独立
    const other = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
      timeoutMs: 30,
      sessionId: "sess-b",
    });
    expect(other.isDisabled()).toBe(false);
  });

  test("when disabled → decide() short-circuits without calling fetch", async () => {
    mockFetch(() => ({ body: okBody }));
    const port = new SystemOneDecisionPort({
      baseURL: "https://example.test/systemone",
      apiKey: "sk-test",
      model: "decision-model-preview",
      fetchImpl: globalThis.fetch,
      timeoutMs: 30,
      sessionId: "sess-z",
    });
    // 手动触发熔断
    (port as any).timeoutStrikes = 3;

    expect(port.isDisabled()).toBe(true);
    await port
      .decide({ state: { task_to_route: { title: "x" } }, questions: { reuse_or_create: { type: "choice" } } })
      .catch(() => undefined);
    expect(calls).toHaveLength(0);
  });
});
