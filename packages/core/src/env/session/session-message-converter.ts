/**
 * @fileoverview Session Message Converter
 * 
 * Converts between SessionMessage (storage format) and AI SDK ModelMessage (LLM format).
 * 
 * This module provides a class-based API for message conversion.
 */

import { randomUUID } from "crypto";
import type { SessionMessage, TextPart, ToolCallPart, ToolResultPart, ReasoningPart, FilePart, ImagePart, SessionPart, MessagePart } from "./types";
import { safeParseToolArgs } from "../llm/tool-args-parser";

// ============================================================================
// Constants
// ============================================================================

/**
 * Default budget tokens for extended reasoning (Anthropic-style)
 */
const DEFAULT_REASONING_BUDGET_TOKENS = 10000;

// AI SDK ModelMessage type (simplified for this module)
interface ModelMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ModelContentPart[];
}

/**
 * Content part for AI SDK ModelMessage
 */
type ModelContentPart = 
  | TextContentPart 
  | ReasoningContentPart 
  | ToolCallContentPart 
  | ToolResultContentPart 
  | FileContentPart
  | ImageContentPart;

interface TextContentPart {
  type: "text";
  text: string;
  synthetic?: boolean;
}

interface ReasoningContentPart {
  type: "reasoning";
  text: string;
  reasoningType?: "core" | "effort" | "summary";
}

interface ToolCallContentPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolResultContentPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: string;
}

interface FileContentPart {
  type: "file";
  url: string;
  mimeType?: string;
  filename?: string;
}

/**
 * AI SDK v6 image part (lossless round-trip with `ImagePart`).
 *
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-core/image-part
 *
 * The `image` field accepts `string | URL | Uint8Array` (and `DataContent`,
 * which is itself a union that includes `Uint8Array`). We widen the local
 * type to `Uint8Array` so that legacy `{type:"Buffer", data:[]}` payloads
 * recovered from SQLite can be rehydrated into a typed array instead of
 * a plain object. This unblocks the B1 round-trip regression.
 */
interface ImageContentPart {
  type: "image";
  /** Image data — base64/data URL, raw bytes, or a remote URL */
  image: string | URL | Uint8Array;
  /** Optional MIME type (e.g. "image/png") */
  mimeType?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build an `ImageContentPart` from a session `ImagePart`, preserving the
 * image data byte-for-byte. Centralizes the field mapping so both
 * `toModelMessage` paths (assistant + user/system) stay in sync.
 *
 * Defensive: also normalizes the legacy shape that
 * `JSON.stringify(Buffer)` produces (`{type:"Buffer", data:[byte,...]}`)
 * into a real `Uint8Array`, so AI SDK v6's `userModelMessageSchema` can
 * validate it. Without this, multi-turn reload of multimodal sessions
 * would throw `InvalidPromptError`. See review Blocker B1.
 */
function toModelImagePart(imagePart: ImagePart): ImageContentPart {
  return {
    type: "image",
    image: normalizeImagePayload(imagePart.image, imagePart.mimeType),
    mimeType: imagePart.mimeType,
  };
}

/**
 * Type guard for the legacy `JSON.stringify(Buffer)` shape.
 *
 * @see https://nodejs.org/api/buffer.html#class-method-bufferfromobject
 */
function isLegacyBufferShape(v: unknown): v is { type: "Buffer"; data: number[] } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array) &&
    !(v instanceof URL) &&
    (v as { type?: unknown }).type === "Buffer" &&
    Array.isArray((v as { data?: unknown }).data)
  );
}

/**
 * Coerce an image payload into a legal AI SDK v6 form
 * (`string | URL | Uint8Array`).
 *
 * - Already-legal values pass through unchanged.
 * - Live Node `Buffer` instances are converted to base64 data URLs so that
 *   a subsequent `JSON.stringify` produces a JSON-safe value (Buffer would
 *   otherwise serialize to the legacy `{type:"Buffer", data:[...]}` shape
 *   and break the round-trip).
 * - Legacy `{type:"Buffer", data:[...]}` objects (from old SQLite rows
 *   persisted before storage switched to data URL) are converted to
 *   `Uint8Array`.
 * - Plain objects that look like a Buffer but lack the proper `data`
 *   array fall through to the defensive fallback.
 */
function normalizeImagePayload(
  image: unknown,
  mimeType: string | undefined
): string | URL | Uint8Array {
  // 1) Already a legal AI SDK type — no transformation
  if (typeof image === "string" || image instanceof URL) {
    return image as string | URL;
  }

  // 2) Live Node Buffer at the persistence boundary. Convert to a base64
  //    data URL so `JSON.stringify` round-trip is JSON-safe. We MUST do
  //    this BEFORE the Uint8Array branch below because Node's `Buffer`
  //    is a subclass of `Uint8Array` — checking `instanceof Uint8Array`
  //    alone would let Buffers slip through and re-serialize to
  //    `{type:"Buffer", data:[...]}`, which is the B1 bug.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(image)) {
    const mime = mimeType ?? "image/jpeg";
    return `data:${mime};base64,${(image as Buffer).toString("base64")}`;
  }

  // 3) Real `Uint8Array` (e.g. from a non-Node runtime like browser,
  //    Deno, or Bun's native typed array). Convert to a base64 data URL
  //    — same as the Buffer branch above — so that JSON.stringify of the
  //    persisted SessionMessage is byte-safe and the reload path doesn't
  //    hand a `{0:1,1:2,...}` shape to AI SDK v6's userModelMessageSchema
  //    (which would throw InvalidPromptError).
  //
  //    I3 (review-cache-stability.md): previously this branch was a
  //    pass-through, which worked under Node Buffer-only callers but
  //    was a race condition for any non-Node future runtime.
  if (image instanceof Uint8Array) {
    if (typeof Buffer !== "undefined") {
      // Node / Bun path: Buffer.from(Uint8Array) is a no-op view, so
      // toString("base64") is the fastest path.
      const mime = mimeType ?? "image/jpeg";
      return `data:${mime};base64,${Buffer.from(image).toString("base64")}`;
    }
    // Pure browser fallback: build the base64 string from raw bytes.
    let binary = "";
    for (let i = 0; i < image.length; i++) {
      binary += String.fromCharCode(image[i]);
    }
    const mime = mimeType ?? "image/jpeg";
    return `data:${mime};base64,${(globalThis as { btoa?: (s: string) => string }).btoa?.(binary) ?? binary}`;
  }

  // 4) Legacy `{type:"Buffer", data:[]}` from JSON.parse on a previously-
  //    persisted Buffer. Restore as a real Uint8Array.
  if (isLegacyBufferShape(image)) {
    return new Uint8Array(image.data);
  }

  // 5) Defensive fallback: return as-is. If we reach here, the caller
  //    supplied something exotic that we can't normalize. This preserves
  //    forward compatibility (e.g. a future typed array from a different
  //    runtime) without throwing.
  return image as string | URL | Uint8Array;
}

/**
 * SessionMessageConverter
 * 
 * Converts between SessionMessage (storage format) and AI SDK ModelMessage (LLM format).
 * 
 * @example
 * ```typescript
 * const converter = new SessionMessageConverter();
 * const modelMsg = converter.toModelMessage(sessionMsg);
 * const sessionMsg = converter.fromModelMessage(modelMsg);
 * ```
 */
export class SessionMessageConverter {
  /**
   * Convert a SessionMessage to AI SDK ModelMessage format
   * 
   * @param msg - SessionMessage to convert
   * @returns ModelMessage compatible with AI SDK v6
   */
  toModelMessage(msg: SessionMessage): ModelMessage {
    // ============ Assistant Message ============
    if (msg.role === "assistant") {
      const content: ModelContentPart[] = [];
      
      // Process all parts in order to preserve their original order
      for (const part of msg.parts || []) {
        if (part.type === "text") {
          const textPart = part as TextPart;
          content.push({ 
            type: "text", 
            text: textPart.content,
            ...(textPart.synthetic !== undefined && { synthetic: textPart.synthetic }),
          });
        } else if (part.type === "reasoning") {
          const reasoningPart = part as ReasoningPart;
          content.push({ 
            type: "reasoning", 
            text: reasoningPart.content,
            reasoningType: reasoningPart.reasoningType,
          });
        } else if (part.type === "tool-call") {
          const toolPart = part as unknown as ToolCallPart;
          let parsedArgs: Record<string, unknown> = {};
          
          // Safely parse JSON arguments with error handling
          if (typeof toolPart.arguments === "string") {
            parsedArgs = safeParseToolArgs(toolPart.arguments);
          } else {
            parsedArgs = toolPart.arguments;
          }
          
          content.push({
            type: "tool-call",
            toolCallId: toolPart.toolCallId,
            toolName: toolPart.toolName,
            input: parsedArgs,
          });
        } else if (part.type === "file") {
          // File parts in assistant messages are converted to AI SDK file content
          const filePart = part as unknown as FilePart;
          content.push({
            type: "file",
            url: filePart.url,
            mimeType: filePart.mime,
            filename: filePart.filename,
          });
        } else if (part.type === "image") {
          // Image parts in assistant messages — preserved lossless for round-trip
          // (LLMs do not normally emit images, but if a multimodal model does,
          // we forward it through without dropping it).
          content.push(toModelImagePart(part as unknown as ImagePart));
        }
        // Note: tool-result and checkpoint parts are skipped for assistant messages
        // - tool-result belongs to tool messages (handled below)
        // - checkpoint is a storage/compression marker, not needed for LLM calls
        else if (part.type === "tool-result" || part.type === "checkpoint") {
          // These types are intentionally skipped for assistant messages
          // Tool results belong to tool role messages, checkpoints are metadata
        }
        else {
          // Log any other unknown part types for debugging
          console.debug(`[session-message-converter] Skipping unsupported part type in assistant: ${(part as any).type}`);
        }
      }
      
      // If no parts, fall back to content field
      if (content.length === 0 && msg.content) {
        return { role: "assistant", content: msg.content };
      }
      
      return { role: "assistant", content };
    }
    
    // ============ Tool Message ============
    if (msg.role === "tool") {
      const toolPart = msg.parts?.find(p => p.type === "tool-result") as ToolResultPart | undefined;
      return {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: toolPart?.toolCallId || "",
          toolName: toolPart?.toolName || "",
          output: toolPart?.output || msg.content || "",
        }],
      };
    }
    
    // ============ User / System Message ============
    // Multimodal user messages have `parts` (text + image) that must be
    // re-emitted as a content array, not just the string `msg.content`.
    if (msg.role === "user" || msg.role === "system") {
      const parts = msg.parts || [];
      const hasMultimodal = parts.some(
        (p) => p.type === "image" || p.type === "file"
      );

      if (hasMultimodal) {
        const content: ModelContentPart[] = [];
        for (const part of parts) {
          if (part.type === "text") {
            content.push({ type: "text", text: (part as TextPart).content });
          } else if (part.type === "image") {
            content.push(toModelImagePart(part as unknown as ImagePart));
          } else if (part.type === "file") {
            const filePart = part as unknown as FilePart;
            content.push({
              type: "file",
              url: filePart.url,
              mimeType: filePart.mime,
              filename: filePart.filename,
            });
          }
          // Other part types (tool-call/result, reasoning, checkpoint) are
          // not part of the user/system message body — skip them silently.
        }
        return {
          role: msg.role as "system" | "user",
          content,
        };
      }
    }

    return {
      role: msg.role as "system" | "user" | "assistant" | "tool",
      content: msg.content || "",
    };
  }

  /**
   * Convert an AI SDK ModelMessage to SessionMessage format
   * 
   * @param aiMsg - AI SDK ModelMessage to convert (accepts any object with role and content)
   * @param options - Optional sessionID and messageID
   * @returns SessionMessage compatible with storage format
   * 
   * 设置 metadata.type 以便后续正确过滤：
   * - "tool_call": assistant 消息包含 tool-call parts
   * - "tool_result": tool 消息
   */
  fromModelMessage(
    aiMsg: { role: string; content: unknown; [key: string]: unknown },
    options?: { sessionID?: string; messageID?: string }
  ): SessionMessage {
    const parts: SessionPart[] = [];
    // Handle content that could be string, array, or other types
    const content = typeof aiMsg.content === 'string' || Array.isArray(aiMsg.content) 
      ? aiMsg.content 
      : "";
    let hasToolCallPart = false;
    let hasToolResultPart = false;
    
    if (typeof content === "string") {
      parts.push({ type: "text", content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as unknown as Record<string, unknown>;
        
        if (p.type === "text") {
          parts.push({ type: "text", content: (p.text as string) || "" });
        } 
        else if (p.type === "reasoning") {
          parts.push({
            type: "reasoning",
            content: (p.text as string) || "",
            reasoningType: p.reasoningType as "core" | "effort" | "summary" | undefined,
            state: "completed",
          } as SessionPart);
        }
        else if (p.type === "tool-call") {
          hasToolCallPart = true;
          // 🛡️ 运行时类型检查：检测模型双重 stringify 导致的 input 为字符串的情况
          let args: unknown = p.input;
          if (typeof p.input === "string") {
            args = safeParseToolArgs(p.input);
          }
          parts.push({
            type: "tool-call",
            toolCallId: p.toolCallId as string,
            toolName: p.toolName as string,
            arguments: args,
            state: "pending",
          } as SessionPart);
        }
        else if (p.type === "tool-result") {
          hasToolResultPart = true;
          parts.push({
            type: "tool-result",
            toolCallId: p.toolCallId as string,
            toolName: p.toolName as string,
            output: typeof p.output === "string" ? p.output : JSON.stringify(p.output),
            state: "completed",
          } as SessionPart);
        }
        else if (p.type === "file") {
          parts.push({
            type: "file",
            mime: (p.mimeType as string) || "application/octet-stream",
            url: p.url as string,
            filename: p.filename as string | undefined,
          } as SessionPart);
        }
        else if (p.type === "image") {
          // AI SDK v6 ImagePart: { type: 'image', image: DataContent | URL }
          // Persist to SessionMessage as an ImagePart so the image survives
          // a multi-turn reload (instead of being silently dropped).
          //
          // Normalize the image payload at the storage boundary:
          // - If the caller hands us a Node `Buffer` (e.g. from
          //   `parseImageInput` reading a local file), convert it to a
          //   base64 data URL so the subsequent `JSON.stringify` round-trip
          //   is JSON-safe. Without this, `Buffer` would serialize to
          //   `{type:"Buffer", data:[byte1,...]}` and AI SDK v6's
          //   `userModelMessageSchema` would reject the rehydrated message
          //   with `InvalidPromptError` on the next turn.
          // - Strings and URL objects pass through unchanged.
          const imageData = normalizeImagePayload(
            p.image,
            p.mimeType as string | undefined
          );
          parts.push({
            type: "image",
            image: imageData as string | URL,
            mimeType: p.mimeType as string | undefined,
          } as SessionPart);
        }
        else {
          // Log unknown part type for debugging (Minor issue #4)
          // Unknown types are skipped to maintain forward compatibility
          console.debug(`[session-message-converter] Unknown part type: ${p.type}`);
        }
      }
    }
    
    // Determine metadata type based on role and content parts
    let metadataType: "tool_call" | "tool_result" | undefined;
    if (aiMsg.role === "assistant" && hasToolCallPart) {
      metadataType = "tool_call";
    } else if (aiMsg.role === "tool") {
      metadataType = "tool_result";
    }
    
    // Build the result object
    const result: SessionMessage = {
      id: options?.messageID || `msg_${randomUUID()}`,
      sessionID: options?.sessionID || "",
      role: aiMsg.role as SessionMessage["role"],
      timestamp: Date.now(),
      parts,
      content: typeof content === "string" ? content : "",
    };
    
    // Add metadata with type if applicable
    if (metadataType) {
      result.metadata = { type: metadataType };
    }
    
    return result;
  }

  /**
   * Convert a list of SessionMessages to AI SDK history format
   * 
   * @param messages - Array of SessionMessages to convert
   * @returns Array of ModelMessages filtered by archived status
   */
  sessionToHistory(messages: SessionMessage[]): ModelMessage[] {
    return messages
      .filter(msg => !msg.metadata?.isArchived && !msg.isArchived)
      .map(msg => this.toModelMessage(msg));
  }

  /**
   * Extract provider-specific options from SessionMessage
   * 
   * Some models (e.g., DeepSeek R1, Kimi k2.5) require reasoning configuration
   * through providerOptions.
   * 
   * @param msg - SessionMessage to extract options from
   * @returns Provider-specific options object for LLM calls
   */
  extractProviderOptions(msg: SessionMessage): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    
    // Check for reasoning parts that might need provider options
    const reasoningParts = msg.parts?.filter(p => p.type === "reasoning") as ReasoningPart[] | undefined;
    
    if (reasoningParts && reasoningParts.length > 0) {
      // Extract reasoning type from the first reasoning part
      const firstReasoning = reasoningParts[0];
      if (firstReasoning.reasoningType) {
        // OpenAI-compatible thinking options
        options.openai = {
          thinking: {
            type: firstReasoning.reasoningType === "effort" ? "extended" : "core",
          },
        };
        
        // Anthropic-style budget tokens (if effort type)
        if (firstReasoning.reasoningType === "effort") {
          // Get budget tokens from metadata or use default
          const budgetTokens = (firstReasoning.metadata?.tokenCount as number) || DEFAULT_REASONING_BUDGET_TOKENS;
          
          options.anthropic = {
            thinking: {
              type: "enabled",
              budgetTokens,
            },
          };
        }
      }
    }
    
    return options;
  }

  /**
   * Migrate old format message to new format
   * 
   * Handles backward compatibility by converting old messages with just content
   * to new format with proper parts array.
   * 
   * @param oldMsg - Message in possibly old format
   * @returns Message in new format with parts array
   */
  migrateMessage(oldMsg: Partial<SessionMessage>): SessionMessage {
    // If already has parts with new format (parts have proper type field), return as is
    if (oldMsg.parts && oldMsg.parts.length > 0) {
      const firstPart = oldMsg.parts[0] as unknown as Record<string, unknown>;
      // Check if it's new format by looking for type field
      if (firstPart && typeof firstPart.type === "string" && firstPart.type.length > 0) {
        return {
          ...oldMsg,
          content: oldMsg.content || "",
        } as SessionMessage;
      }
    }
    
    // Old format: content is plain text, need to wrap as text part
    return {
      ...oldMsg,
      content: oldMsg.content || "",
      parts: oldMsg.content ? [{ type: "text", content: oldMsg.content }] : [],
    } as SessionMessage;
  }
}

// ============================================================================
// Backward Compatibility - Deprecated exports
// ============================================================================
// 
// These functions are kept for backward compatibility but will be removed in a future version.
// Please use SessionMessageConverter class instead.
//
// @deprecated Use SessionMessageConverter.toModelMessage() instead
export function toModelMessage(msg: SessionMessage): ModelMessage {
  const converter = new SessionMessageConverter();
  return converter.toModelMessage(msg);
}

// @deprecated Use SessionMessageConverter.fromModelMessage() instead
export function fromModelMessage(
  aiMsg: { role: string; content: unknown; [key: string]: unknown },
  options?: { sessionID?: string; messageID?: string }
): SessionMessage {
  const converter = new SessionMessageConverter();
  return converter.fromModelMessage(aiMsg, options);
}

// @deprecated Use SessionMessageConverter.sessionToHistory() instead
export function sessionToHistory(messages: SessionMessage[]): ModelMessage[] {
  const converter = new SessionMessageConverter();
  return converter.sessionToHistory(messages);
}

// @deprecated Use SessionMessageConverter.extractProviderOptions() instead
export function extractProviderOptions(msg: SessionMessage): Record<string, unknown> {
  const converter = new SessionMessageConverter();
  return converter.extractProviderOptions(msg);
}

// @deprecated Use SessionMessageConverter.migrateMessage() instead
export function migrateMessage(oldMsg: Partial<SessionMessage>): SessionMessage {
  const converter = new SessionMessageConverter();
  return converter.migrateMessage(oldMsg);
}
