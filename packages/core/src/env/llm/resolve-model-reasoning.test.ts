/**
 * Task #4403: 修 `resolvePiModel()` 的 `reasoning: false` 硬编码（#4398 指出的根问题）
 *
 * 用户诉求（飞书 p2p 2026-10-20）：
 *   "在这个分支下继续修复 resolvePiModel 根问题，然后再重新测试下验证cache没受影响哈"
 *
 * ── 根问题 ─────────────────────────────────────────────────────────────
 * `resolvePiModel()` 对**所有** pi-ai 内置注册表里没有的 provider/model
 * （= 全部自定义 provider）返回 `reasoning: false` 字面量。
 * 配置里的 `capabilities.reasoning: true` 从来没有进到函数签名里，
 * 所以 config → descriptor 的数据通路是断的。
 *
 * ── 为什么不能简单地改成 true ──────────────────────────────────────────
 * `pi-ai` 的 `model.reasoning` 是一个**被重载的布尔**，在 0.74.2 里捆绑了
 * 22 处语义完全不同的分支。实测（onPayload 抓真实 payload，逐字节 diff）
 * 证明其中两处会**改变请求体前缀**：
 *
 *   - `openai-completions.js:591` `useDeveloperRole = model.reasoning &&
 *     compat.supportsDeveloperRole` → `system` 角色被改写成 `developer`，
 *     差异出现在 JSON 的第 40 个字符（payload 最开头）。
 *     ⇒ prompt cache 是 prefix 匹配，这会让**所有**历史缓存全量失效。
 *   - `openai-completions.js:433-475` thinkingFormat 分支 → 在 roy-bot
 *     从不传 `options.reasoningEffort` 的情况下，只会发出
 *     `thinking: {type:"disabled"}` 这种**显式关思考**的字段。
 *
 * 而 roy-bot 全库 grep 确认**从未**向 pi-ai 传 `options.reasoning` /
 * `reasoningEffort` / `thinkingEnabled`，所以在当前代码下把
 * `model.reasoning` 打开**换不来任何思考能力，只会激活上述副作用**。
 *
 * ── 修法 ───────────────────────────────────────────────────────────────
 * 1. 让 config 的 `capabilities.reasoning` 真正流进来（修数据通路），
 *    未知/未配置时保守回落 `false`（不猜模型名，避免引入 400）。
 * 2. 一旦 reasoning 被打开，就**同时** pin 住 `model.compat`：
 *      { supportsDeveloperRole: false, thinkingFormat: "openai" }
 *    实测这能让 payload 与 `reasoning: false` **字节完全一致**，
 *    于是「打开 reasoning」在收益没到账之前，绝不能有 cache 代价。
 * 3. `openai-responses` 协议保持 false：pi-ai 在该路径上的
 *    `openai-responses-shared.js:66` 是**无条件** `model.reasoning ? "developer" : "system"`，
 *    没有 compat 逃生口，无法 pin 回字节一致 → 保守禁用（见 REASONING_SAFE_PROTOCOLS）。
 */
import { describe, test, expect } from "bun:test";
import {
  resolveModelReasoning,
  resolvePiModel,
  REASONING_COMPAT_PIN,
  REASONING_SAFE_PROTOCOLS,
} from "./adapter-pi-ai";

const OPENCODE_GO = "https://opencode.ai/inference/go/v1";
const DEEPSEEK = "https://api.deepseek.com";
const GLM = "https://open.bigmodel.cn/api/paas/v4";
const MINIMAX_ANTHROPIC = "https://api.minimaxi.com/anthropic";

// ===========================================================================
// RED 1 — 数据通路：config 的 capabilities.reasoning 必须生效
// ===========================================================================

describe("resolveModelReasoning — config capabilities drives the descriptor", () => {
  test("honours explicit capabilities.reasoning = true", () => {
    expect(
      resolveModelReasoning("opencodego", "deepseek-v4.1-flash", { reasoning: true }, "openai-completions"),
    ).toBe(true);
  });

  test("honours explicit capabilities.reasoning = false", () => {
    expect(
      resolveModelReasoning("minimax", "MiniMax-M3", { reasoning: false }, "anthropic-messages"),
    ).toBe(false);
  });

  test("falls back to false when config says nothing (no model-name guessing)", () => {
    // 保守优先：不靠模型名猜 reasoning。猜错会引入 400 / 变慢 / 变贵。
    expect(resolveModelReasoning("opencodego", "deepseek-v4.1-flash", undefined, "openai-completions")).toBe(false);
    expect(resolveModelReasoning("deepseek", "deepseek-reasoner", {}, "openai-completions")).toBe(false);
    expect(resolveModelReasoning("unknown-provider", "unknown-model", undefined, "openai-completions")).toBe(false);
  });

  test("an explicit false always wins over any implicit signal", () => {
    expect(resolveModelReasoning("deepseek", "deepseek-reasoner", { reasoning: false }, "openai-completions")).toBe(false);
  });
});

// ===========================================================================
// RED 2 — 安全护栏：openai-responses 不支持 pin，必须保守禁用
// ===========================================================================

describe("resolveModelReasoning — protocol safety guard", () => {
  test("REASONING_SAFE_PROTOCOLS covers exactly the pinned protocols", () => {
    expect(REASONING_SAFE_PROTOCOLS.has("openai-completions")).toBe(true);
    expect(REASONING_SAFE_PROTOCOLS.has("anthropic-messages")).toBe(true);
    // pi-ai's openai-responses path flips system→developer unconditionally
    // (openai-responses-shared.js:66) with no compat escape hatch.
    expect(REASONING_SAFE_PROTOCOLS.has("openai-responses")).toBe(false);
  });

  test("forces false on openai-responses even when config asks for true", () => {
    expect(
      resolveModelReasoning("openai", "gpt-5", { reasoning: true }, "openai-responses"),
    ).toBe(false);
  });
});

// ===========================================================================
// RED 3 — descriptor 层：resolvePiModel 必须用 helper，且 pin 住 compat
// ===========================================================================

describe("resolvePiModel — reasoning is config-driven, never hardcoded", () => {
  test("reasoning:true from config reaches the descriptor AND pins compat", () => {
    const model = resolvePiModel("opencodego", "deepseek-v4.1-flash", OPENCODE_GO, { reasoning: true });
    expect(model.reasoning).toBe(true);
    // The pin is what keeps the payload byte-identical to reasoning:false.
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "openai",
    });
  });

  test("without config the descriptor stays conservative (false) and unpinned", () => {
    const model = resolvePiModel("opencodego", "deepseek-v4.1-flash", OPENCODE_GO);
    expect(model.reasoning).toBe(false);
    // No pin needed when reasoning is off: every reasoning branch is already dead.
    expect(model.compat).toBeUndefined();
  });

  test("explicit capabilities.reasoning:false wins over everything", () => {
    const model = resolvePiModel("deepseek", "deepseek-reasoner", DEEPSEEK, { reasoning: false });
    expect(model.reasoning).toBe(false);
    expect(model.compat).toBeUndefined();
  });

  test("openai-responses providers never get reasoning even with config true", () => {
    const model = resolvePiModel("minimax-responses", "MiniMax-M3", "https://api.minimaxi.com/v1", {
      reasoning: true,
    });
    expect(model.api).toBe("openai-responses");
    expect(model.reasoning).toBe(false);
  });

  test("REASONING_COMPAT_PIN covers every payload-changing knob", () => {
    // The first two were proven necessary by payload diff. The third closes a
    // LATENT break (review D4): with `thinkingFormat: "openai"` control falls
    // through to openai-completions.js:471/475, and detectCompat marks
    // glm/ali/volcengine/tong as `supportsReasoningEffort: true`, so any future
    // caller passing `reasoningEffort` would emit a brand-new field.
    expect(REASONING_COMPAT_PIN).toEqual({
      supportsDeveloperRole: false,
      thinkingFormat: "openai",
      supportsReasoningEffort: false,
    });
  });

  test("guard fails CLOSED on an unresolved protocol (review D2)", () => {
    // An unknown protocol is by definition one we have not proven pinnable.
    // Before the fix these returned `true`, silently taking the unsafe path.
    expect(resolveModelReasoning("p", "m", { reasoning: true }, undefined)).toBe(false);
    expect(resolveModelReasoning("p", "m", { reasoning: true }, "")).toBe(false);
  });

  test("pi-ai built-ins are deliberately left untouched (review D1)", async () => {
    // Built-ins already carry their own reasoning/compat. Forcing them to honour
    // `capabilities.reasoning: false` would be an ACTIVE wire regression: pi-ai
    // stops emitting `thinking:{type:"disabled"}` (openai-completions.js:475 is
    // gated on model.reasoning), so thinking could be billed again as output.
    const { getModel } = await import("@earendil-works/pi-ai");
    const builtIn = getModel("deepseek" as any, "deepseek-v4-flash" as any) as any;
    if (!builtIn) return; // registry may not carry it across pi-ai versions
    const resolved = resolvePiModel("deepseek", "deepseek-v4-flash", "https://api.deepseek.com", {
      reasoning: false,
    });
    // The built-in's own reasoning flag survives; config does not override it.
    expect(resolved.reasoning).toBe(builtIn.reasoning);
    // ...and its provider-tuned compat is preserved, not replaced by our pin.
    expect(resolved.compat).toEqual(builtIn.compat);
  });

  test("source no longer hardcodes `reasoning: false` inside resolvePiModel", async () => {
    // Resolve relative to THIS test file, not the process CWD: `bun test` is
    // often run from `packages/core`, which made a bare relative path fail
    // with ENOENT (Task #4403 review, D5).
    const srcPath = new URL("./adapter-pi-ai.ts", import.meta.url);
    const src = await Bun.file(srcPath).text();
    const start = src.indexOf("export function resolvePiModel");
    expect(start).toBeGreaterThan(-1);
    // Function body ends at the next top-level `export function` after it.
    const rest = src.slice(start);
    const end = rest.indexOf("\n}\n");
    const body = rest.slice(0, end === -1 ? rest.length : end);
    expect(body).not.toMatch(/reasoning:\s*false\s*,/);
    // ...and it must go through the helper instead.
    expect(body).toContain("resolveModelReasoning(");
  });
});

// ===========================================================================
// RED 4 — 字节级不变量（这是「cache 不受影响」的机器可验证形式）
// ===========================================================================

describe("payload bytes are invariant when reasoning is enabled", () => {
  /**
   * Capture the exact body pi-ai would send, without touching the network:
   * `onPayload` runs after the payload is built, and throwing from it aborts
   * the request before any socket is opened.
   */
  async function capturePayload(
    provider: string,
    modelId: string,
    baseUrl: string,
    capabilities: { reasoning?: boolean } | undefined,
  ): Promise<Record<string, unknown>> {
    const { stream } = await import("@earendil-works/pi-ai");
    const { createReasoningDefenseHook } = await import("./reasoning-defense");
    const model = resolvePiModel(provider, modelId, baseUrl, capabilities);
    let captured: Record<string, unknown> | undefined;
    try {
      const s = stream(
        model,
        {
          systemPrompt: `SYS-${"x".repeat(160)}`,
          messages: [
            { role: "user", content: "hello", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              api: model.api,
              model: "",
              provider: "",
              usage: {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 2,
            },
            { role: "user", content: "again", timestamp: 3 },
          ],
          tools: [],
        },
        {
          apiKey: "sk-fake",
          temperature: 0,
          maxTokens: 16,
          // Use the REAL production hook so the comparison reflects what
          // roy-bot actually sends (Task #4398's defence is always wired).
          onPayload: async (payload: any) => {
            const next = await createReasoningDefenseHook({ provider, modelId })(payload);
            captured = JSON.parse(JSON.stringify(next === undefined ? payload : next));
            // Abort before any network I/O; we only care about the bytes.
            throw new Error("capture-only");
          },
          onResponse: () => {},
        },
      );
      for await (const _ of s) {
        /* unreachable — onPayload throws first */
      }
    } catch {
      /* expected */
    }
    if (!captured) throw new Error(`failed to capture payload for ${provider}/${modelId}`);
    return captured;
  }

  /**
   * Same as {@link capturePayload} but WITHOUT wiring the Task #4398
   * `reasoning_content` defence — used to show what pi-ai does on its own.
   */
  async function capturePayloadRaw(
    provider: string,
    modelId: string,
    baseUrl: string,
    capabilities: { reasoning?: boolean } | undefined,
  ): Promise<Record<string, unknown>> {
    const { stream } = await import("@earendil-works/pi-ai");
    const model = resolvePiModel(provider, modelId, baseUrl, capabilities);
    let captured: Record<string, unknown> | undefined;
    try {
      const s = stream(
        model,
        {
          systemPrompt: `SYS-${"x".repeat(160)}`,
          messages: [
            { role: "user", content: "hello", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              api: model.api, model: "", provider: "",
              usage: {
                input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop", timestamp: 2,
            },
            { role: "user", content: "again", timestamp: 3 },
          ],
          tools: [],
        },
        {
          apiKey: "sk-fake", temperature: 0, maxTokens: 16,
          onPayload: (payload: any) => {
            captured = JSON.parse(JSON.stringify(payload));
            throw new Error("capture-only");
          },
          onResponse: () => {},
        },
      );
      for await (const _ of s) { /* unreachable */ }
    } catch { /* expected */ }
    if (!captured) throw new Error(`failed to capture raw payload for ${provider}/${modelId}`);
    return captured;
  }

  const cases: Array<[string, string, string, string]> = [
    ["opencodego", "deepseek-v4.1-flash", OPENCODE_GO, "default provider"],
    ["glm", "glm-5.2", GLM, "system→developer regression case"],
    ["minimax", "MiniMax-M3", MINIMAX_ANTHROPIC, "anthropic-messages path"],
    ["deepseek", "deepseek-chat", DEEPSEEK, "deepseek default thinkingFormat"],
  ];

  for (const [provider, modelId, baseUrl, why] of cases) {
    test(`${provider}/${modelId} payload is byte-identical (${why})`, async () => {
      const before = await capturePayload(provider, modelId, baseUrl, undefined);
      const after = await capturePayload(provider, modelId, baseUrl, { reasoning: true });
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });
  }

  test("deepseek family: reasoning:true lets pi-ai inject reasoning_content natively", async () => {
    // Documented side effect of #4403, NOT a regression.
    //
    // `detectCompat()` sets `requiresReasoningContentOnAssistantMessages = true`
    // for the deepseek family, but pi-ai gates the injection on a triple AND
    // (`openai-completions.js:712-716`):
    //     compat.requiresReasoningContentOnAssistantMessages
    //   && model.reasoning
    //   && assistantMsg.reasoning_content === undefined
    //
    // With `model.reasoning === false` (today) the middle term is false, so
    // pi-ai never injects and Task #4398 had to patch it from the outside via
    // `onPayload`. Turning `reasoning` on restores pi-ai's own injection, which
    // produces the exact same `reasoning_content: ""` bytes — so the #4398 hook
    // becomes a harmless no-op on that field (it is `in`-guarded, not
    // value-guarded). Net effect on the wire: none.
    const withoutHook = await capturePayloadRaw("deepseek", "deepseek-chat", DEEPSEEK, { reasoning: true });
    const withHook = await capturePayload("deepseek", "deepseek-chat", DEEPSEEK, { reasoning: true });
    const rc = (p: Record<string, any>) =>
      (p.messages as any[]).filter((m) => m.role === "assistant").map((m) => "reasoning_content" in m);

    // pi-ai itself now supplies the field (no external help needed)...
    expect(rc(withoutHook)).toEqual([true]);
    // ...and the #4398 defence does not duplicate or contradict it.
    expect(JSON.stringify(withHook)).toBe(JSON.stringify(withoutHook));
  });

  test("control: WITHOUT the compat pin the bytes DO change (proves the pin is load-bearing)", async () => {
    // glm is the sharpest case: bare reasoning:true flips system→developer at
    // JSON offset ~40. If this control ever stops failing, the pin has become
    // unnecessary — or pi-ai changed and the whole analysis needs redoing.
    const { stream } = await import("@earendil-works/pi-ai");
    const bare = {
      id: "glm-5.2", name: "glm-5.2", api: "openai-completions", provider: "glm",
      baseUrl: GLM, reasoning: true, input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 8192,
    };
    let captured: any;
    try {
      const s = stream(
        bare as any,
        { systemPrompt: `SYS-${"x".repeat(160)}`, messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] },
        {
          apiKey: "sk-fake", temperature: 0, maxTokens: 8,
          onPayload: (p: any) => { captured = JSON.parse(JSON.stringify(p)); throw new Error("capture-only"); },
          onResponse: () => {},
        },
      );
      for await (const _ of s) { /* unreachable */ }
    } catch { /* expected */ }

    const pinned = await capturePayload("glm", "glm-5.2", GLM, { reasoning: true });
    expect(captured).toBeDefined();
    expect(captured.messages[0].role).toBe("developer");
    expect(pinned.messages[0].role).toBe("system");
    expect(JSON.stringify(pinned)).not.toBe(JSON.stringify(captured));
  });
});
