/**
 * @fileoverview Session Manager - Session 管理共享逻辑
 *
 * 从 act.ts 抽取，供 interactive 复用
 *
 * 功能：
 * - 获取/创建 Session
 * - 设置活跃会话
 * - 切换会话
 * - P2: 多模态 attach 列表 (attachedImages)
 */

import { OutputService } from "../../services/output.service";
import type { Session, SessionComponent, ContentPart } from "@ai-setting/roy-bot-core";
import { parseImageInput } from "@ai-setting/roy-bot-core";

export interface SessionInitResult {
  sessionId: string;
  isNewSession: boolean;
  sessionTitle: string;
}

export interface SessionManagerOptions {
  sessionComponent: SessionComponent;
  output: OutputService;
  quiet: boolean;
}

/**
 * SessionManager - 会话管理
 */
export class SessionManager {
  private sessionComponent: SessionComponent;
  private output: OutputService;
  private quiet: boolean;

  // P2: 多模态 attach 列表
  // - 在 REPL 中通过 /attach <path> 累积
  // - 用户回车时和 text 一起拼成 ContentPart[] 送给 LLM
  // - 一次只属于一个 session, 切换 session 不保留 (跟 opencode 设计一致)
  // - 用 Map<rawPath, ContentPart> 同时承担顺序和 dedupe
  private attachedImagesMap: Map<string, ContentPart> = new Map();

  constructor(options: SessionManagerOptions) {
    this.sessionComponent = options.sessionComponent;
    this.output = options.output;
    this.quiet = options.quiet;
  }

  /**
   * 初始化会话
   *
   * 优先级：
   * 1. 指定 sessionId -> 验证并使用
   * 2. --continue -> 获取上次会话
   * 3. 无 -> 创建新会话
   */
  async init(sessionId?: string, isContinue?: boolean): Promise<SessionInitResult> {
    let targetSessionId = sessionId;
    let isNewSession = false;

    // --continue 模式
    if (isContinue && !targetSessionId) {
      const activeSession = await this.sessionComponent.getActiveSession();
      if (activeSession) {
        targetSessionId = activeSession.id;
        if (!this.quiet) {
          this.output.info(`继续会话: ${activeSession.title} (${targetSessionId})`);
        }
      } else {
        this.output.warn("没有找到上次会话，将创建新会话");
      }
    }

    // 指定 session 验证
    if (targetSessionId) {
      await this.sessionComponent.setActiveSession(targetSessionId);
      const session = await this.sessionComponent.get(targetSessionId);
      if (session) {
        if (!this.quiet) {
          this.output.info(`会话: ${session.title} (${targetSessionId})`);
        }
      } else {
        this.output.warn(`会话不存在: ${targetSessionId}，将创建新会话`);
        targetSessionId = undefined;
      }
    }

    // 创建新会话
    if (!targetSessionId) {
      const newSession = await this.sessionComponent.create({
        title: `Session - ${new Date().toLocaleString("zh-CN")}`,
      });
      targetSessionId = newSession.id;
      isNewSession = true;
      await this.sessionComponent.setActiveSession(targetSessionId);
      if (!this.quiet) {
        this.output.info(`创建新会话: ${newSession.title} (${targetSessionId})`);
      }
    }

    // P2: 切换 session 时清空 attach 列表 (跟 opencode 行为一致)
    this.clearAttachments();

    const session = await this.sessionComponent.get(targetSessionId!);
    return {
      sessionId: targetSessionId!,
      isNewSession,
      sessionTitle: session?.title || "Unknown",
    };
  }

  /**
   * 切换会话
   */
  async switchSession(sessionId: string): Promise<SessionInitResult> {
    return this.init(sessionId, false);
  }

  /**
   * 获取当前会话信息
   */
  async getCurrentSession(): Promise<Session | undefined> {
    return this.sessionComponent.getActiveSession();
  }

  // ============================================================================
  // P2: 多模态 attach 列表管理
  // ============================================================================

  /**
   * 把一张图加入 attach 列表
   * - 本地路径/URL/data:base64 都接受
   * - 同样的 raw path 只 add 一次 (dedupe by raw path 字符串)
   * - Map 保证插入顺序稳定, listAttachments() 输出按 /attach 调用顺序
   */
  async attachImage(rawPath: string): Promise<ContentPart> {
    const normalized = rawPath.trim();
    if (!normalized) {
      throw new Error("attachImage: empty path");
    }
    const existing = this.attachedImagesMap.get(normalized);
    if (existing) {
      return existing;
    }
    const part = await parseImageInput(normalized);
    this.attachedImagesMap.set(normalized, part);
    return part;
  }

  /**
   * 列出当前 attach 列表 (按 /attach 调用顺序)
   */
  listAttachments(): ContentPart[] {
    return Array.from(this.attachedImagesMap.values());
  }

  /**
   * 清空 attach 列表
   */
  clearAttachments(): void {
    this.attachedImagesMap.clear();
  }

  /**
   * 把 text + 现有 attach 列表拼成最终 LLM query
   *
   * - 0 张图 → 返回 string (backward compat, 避免 microtask)
   * - ≥1 张图 → 返回 ContentPart[] (text first, then images)
   *
   * 注意: 该方法**不清空** attach 列表, 每次回车都会复用 (类似 opencode)
   * caller 需要在发完 query 后主动 clearAttachments()
   */
  async getQueryPayload(text: string): Promise<string | ContentPart[]> {
    if (this.attachedImagesMap.size === 0) {
      return text;
    }
    return [
      { type: "text", text },
      ...this.listAttachments(),
    ];
  }
}
