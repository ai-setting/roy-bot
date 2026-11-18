/**
 * Task #4383 (follow-up of #4381) — P0 + P1
 *
 * P1: apiProtocol 显式判定
 *   现状 `resolvePiModel()` 靠 `baseURL?.includes("anthropic")` 猜协议，
 *   minimax 只是「误打误撞」猜对了（真实 baseURL 恰好含 anthropic）。
 *   且 `glm` 根本不在 KNOWN_PROVIDER_APIS 里，靠兜底 `|| "openai-completions"` 巧合正确。
 *
 * P0: pi-ai adapter 必须把 sessionId + cacheRetention 传给 pi-ai
 *   现状 PiAiAdapter.chat()/stream() 传给 complete()/stream() 的 options 只有
 *   {apiKey, baseURL, temperature, maxTokens, signal, headers}，
 *   `req.sessionId` 只被 buildOpencodeHeaders 用了（x-opencode-session），
 *   从未作为 sessionId 传给 pi-ai → openai-completions.js:394 的
 *   `prompt_cache_key` 条件永远不满足 → deepseek/glm 全靠隐式缓存。
 */
import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// P1: apiProtocol 显式判定
// ---------------------------------------------------------------------------

describe("P1: resolveApiProtocol — explicit protocol resolution", () => {
  test("minimax resolves to anthropic-messages for its /anthropic endpoint", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    expect(resolveApiProtocol("minimax", "https://api.minimaxi.com/anthropic")).toBe(
      "anthropic-messages",
    );
  });

  test("minimax /v1 endpoint is declared as openai-completions (multi-protocol vendor)", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    // MiniMax officially publishes BOTH endpoints. The mapping is now declared
    // as data (PROVIDER_ENDPOINT_APIS) instead of a buried ternary, but the
    // behaviour is intentionally preserved.
    expect(resolveApiProtocol("minimax", "https://api.minimaxi.com/v1")).toBe("openai-completions");
    expect(resolveApiProtocol("minimax-cn", "https://api.minimaxi.com/v1")).toBe(
      "openai-completions",
    );
  });

  test("minimax with no baseURL falls back to its declared vendor default", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    // No endpoint to inspect → the declarative vendor default wins.
    // 这是 P1 的核心：不再靠 baseURL 里有没有 "anthropic" 字符串。
    expect(resolveApiProtocol("minimax", undefined)).toBe("anthropic-messages");
    expect(resolveApiProtocol("minimax-cn", undefined)).toBe("anthropic-messages");
  });

  test("minimax-cn resolves to anthropic-messages", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    expect(resolveApiProtocol("minimax-cn", undefined)).toBe("anthropic-messages");
  });

  test("deepseek and glm resolve to openai-completions", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    expect(resolveApiProtocol("deepseek", "https://api.deepseek.com")).toBe("openai-completions");
    expect(resolveApiProtocol("glm", "https://open.bigmodel.cn/api/paas/v4")).toBe(
      "openai-completions",
    );
    // glm 以前不在 KNOWN_PROVIDER_APIS 里，靠兜底；现在必须显式声明
    expect(resolveApiProtocol("glm", undefined)).toBe("openai-completions");
  });

  test("explicit protocol argument wins over everything", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    // 显式传 openai-completions 时，即便 provider 是 minimax（默认 anthropic），也听显式的
    expect(resolveApiProtocol("minimax", "https://api.minimaxi.com/anthropic", "openai-completions")).toBe(
      "openai-completions",
    );
    expect(resolveApiProtocol("deepseek", "https://api.deepseek.com", "anthropic-messages")).toBe(
      "anthropic-messages",
    );
  });

  test("unknown provider still falls back to baseURL heuristic (backward compat)", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    // 未知 provider + baseURL 含 anthropic → 仍能猜对（兼容老 config）
    expect(resolveApiProtocol("some-custom-proxy", "https://proxy.example.com/anthropic")).toBe(
      "anthropic-messages",
    );
    // 未知 provider + /responses → openai-responses 也保留
    expect(resolveApiProtocol("some-custom-proxy", "https://x.example.com/v1/responses")).toBe(
      "openai-responses",
    );
    // 完全未知 → openai-completions 兜底
    expect(resolveApiProtocol("some-custom-proxy", "https://api.example.com/v1")).toBe(
      "openai-completions",
    );
  });
});

describe("P1: KNOWN_PROVIDER_APIS declares apiProtocol explicitly", () => {
  test("minimax / minimax-cn declare anthropic-messages", async () => {
    const { KNOWN_PROVIDER_APIS } = await import("./adapter-pi-ai");
    expect(KNOWN_PROVIDER_APIS.minimax?.apiProtocol).toBe("anthropic-messages");
    expect(KNOWN_PROVIDER_APIS["minimax-cn"]?.apiProtocol).toBe("anthropic-messages");
  });

  test("deepseek / glm declare openai-completions", async () => {
    const { KNOWN_PROVIDER_APIS } = await import("./adapter-pi-ai");
    expect(KNOWN_PROVIDER_APIS.deepseek?.apiProtocol).toBe("openai-completions");
    expect(KNOWN_PROVIDER_APIS.glm?.apiProtocol).toBe("openai-completions");
  });

  test("resolvePiModel honours the declared per-endpoint protocol", async () => {
    const { resolvePiModel } = await import("./adapter-pi-ai");
    // 端点声明化后的回归护栏：
    // - /anthropic 端点 → anthropic-messages（cache_control 生效路径）
    // - /v1 端点 → openai-completions（prompt_cache_key 生效路径）
    const anthropic = resolvePiModel(
      "minimax",
      "MiniMax-M3-fake-not-in-registry",
      "https://api.minimaxi.com/anthropic",
    );
    expect(anthropic.api).toBe("anthropic-messages");

    const openai = resolvePiModel(
      "minimax",
      "MiniMax-M3-fake-not-in-registry",
      "https://api.minimaxi.com/v1",
    );
    expect(openai.api).toBe("openai-completions");
  });

  test("endpoint rules prefer the longest matching path segment", async () => {
    const { resolveApiProtocol } = await import("./adapter-pi-ai");
    // 边界护栏：一个同时含 /v1 与 /anthropic 的怪异 URL。
    // 若把 "first match wins" 当作构造顺序，/anthropic 会被优先命中；
    // 显式按长度排序后行为依然是 anthropic-messages（更具体的段优先），
    // 但关键在于「行为由最长段决定」这件事被固定下来，不随数组顺序漂移。
    const weird = "https://api.minimaxi.com/v1/anthropic";
    expect(resolveApiProtocol("minimax", weird)).toBe("anthropic-messages");
  });
});

// ---------------------------------------------------------------------------
// P0: buildPiCacheOptions
// ---------------------------------------------------------------------------

describe("P0: buildPiCacheOptions — sessionId + cacheRetention wiring", () => {
  test("openai-completions gets sessionId + cacheRetention long", async () => {
    const { buildPiCacheOptions } = await import("./adapter-pi-ai");
    const opts = buildPiCacheOptions({
      apiProtocol: "openai-completions",
      sessionId: "session_abc123",
    });
    expect(opts.sessionId).toBe("session_abc123");
    // 关键：必须 long，否则 openai-completions.js:394 的
    // `cacheRetention === "long" && compat.supportsLongCacheRetention` 不满足
    expect(opts.cacheRetention).toBe("long");
  });

  test("anthropic-messages gets sessionId but NOT cacheRetention (keep pi-ai default short)", async () => {
    const { buildPiCacheOptions } = await import("./adapter-pi-ai");
    const opts = buildPiCacheOptions({
      apiProtocol: "anthropic-messages",
      sessionId: "session_abc123",
    });
    expect(opts.sessionId).toBe("session_abc123");
    // 回归护栏：minimax 当前 99.86% 命中靠的是 pi-ai 默认 cacheRetention="short"
    // （ephemeral 无 ttl）。显式传 long 会加 ttl:"1h"，改变现状 → 不该传。
    expect(opts.cacheRetention).toBeUndefined();
  });

  test("no sessionId → no sessionId key (avoid injecting undefined)", async () => {
    const { buildPiCacheOptions } = await import("./adapter-pi-ai");
    const opts = buildPiCacheOptions({ apiProtocol: "openai-completions" });
    expect("sessionId" in opts).toBe(false);
  });

  test("explicit cacheRetention override is honored", async () => {
    const { buildPiCacheOptions } = await import("./adapter-pi-ai");
    const opts = buildPiCacheOptions({
      apiProtocol: "openai-completions",
      sessionId: "s1",
      cacheRetention: "short",
    });
    expect(opts.cacheRetention).toBe("short");
    const none = buildPiCacheOptions({
      apiProtocol: "anthropic-messages",
      sessionId: "s1",
      cacheRetention: "none",
    });
    expect(none.cacheRetention).toBe("none");
  });
});
