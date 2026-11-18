/**
 * @fileoverview Task #5423 — delegate_task sub-agent prompt 渠道特性提示。
 *
 * ## 背景（用户 2026-11-13 07:14 批准的方案）
 *
 * delegate_task 起的 sub-agent 的 prompt 里没有渠道特性提示：
 * 用户在飞书发「帮我写调研文档」→ 主 agent delegate 给 sub-agent
 * → sub-agent 不知道触发渠道 → 产出物落本地路径（`/tmp/x.md`）
 * 而非飞书云盘，飞书用户根本打不开。
 *
 * 主 agent 的 system prompt 里**有**渠道规范（lark/wecom 渠道 prompt），
 * 但那套 systemPrompt 只注入主 agent；sub-agent 走
 * `ensureSubAgentRegistered(basePrompt)`，只拿到自己的 basePrompt，
 * 拿不到任何渠道上下文。
 *
 * ## 方案
 *
 * 渠道信息来源：delegate 时刻的 `EnvContext.replyChannel.type`
 * （`lark-cli` / `wecom-cli`），已由 `captureReplyChannelSnapshot()`
 * 快照到 `task.replyChannel`（Task #4042 follow-up），
 * 并在 `executeWithAbort` 里可从 sub-session metadata / EnvContext 取到。
 *
 * - 触发渠道是飞书 → 文档类产出用**飞书云盘**（`lark-cli docs +create`）
 * - 触发渠道是企微 → 对应方式（`wecom-cli doc create` / `disk files upload`）
 * - 无渠道（CLI / REPL / 定时器 / 未知渠道）→ 返回 undefined，**不注入**
 *
 * 纯函数叶子模块：不 import delegate-tool / event-source，
 * 避免回向依赖（对标 sub-session-activity.ts 的叶子模块纪律）。
 */

/** 渠道提示段的章节标题（同时作为「无渠道不注入」的探针串） */
export const DELEGATE_CHANNEL_HINT_TITLE =
  "## 渠道交付提示（当前会话来自外部渠道）";

/**
 * 从 replyChannel.type 派生渠道特性提示段。
 *
 * @param channelType delegate 时刻 EnvContext.replyChannel.type
 *   （`"lark-cli"` / `"wecom-cli"` / 其他 / undefined）
 * @returns 提示段文本；无渠道或未知渠道返回 undefined（不注入）
 */
export function buildDelegateChannelHint(
  channelType: string | undefined,
): string | undefined {
  if (!channelType) return undefined;

  let channelBody: string | undefined;

  if (channelType === "lark-cli" || channelType.startsWith("lark")) {
    // ★ 前缀匹配是**有意**的（CV MAJOR-1 核实后保留）：生产代码里除了
    //   `lark-cli`，还有 `lark` / `lark-chat` 等变体（全部是飞书渠道），
    //   精确匹配会让这些变体漏掉飞书云盘提示。企微同理（`wecom-ws` /
    //   `wecom-healthy` 等）。未来若出现**非消息类** lark 前缀渠道，
    //   应改成显式白名单而非放宽这里。
    channelBody = [
      `- 触发渠道是**飞书**。文档类产出（调研文档 / 报告 / PPT / doc 等）`,
      `  必须用**飞书云盘**存储：\`lark-cli docs +create --title <标题> --markdown @<本地md>\`，用完即弃。`,
      `- 交付时只给**云盘链接**（https://my.feishu.cn/...），**不落本地路径**交付。`,
      `  本地路径只作中转（生成 md → 上传云盘 → 回复里贴云盘链接），不作为交付物。`,
    ].join("\n");
  } else if (channelType === "wecom-cli" || channelType.startsWith("wecom")) {
    channelBody = [
      `- 触发渠道是**企业微信**。文档类产出（调研文档 / docs / ppt 等）`,
      `  必须上传到**企微文档**，链接作为交付物：`,
      `  - 在线文档：\`wecom-cli doc create --doc-name <标题> --doc-type doc --content-type text --file-path <本地md>\``,
      `  - 微盘文件：\`wecom-cli disk files upload --file-path <本地文件>\`（默认传到我的空间）`,
      `- 本地路径只作中转（生成 → 上传企微文档 → 回复里贴链接），**不落本地路径**交付。`,
    ].join("\n");
  }

  if (!channelBody) return undefined;

  return [
    DELEGATE_CHANNEL_HINT_TITLE,
    ``,
    `通用措辞：当前会话来自外部渠道，交付类产出优先用该渠道的原生存储/展示方式，`,
    `不要把本地文件路径当作交付物（渠道用户无法访问本机文件系统）。`,
    ``,
    channelBody,
  ].join("\n");
}
