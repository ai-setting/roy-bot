/**
 * @fileoverview AiSdkAdapter — 包装现有 invoke / invokeNonStream (Vercel AI SDK)
 *
 * 这是 fallback 路径（ROY_LLM_PROVIDER=ai-sdk 时启用），保持现有调用链不断。
 * 不重复实现 AI SDK 集成逻辑；仅做 interface 适配。
 */
import { invoke, invokeNonStream, type InvokeConfig, type InvokeOptions } from "./invoke";
import { embed as aiEmbed, embedMany as aiEmbedMany } from "ai";
import type { LLMAdapter, ChatRequest, ChatResponse, StreamHandle, ResolvedProvider, EmbedRequest, EmbedResponse } from "./adapter";
import { TracedAs } from "../log-trace/decorator";
import { embedParamFilter, embedResultFilter } from "../log-trace/trace-filters";

export class AiSdkAdapter implements LLMAdapter {
  readonly name = "ai-sdk" as const;

  @TracedAs("llm.adapter.ai_sdk.chat", {
    recordParams: true,
    recordResult: true,
    log: true,
    paramFilter: (args: any[]) => {
      const req = args[0];
      return {
        provider: req?.provider,
        model_id: req?.modelId,
        messages_count: req?.messages?.length,
      };
    },
    resultFilter: (r: any) => ({
      finish_reason: r?.finishReason,
      usage_input: r?.usage?.promptTokens,
      usage_output: r?.usage?.completionTokens,
    }),
  })
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const config = this.toInvokeConfig(req);
    const opts = this.toInvokeOptions(req);
    const ctx = { abort: req.signal } as any;
    const out = await invokeNonStream(config, opts, ctx);
    return {
      text: out.content || "",
      finishReason: (out.finishReason as ChatResponse["finishReason"]) || "stop",
      toolCalls: out.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
      usage: out.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      raw: out,
    };
  }

  @TracedAs("llm.adapter.ai_sdk.stream", {
    recordParams: true,
    recordResult: false,
    log: true,
  })
  async stream(req: ChatRequest): Promise<StreamHandle> {
    const config = this.toInvokeConfig(req);
    const opts = this.toInvokeOptions(req);
    const ctx = { abort: req.signal } as any;
    let output: any;
    const events = (async function* () {
      output = await invoke(config, opts, ctx);
      yield output;
    })();
    return {
      events,
      result: async () => ({
        text: output?.content || "",
        finishReason: (output?.finishReason as ChatResponse["finishReason"]) || "stop",
        toolCalls: output?.toolCalls?.map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        usage: output?.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        raw: output,
      }),
    };
  }

  /**
   * ★ 2026-10-22：**只存摘要**（Task #4479）。embed 的 `input` 是大字符串数组，
   * 返回值 embedding 向量更大 —— 正常路径由 filter 存「条数/维度」摘要。
   * 这里额外保留 `recordResult: false` 作为兜底：万一 filter 失效，
   * 宁可没有 result 列，也不能把整个向量数组写进 DB。
   */
  @TracedAs("llm.adapter.ai_sdk.embed", {
    paramFilter: embedParamFilter,
    resultFilter: embedResultFilter,
    recordResult: false,
    log: true,
  })
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const provider = createOpenAICompatible({ name: req.provider, apiKey: req.apiKey, baseURL: req.baseURL });
    const model = provider.textEmbeddingModel(req.modelId);
    const values = Array.isArray(req.input) ? req.input : [req.input];
    const result = values.length === 1
      ? { embeddings: [(await aiEmbed({ model, value: values[0], abortSignal: req.signal })).embedding] }
      : await aiEmbedMany({ model, values, abortSignal: req.signal });
    return { embeddings: result.embeddings, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }

  @TracedAs("llm.adapter.ai_sdk.resolve_provider", {
    recordParams: true,
    recordResult: true,
    log: true,
  })
  async resolveProvider(provider: string, modelId: string): Promise<ResolvedProvider> {
    return {
      api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
      provider,
      modelId,
      contextLimit: 0,
      maxTokensLimit: 0,
    };
  }

  private toInvokeConfig(req: ChatRequest): InvokeConfig {
    return {
      model: `${req.provider}/${req.modelId}`,
      baseURL: req.baseURL,
      apiKey: req.apiKey,
    };
  }

  private toInvokeOptions(req: ChatRequest): InvokeOptions {
    return {
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      // Keep the "provider/model" form so invoke()'s parseModelString() resolves
      // the real provider id (a bare model id falls back to "openai", which
      // would skip provider-specific behavior such as x-opencode-session).
      model: `${req.provider}/${req.modelId}`,
      // Forward the conversation id so the AI SDK path can inject a stable
      // per-conversation x-opencode-session header (see opencode-session.ts).
      context: req.sessionId ? { sessionId: req.sessionId } : undefined,
    };
  }
}
