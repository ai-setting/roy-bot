/**
 * Task #4946 — Kimi For Coding 端点只接受 temperature = 1
 *
 * 用户报错（飞书群 2026-11-04）：
 *   `roy-bot act hi --model kimi/k3.1-pro-highspeed`
 *   → AI_APICallError: invalid temperature: only 1 is allowed for this model
 *     url: https://api.kimi.com/coding/v1/chat/completions
 *     requestBodyValues: { model: "k3.1-pro-highspeed", temperature: 0.7, ... }
 *
 * 实测（直打真实端点，6 个模型全覆盖）：
 *   - temperature=0.7  → HTTP 400 invalid temperature
 *   - temperature=1    → HTTP 200
 *   - 省略 temperature → HTTP 200
 *   ⇒ 该端点对**所有**它服务的模型（k3 / k3-256k / k3.1-pro /
 *     k3.1-pro-highspeed / kimi-for-coding / kimi-for-coding-highspeed）
 *     都只接受 1 或不传。
 *
 * 根因链（修复前）：
 *   llm.ts:622  defaultTemperature = getLLMConfig("llm.temperature", 0.7)
 *   llm.ts:694  temperature: request.temperature ?? defaultTemperature
 *               ⇒ 完全不看 provider 级配置
 *   types.ts:244/373  ProviderConfig.temperature 有声明、schema 也接受，
 *               但**全仓没有任何读取点**（dead field）。
 *               所以用户按直觉在 kimi provider 里写 "temperature": 1 无效 —— 这是个陷阱。
 *
 * 本测试锁定三件事：
 *   1. 端点硬约束表能识别 kimi coding 端点并强制 temperature = 1
 *   2. provider 级 temperature 是活的（配置了就生效）
 *   3. 全局 llm.temperature（文档里叫「全局覆盖」）优先级高于 provider 默认值
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import {
  FIXED_TEMPERATURE_ENDPOINTS,
  findFixedTemperatureRule,
  resolveTemperature,
} from "./temperature-policy";
import { ConfigComponent } from "../../config/config-component";
import { LLMComponent } from "./llm";
import type { Environment } from "../interface";

const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";

describe("Task #4946 — fixed-temperature endpoints", () => {
  test("declares the Kimi For Coding endpoint with temperature 1", () => {
    const rule = findFixedTemperatureRule({ baseURL: KIMI_BASE_URL });
    expect(rule).toBeDefined();
    expect(rule!.temperature).toBe(1);
    // 声明里的 baseURL 片段必须真的出现在用户配置的 baseURL 里
    expect(KIMI_BASE_URL.includes(rule!.baseURLIncludes)).toBe(true);
  });

  test("matches the global endpoint too (no /v1 suffix, pi-ai built-in baseUrl)", () => {
    const rule = findFixedTemperatureRule({ baseURL: "https://api.kimi.com/coding" });
    expect(rule?.temperature).toBe(1);
  });

  test("matches the pi-ai built-in provider id when baseURL is absent", () => {
    const rule = findFixedTemperatureRule({ providerId: "kimi-coding" });
    expect(rule?.temperature).toBe(1);
  });

  test("does NOT match unrelated providers", () => {
    expect(findFixedTemperatureRule({ baseURL: "https://api.deepseek.com/v1" })).toBeUndefined();
    expect(findFixedTemperatureRule({ providerId: "deepseek" })).toBeUndefined();
    // 用户自定义 provider id 不能凭名字被误判（必须靠 baseURL 证据）
    expect(findFixedTemperatureRule({ providerId: "kimi" })).toBeUndefined();
    // review MINOR-1 回归：baseURL 存在但指向第三方网关时，
    // 即使 provider id 是官方别名 kimi-coding 也不能兜底误判
    // （该 provider 明确指向别处，多发 1 也是错的）。
    expect(
      findFixedTemperatureRule({
        providerId: "kimi-coding",
        baseURL: "https://my-proxy.example.com/v1",
      }),
    ).toBeUndefined();
  });

  test("baseURL matching is case-insensitive (URL hosts are)", () => {
    // review MINOR-2 回归：URL host 大小写不敏感
    const rule = findFixedTemperatureRule({
      baseURL: "https://API.KIMI.COM/Coding/v1",
    });
    expect(rule?.temperature).toBe(1);
  });

  test("every declared rule carries a temperature and a non-empty reason", () => {
    expect(FIXED_TEMPERATURE_ENDPOINTS.length).toBeGreaterThan(0);
    for (const rule of FIXED_TEMPERATURE_ENDPOINTS) {
      expect(typeof rule.temperature).toBe("number");
      expect(rule.baseURLIncludes.length).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("Task #4946 — resolveTemperature precedence", () => {
  test("kimi endpoint forces 1 even when a request asks for 0.7", () => {
    const r = resolveTemperature({ requestTemperature: 0.7, baseURL: KIMI_BASE_URL });
    expect(r.temperature).toBe(1);
    expect(r.clampedBy).toBeDefined();
    expect(r.clampedBy!.temperature).toBe(1);
  });

  test("kimi endpoint forces 1 when nothing is requested (the reported bug)", () => {
    const r = resolveTemperature({
      providerTemperature: undefined,
      globalTemperature: 0.7,
      baseURL: KIMI_BASE_URL,
    });
    expect(r.temperature).toBe(1);
    expect(r.clampedBy).toBeDefined();
  });

  test("non-constrained provider keeps the request temperature untouched", () => {
    const r = resolveTemperature({
      requestTemperature: 0.2,
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(r.temperature).toBe(0.2);
    expect(r.clampedBy).toBeUndefined();
  });

  test("non-constrained provider falls back to the built-in 0.7", () => {
    const r = resolveTemperature({ baseURL: "https://api.deepseek.com/v1" });
    expect(r.temperature).toBe(0.7);
    expect(r.clampedBy).toBeUndefined();
  });

  test("provider-level temperature is honoured when no global override exists", () => {
    const r = resolveTemperature({
      providerTemperature: 0,
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(r.temperature).toBe(0);
  });

  test("global llm.temperature overrides the provider-level default", () => {
    const r = resolveTemperature({
      globalTemperature: 0.9,
      providerTemperature: 0.3,
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(r.temperature).toBe(0.9);
  });

  test("per-request temperature overrides both provider and global", () => {
    const r = resolveTemperature({
      requestTemperature: 0.1,
      globalTemperature: 0.9,
      providerTemperature: 0.3,
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(r.temperature).toBe(0.1);
  });

  // LLM_TEMPERATURE / env-source 来源是字符串，不归一化会让 pi-ai 侧 zod 抛
  // "temperature must be a number"（Task #4946 实测过的第二个坑）。
  test("string values coming from env sources are coerced to numbers", () => {
    const r = resolveTemperature({ globalTemperature: "0.7" as unknown as number });
    expect(r.temperature).toBe(0.7);
    expect(typeof r.temperature).toBe("number");
  });

  test("non-numeric strings are treated as unset (fall back to the default)", () => {
    const r = resolveTemperature({
      globalTemperature: "not-a-number" as unknown as number,
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(r.temperature).toBe(0.7);
  });

  test("a coerced numeric string still cannot escape the endpoint hard constraint", () => {
    const r = resolveTemperature({
      globalTemperature: "0.7" as unknown as number,
      baseURL: KIMI_BASE_URL,
    });
    expect(r.temperature).toBe(1);
  });
});

// ===========================================================================
// Integration: the value that actually reaches the adapter (i.e. the HTTP body)
// ===========================================================================
describe("Task #4946 — LLMComponent.invoke sends temperature 1 to the Kimi endpoint", () => {
  const OWNED_ENV_KEYS = [
    "LLM_LLM_DEFAULT_PROVIDER",
    "LLM_LLM_DEFAULT_MODEL",
    "LLM_DEFAULT_PROVIDER",
    "LLM_DEFAULT_MODEL",
    "LLM_LLM_PROVIDERS",
    "LLM_TEMPERATURE",
    "LLM_LLM_TEMPERATURE",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  const originalProvider = process.env.ROY_LLM_PROVIDER;
  let seen: any[] = [];

  function makeRecordingAdapter() {
    const result = {
      text: "ok",
      finishReason: "stop" as const,
      toolCalls: undefined,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
    return {
      name: "pi-ai" as const,
      chat: vi.fn(async (req: any) => {
        seen.push(req);
        return result;
      }),
      stream: vi.fn(async (req: any) => {
        seen.push(req);
        return {
          events: (async function* () {})(),
          result: async () => result,
        };
      }),
      resolveProvider: vi.fn(async () => ({
        api: "openai-completions",
        provider: "x",
        modelId: "y",
        contextLimit: 1000,
        maxTokensLimit: 1000,
      })),
      embed: vi.fn(async () => {
        throw new Error("not implemented");
      }),
    };
  }

  beforeEach(() => {
    for (const k of OWNED_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.ROY_LLM_PROVIDER = "pi-ai";
    seen = [];
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.ROY_LLM_PROVIDER;
    else process.env.ROY_LLM_PROVIDER = originalProvider;
    for (const k of OWNED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  async function buildComponent(opts: {
    providers: Record<string, unknown>;
    defaultProvider: string;
    defaultModel: string;
    globalTemperature?: number;
  }) {
    const configComponent = new ConfigComponent({});
    configComponent.set("llm.providers", opts.providers);
    configComponent.set("llm.defaultProvider", opts.defaultProvider);
    configComponent.set("llm.defaultModel", opts.defaultModel);
    if (opts.globalTemperature !== undefined) {
      configComponent.set("llm.temperature", opts.globalTemperature);
    }
    const comp = new LLMComponent();
    comp.__setAdapterForTest(makeRecordingAdapter() as any);
    const fakeEnv = {
      pushEnvEvent: () => {},
      subscribeTo: () => () => {},
      getComponent: () => undefined,
    } as any;
    await comp.init({
      name: "llm",
      version: "1.0.0",
      enabled: true,
      env: fakeEnv as unknown as Environment,
      options: { configComponent },
    });
    return comp;
  }

  test("kimi provider: global 0.7 is overridden to 1 (regression for the reported 400)", async () => {
    const comp = await buildComponent({
      providers: {
        kimi: {
          provider: "openai-compatible",
          apiKey: "sk-test",
          baseURL: KIMI_BASE_URL,
          models: ["k3.1-pro-highspeed"],
          defaultModel: "k3.1-pro-highspeed",
        },
      },
      defaultProvider: "kimi",
      defaultModel: "k3.1-pro-highspeed",
      globalTemperature: 0.7,
    });

    await comp.invoke({ messages: [{ role: "user", content: "hi" }], skipThresholdCheck: true });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].provider).toBe("kimi");
    expect(seen[0].modelId).toBe("k3.1-pro-highspeed");
    expect(seen[0].temperature).toBe(1);
  });

  test("kimi provider: an explicit caller temperature of 0.3 is still forced to 1", async () => {
    const comp = await buildComponent({
      providers: {
        kimi: {
          provider: "openai-compatible",
          apiKey: "sk-test",
          baseURL: KIMI_BASE_URL,
          defaultModel: "k3.1-pro-highspeed",
        },
      },
      defaultProvider: "kimi",
      defaultModel: "k3.1-pro-highspeed",
    });

    await comp.invoke({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
      skipThresholdCheck: true,
    });

    expect(seen[0].temperature).toBe(1);
  });

  test("unconstrained provider still receives the global temperature unchanged", async () => {
    const comp = await buildComponent({
      providers: {
        deepseek: {
          provider: "openai-compatible",
          apiKey: "sk-test",
          baseURL: "https://api.deepseek.com/v1",
          defaultModel: "deepseek-chat",
        },
      },
      defaultProvider: "deepseek",
      defaultModel: "deepseek-chat",
      globalTemperature: 0.7,
    });

    await comp.invoke({ messages: [{ role: "user", content: "hi" }], skipThresholdCheck: true });

    expect(seen[0].temperature).toBe(0.7);
  });

  test("provider-level temperature reaches the adapter when no global override is set", async () => {
    const comp = await buildComponent({
      providers: {
        ali: {
          provider: "openai-compatible",
          apiKey: "sk-test",
          baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          defaultModel: "qwen3-coder-plus",
          temperature: 0,
        },
      },
      defaultProvider: "ali",
      defaultModel: "qwen3-coder-plus",
    });

    await comp.invoke({ messages: [{ role: "user", content: "hi" }], skipThresholdCheck: true });

    expect(seen[0].temperature).toBe(0);
  });
});
