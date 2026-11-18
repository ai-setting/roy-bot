/**
 * 飞书消息 <at> 提及语法规范化工具
 *
 * ## 背景
 *
 * LLM 在生成消息时经常使用自闭合 XML 语法 `<at user_id="ou_xxx"/>` 来表达 @-mention，
 * 但飞书 API 实际只识别 **带显式结束标签** 的形式：
 *   - `<at user_id="ou_xxx">name</at>` — 带显示名
 *   - `<at user_id="ou_xxx"></at>` — 空显示名（仍然会触发 @ 通知）
 *
 * 自闭合形式 `<at user_id="ou_xxx"/>` 会被飞书当作 **纯文本字面量** 展示，
 * 收件人既看不到 mention，也不会收到通知。
 *
 * ## 解决方案
 *
 * 在发消息前调用 `normalizeLarkAtMentions(content)`，把所有自闭合 `<at>` 转为标准
 * `<at user_id="..."></at>` 形式。如果调用方传入了 userId → name 的映射表，
 * 还会把显示名填进去（更好的视觉提示）。
 *
 * ## 参考
 *
 * - lark-im skill: `lark-cli skills read lark-im/references/lark-im-messages-send.md`
 *   "## @Mention Format" 章节
 *   - `text`: `<at user_id="ou_xxx">name</at>` (inner optional, `<at user_id="ou_xxx"></at>` works)
 *   - `post` + `md`: 同 text 的 inline form
 *   - `post` + `at` element: `{"tag":"at","user_id":"ou_xxx"}`
 *   - @all: `<at user_id="all"></at>`
 */

/**
 * 匹配各种变体的自闭合 `<at>` 标签
 *
 * 支持的变体：
 *   - `<at user_id="ou_xxx"/>` （双引号，无空格）
 *   - `<at user_id="ou_xxx" />` （双引号，带空格）
 *   - `<at user_id='ou_xxx'/>` （单引号）
 *   - `<at user_id="all"/>` （@all）
 *   - `<at user_id=ou_xxx/>` （无引号）
 *
 * 不修改的（已经是正确形式）：
 *   - `<at user_id="ou_xxx">name</at>`
 *   - `<at user_id="ou_xxx"></at>`
 */
const SELF_CLOSING_AT_RE = /<at\s+user_id\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*\/\s*>/g;

/**
 * 规范化消息中的飞书 @-mention 语法
 *
 * 把 LLM 经常输出的自闭合形式 `<at user_id="ou_xxx"/>` 转换为飞书识别的
 * 标准形式 `<at user_id="ou_xxx"></at>`，触发实际的 @ 通知。
 *
 * @param content 原始 markdown 消息文本
 * @param nameMap 可选的 userId → displayName 映射；如果提供，会把名字填到
 *                `<at>` 内部，让收件人看到"@张三"而不是"@"
 * @returns 规范化后的内容
 *
 * @example
 * // 基础用法：自闭合 → 空闭合
 * normalizeLarkAtMentions('<at user_id="ou_123"/>收到')
 * // → '<at user_id="ou_123"></at>收到'
 *
 * @example
 * // 带名字映射
 * normalizeLarkAtMentions(
 *   '<at user_id="ou_123"/>收到',
 *   new Map([['ou_123', '张三']])
 * )
 * // → '<at user_id="ou_123">张三</at>收到'
 */
export function normalizeLarkAtMentions(
  content: string,
  nameMap?: ReadonlyMap<string, string>
): string {
  if (!content) return content;

  return content.replace(SELF_CLOSING_AT_RE, (_match, dq?: string, sq?: string, bare?: string) => {
    const userId = dq ?? sq ?? bare ?? "";
    if (!userId) return _match;

    // 优先用 nameMap 提供的 display name
    const displayName = nameMap?.get(userId);
    if (displayName) {
      return `<at user_id="${escapeXmlAttr(userId)}">${escapeXmlText(displayName)}</at>`;
    }
    return `<at user_id="${escapeXmlAttr(userId)}"></at>`;
  });
}

/**
 * 转义 XML 属性的特殊字符（&, <, >, ", '）
 * 防御性处理：保证 userId 即使包含特殊字符也不会破坏 XML 结构。
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 转义 XML 文本节点的特殊字符（&, <）
 * 不转义 > 和 " 因为它们在文本节点内是合法的。
 */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 检测消息内容是否包含飞书 mention 语法（任何形式）
 *
 * 用于调试/日志：在 send 之前打印"包含 N 个 mention"，方便 trace。
 */
export function countLarkMentions(content: string): number {
  if (!content) return 0;
  const matches = content.match(/<at\s+user_id\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/g);
  return matches ? matches.length : 0;
}
