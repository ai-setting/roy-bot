/**
 * @fileoverview LLM Adapter 工厂
 *
 * 读取 ROY_LLM_PROVIDER 环境变量选择 adapter：
 *   - "pi-ai"   → PiAiAdapter（默认）
 *   - "ai-sdk"  → AiSdkAdapter（fallback）
 *
 * 通过 setLLMProvider() 可在运行时覆盖（用于测试）。
 */
import type { LLMAdapter, AdapterName } from "./adapter";
import { PiAiAdapter } from "./adapter-pi-ai";
import { AiSdkAdapter } from "./adapter-ai-sdk";
import { wrapFunction } from "../log-trace/decorator";

let runtimeOverride: AdapterName | undefined;

export function setLLMProvider(name: AdapterName | undefined): void {
  runtimeOverride = name;
}

export function getLLMProviderOverride(): AdapterName | undefined {
  return runtimeOverride;
}

const _createLLMAdapter = function _createLLMAdapter(): LLMAdapter {
  const arg = runtimeOverride ?? process.env.ROY_LLM_PROVIDER ?? "pi-ai";
  switch (arg) {
    case "pi-ai":
      return new PiAiAdapter();
    case "ai-sdk":
      return new AiSdkAdapter();
    default:
      throw new Error(
        `Invalid ROY_LLM_PROVIDER value: "${arg}". Expected: pi-ai | ai-sdk`,
      );
  }
};

export const createLLMAdapter: () => LLMAdapter = wrapFunction(
  _createLLMAdapter,
  "llm.adapter.factory",
  {
    recordParams: false,
    recordResult: true,
    log: true,
    resultFilter: (_r: any) => ({
      adapter_name: _r?.name,
      env_arg: process.env.ROY_LLM_PROVIDER ?? null,
      runtime_override: runtimeOverride ?? null,
    }),
  },
);
