/**
 * @fileoverview Context Handler Service
 * 
 * 处理 env.handle_query 的上下文阈值检测和压缩逻辑
 * 
 * 功能：
 * 1. 包装 handle_query，捕获 ContextError
 * 2. 两阶段自动压缩：
 *    - 阶段1: 调用 SessionComponent.generateCompactHint() 生成场景化提示
 *    - 阶段2: 调用 SessionComponent.compact() 并传入 scenarioHint
 * 3. 用 checkpoint 构造新 query 并重试
 * 4. 生成 trace id 用于调用链追踪
 */

import type { Environment, AgentContext, ContentPart } from "@ai-setting/roy-bot-core";
import type { SessionComponent, SessionCheckpoint } from "@ai-setting/roy-bot-core";
import {
  ContextError,
  ErrorCodes,
  getTracerProvider,
  type OTelTracer,
  TracedAs,
} from "@ai-setting/roy-bot-core";
import { createLogger } from "@ai-setting/roy-bot-core";

// 创建 logger
const logger = createLogger("context-handler");

export interface CompactResult {
  success: boolean;
  checkpoint?: SessionCheckpoint;
  newQuery?: string | ContentPart[];
  error?: string;
}

export interface HandleQueryOptions {
  /** 最大重试次数（compact 后） */
  maxRetries?: number;
  /** 是否自动压缩 */
  autoCompact?: boolean;
}

/**
 * Context Handler Service
 * 
 * 处理 env.handle_query 的上下文阈值检测和压缩逻辑
 * 
 * 采用两阶段自动压缩流程：
 * - 阶段1: 根据历史消息生成场景化的压缩提示 (generateCompactHint)
 * - 阶段2: 使用生成的提示进行实际的压缩 (compact with scenarioHint)
 */
export class ContextHandlerService {
  private readonly maxRetries: number;
  private readonly autoCompact: boolean;
  private tracer?: OTelTracer;

  constructor(
    private env: Environment,
    private sessionComponent: SessionComponent,
    options: HandleQueryOptions = {}
  ) {
    this.maxRetries = options.maxRetries ?? 1;
    this.autoCompact = options.autoCompact ?? true;
    
    // 初始化 tracer
    this.initializeTracer();
  }

  /**
   * 初始化 tracer
   */
  private initializeTracer(): void {
    try {
      this.tracer = getTracerProvider().getTracer("roy-tracer");
    } catch {
      // Tracer 可能尚未初始化，延迟初始化
      this.tracer = undefined;
    }
  }

  /**
   * 获取 tracer 实例
   */
  private getTracerInstance(): OTelTracer | undefined {
    if (!this.tracer) {
      try {
        this.tracer = getTracerProvider().getTracer("roy-tracer");
      } catch {
        return undefined;
      }
    }
    return this.tracer;
  }

  /**
   * 包装 handle_query，添加上下文阈值处理和 trace 追踪
   *
   * 接受 string | ContentPart[]（多模态）。如果是 ContentPart[]，直接
   * 透传给 env.handle_query()，因为 ContextHandler 不需要 inspect
   * content parts（压缩基于 session messages，跟原始 query 无关）。
   */
  async handleQueryWithContext(
    query: string | ContentPart[],
    context?: AgentContext
  ): Promise<string> {
    // 从 metadata 获取 trace id（如果上层已设置）
    const traceId = (context?.metadata as Record<string, unknown>)?.traceId as string;
    const sessionId = context?.sessionId;
    
    // 获取 tracer 实例并启动根 span
    const tracer = this.getTracerInstance();
    // 把多模态 query 压成 string 用于 trace 属性（避免 Buffer / 二进制污染 trace）
    const queryForTrace = typeof query === "string"
      ? query
      : JSON.stringify(query).substring(0, 200);
    const span = tracer?.startSpan("handleQueryWithContext", {
      attributes: {
        query: queryForTrace,
        queryKind: typeof query === "string" ? "text" : "multimodal",
        sessionId,
        traceId,
      },
    });

    let compactCount = 0;
    const MAX_COMPACT_RETRIES = 10;

    try {
      while (true) {
        try {
          // 正常执行 handle_query
          const result = await this.env.handle_query(query, context);
          
          // 结束根 span（成功）
          if (span) {
            span?.end(result);
          }
          
          return result;

        } catch (error) {
          // 检查是否是上下文阈值异常
          if (error instanceof ContextError && error.code === ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED) {
            if (!this.autoCompact) {
              logger.warn("Auto compact disabled, propagating error");
              
              // 结束根 span（失败）
              if (span) {
                span?.end(undefined, error as Error);
              }
              throw error;
            }

            // ContextError 不消耗 maxRetries，独立安全上限防死循环
            if (compactCount >= MAX_COMPACT_RETRIES) {
              logger.error("Context threshold exceeded after max compact retries", { 
                compactCount, 
                maxCompactRetries: MAX_COMPACT_RETRIES 
              });
              
              // 结束根 span（失败）
              if (span) {
                span?.end(undefined, error as Error);
              }
              throw error;
            }
            compactCount++;

            logger.info(`Context threshold exceeded, compacting (compact #${compactCount})`);

            // 发布阈值即将压缩事件
            this.env.pushEnvEvent({
              type: "context.threshold_exceeded",
              metadata: {
                sessionId,
                traceId,
              },
              payload: {
                totalTokens: error.usage?.totalTokens,
                contextWindow: error.contextWindow,
                compactCount,
              },
            });

            // 执行两阶段压缩
            const compactResult = await this.compactSessionWithTwoPhases(
              context?.sessionId,
              query
            );

            if (!compactResult.success) {
              logger.error("Compact failed", { error: compactResult.error });
              
              // 结束根 span（失败）
              if (span) {
                span?.end(undefined, error as Error);
              }
              throw error;
            }

            // 用新的 query 重试。
            // 注意：compactResult.newQuery 与原始 query 可能相同，这是正常的。
            // compaction 的实质作用是减少 session messages（归档旧消息+添加 checkpoint），
            // 从而使同样的 query 能在缩减后的上下文中成功执行。
            // compactCount 上限（MAX_COMPACT_RETRIES）已防止无限循环。
            if (!compactResult.newQuery) {
              logger.error("Compact succeeded but produced undefined query, terminating", {
                compactCount,
                query,
              });
              // 结束根 span（失败）
              if (span) {
                span?.end(undefined, error as Error);
              }
              throw error;
            }
            query = compactResult.newQuery;

            continue;
          }

          // 其他错误直接抛出
          // 结束根 span（失败）
          if (span) {
            span?.end(undefined, error as Error);
          }
          throw error;
        }
      }
    } finally {
      // 清理 span 上下文
      if (span) {
        tracer?.endSpan(span);
      }
    }
  }

  /**
   * 执行两阶段 session compact
   * 
   * 阶段1: 生成场景化压缩提示 (generateCompactHint)
   * 阶段2: 使用提示进行压缩 (compact with scenarioHint)
   */
  @TracedAs("context-handler.compactSessionWithTwoPhases", { recordParams: true, recordResult: true })
  async compactSessionWithTwoPhases(
    sessionId?: string,
    originalQuery?: string | ContentPart[]
  ): Promise<CompactResult> {
    if (!sessionId) {
      return { success: false, error: "No session ID provided" };
    }

    try {
      // 发布压缩开始事件
      this.env.pushEnvEvent({
        type: "context.compacting",
        metadata: { sessionId },
        payload: { phase: "two-phase" },
      });

      // ========================================
      // 阶段1: 生成场景化压缩提示
      // ========================================
      let scenarioHint = "";
      try {
        scenarioHint = await this.sessionComponent.generateCompactHint(sessionId);
        logger.info("[Phase 1] Compact hint generated", {
          sessionId,
          hintLength: scenarioHint.length,
          hintPreview: scenarioHint.substring(0, 100),
        });
      } catch (hintError) {
        // 如果生成提示失败，继续使用空提示（不影响主流程）
        logger.warn("[Phase 1] Hint generation failed, continuing with empty hint", {
          error: hintError instanceof Error ? hintError.message : String(hintError),
        });
        scenarioHint = "";
      }

      // 发布提示生成完成事件
      this.env.pushEnvEvent({
        type: "context.hint_generated",
        metadata: { sessionId },
        payload: {
          hintLength: scenarioHint.length,
          hintPreview: scenarioHint.substring(0, 200),
        },
      });

      // ========================================
      // 阶段2: 执行实际压缩
      // ========================================
      const result = await this.sessionComponent.compact(sessionId, {
        // ★ Task #4933（C 方案）：CompactOptions 只剩 scenarioHint 一个语义字段。
        //   旧的 summary 字段在 compact() 中从未被读取（HEAD 之前即如此），
        //   这里构造的 "Auto-compacted. Original query: ..." 从未进入 checkpoint 正文，
        //   删除它不会改变任何运行时行为。
        scenarioHint,  // 传入场景化提示
      });

      // 发布压缩完成事件
      this.env.pushEnvEvent({
        type: "context.compacted",
        metadata: { sessionId },
        payload: {
          checkpointId: result.checkpoint.id,
          messagesCompacted: result.deletedMessageCount,
          scenarioHintUsed: !!scenarioHint,
        },
      });

      // 构造新 query
      // 多模态 query (ContentPart[]) 在 compact 后保持不变——压缩只减少
      // session history，不改变用户输入的图片/文本
      const newQuery: string | ContentPart[] = Array.isArray(originalQuery)
        ? originalQuery
        : this.constructQueryWithCheckpoint(
            result.checkpoint,
            originalQuery as string | undefined
          );

      logger.info("[Phase 2] Compact completed", {
        checkpointId: result.checkpoint.id,
        deletedMessageCount: result.deletedMessageCount,
        scenarioHintUsed: !!scenarioHint,
      });

      return {
        success: true,
        checkpoint: result.checkpoint,
        newQuery,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Two-phase compact failed", { error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 执行 session compact（兼容旧接口，内部调用两阶段版本）
   */
  async compactSession(
    sessionId?: string,
    originalQuery?: string
  ): Promise<CompactResult> {
    return this.compactSessionWithTwoPhases(sessionId, originalQuery);
  }

  /**
   * 用 checkpoint 构造新 query
   *
   * 设计原则：checkpoint 上下文（C 方案：整段自然语言 content）
   * 已通过 createCheckpointMessage() 作为 session 的 user 消息存储，
   * 并在 retry 时通过 getConversationHistory() → getContext() 加载到
   * LLM messages 数组中。因此这里不需要再把 checkpoint 数据塞进 query，
   * query 保持短小，仅包含原始用户输入。
   *
   * 如果原始 query 为空，返回一个简短提示引导 LLM 继续工作。
   */
  @TracedAs("context-handler.constructQuery")
  private constructQueryWithCheckpoint(
    _checkpoint: SessionCheckpoint,
    originalQuery?: string
  ): string {
    const MAX_QUERY_LENGTH = 4000; // 原始 query 超过 4000 字符时截断

    if (originalQuery && originalQuery.trim().length > 0) {
      const trimmedQuery = originalQuery.length > MAX_QUERY_LENGTH
        ? originalQuery.substring(0, MAX_QUERY_LENGTH)
          + `\n... (原始输入共 ${originalQuery.length} 字符，已截断至 ${MAX_QUERY_LENGTH})`
        : originalQuery;
      return trimmedQuery;
    }

    // 没有原始 query 时，给出简短引导
    // checkpoint 上下文已在 session messages 中，LLM 能看到
    return "Please continue to work on the current task.";
  }
}
