/**
 * 飞书 mention 语法规范化单元测试
 *
 * 覆盖：
 * 1. 自闭合 → 空闭合（基本场景）
 * 2. 带显示名的归一化（用 nameMap）
 * 3. 各种自闭合变体（引号/空格/@all/无引号）
 * 4. 已经是正确形式的不应被破坏
 * 5. 边界场景：空字符串、无 mention、特殊字符
 */
import { describe, expect, test } from "bun:test";
import { normalizeLarkAtMentions, countLarkMentions } from "./lark-mention-utils";

describe("normalizeLarkAtMentions (Task #3993 fix)", () => {
  test("self-closing → proper closing (no name)", () => {
    expect(normalizeLarkAtMentions('<at user_id="ou_123"/>收到'))
      .toBe('<at user_id="ou_123"></at>收到');
  });

  test("self-closing with display name via nameMap", () => {
    const nameMap = new Map([["ou_123", "张三"]]);
    expect(normalizeLarkAtMentions('<at user_id="ou_123"/>收到', nameMap))
      .toBe('<at user_id="ou_123">张三</at>收到');
  });

  test("nameMap missing entry → empty closing (still triggers @)", () => {
    const nameMap = new Map<string, string>();
    expect(normalizeLarkAtMentions('<at user_id="ou_999"/>收到', nameMap))
      .toBe('<at user_id="ou_999"></at>收到');
  });

  test("single-quoted self-closing variant", () => {
    expect(normalizeLarkAtMentions("<at user_id='ou_123'/>收到"))
      .toBe('<at user_id="ou_123"></at>收到');
  });

  test("self-closing with space before slash", () => {
    expect(normalizeLarkAtMentions('<at user_id="ou_123" />收到'))
      .toBe('<at user_id="ou_123"></at>收到');
  });

  test("unquoted self-closing", () => {
    expect(normalizeLarkAtMentions('<at user_id=ou_123/>收到'))
      .toBe('<at user_id="ou_123"></at>收到');
  });

  test("@all mention", () => {
    expect(normalizeLarkAtMentions('<at user_id="all"/>大家注意'))
      .toBe('<at user_id="all"></at>大家注意');
  });

  test("already-correct form should NOT be modified", () => {
    const correct = '<at user_id="ou_123">张三</at>收到';
    expect(normalizeLarkAtMentions(correct)).toBe(correct);
  });

  test("already-correct empty closing should NOT be modified", () => {
    const correct = '<at user_id="ou_123"></at>收到';
    expect(normalizeLarkAtMentions(correct)).toBe(correct);
  });

  test("multiple mentions in same message", () => {
    expect(normalizeLarkAtMentions('<at user_id="ou_1"/>和<at user_id="ou_2"/>请确认'))
      .toBe('<at user_id="ou_1"></at>和<at user_id="ou_2"></at>请确认');
  });

  test("nameMap applied to multiple mentions", () => {
    const nameMap = new Map([
      ["ou_1", "Alice"],
      ["ou_2", "Bob"],
    ]);
    expect(
      normalizeLarkAtMentions('<at user_id="ou_1"/>和<at user_id="ou_2"/>请确认', nameMap)
    ).toBe('<at user_id="ou_1">Alice</at>和<at user_id="ou_2">Bob</at>请确认');
  });

  test("real-world: agent task notify message", () => {
    // 实际场景：agent 看到 user mention 后写的消息
    const original = '<at user_id="ou_1759934f98e0677e17f09591389c24f1"/>收到，正在推进 Task #3993';
    const expected = '<at user_id="ou_1759934f98e0677e17f09591389c24f1"></at>收到，正在推进 Task #3993';
    expect(normalizeLarkAtMentions(original)).toBe(expected);
  });

  test("empty content", () => {
    expect(normalizeLarkAtMentions("")).toBe("");
  });

  test("content without mentions", () => {
    expect(normalizeLarkAtMentions("hello world")).toBe("hello world");
  });

  test("mentions mixed with markdown", () => {
    const md = `📌 **Task #3993**

<at user_id="ou_123"/>收到，正在推进。

**进展**:
- Step 1 完成
- Step 2 进行中`;
    expect(normalizeLarkAtMentions(md)).toBe(`📌 **Task #3993**

<at user_id="ou_123"></at>收到，正在推进。

**进展**:
- Step 1 完成
- Step 2 进行中`);
  });

  test("display name with special chars is XML-escaped", () => {
    const nameMap = new Map([["ou_123", "<script>"]]);
    const result = normalizeLarkAtMentions('<at user_id="ou_123"/>x', nameMap);
    // 防御性：保证不会破坏 XML 结构
    expect(result).toBe('<at user_id="ou_123">&lt;script&gt;</at>x');
  });
});

describe("countLarkMentions", () => {
  test("counts all forms (self-closing + proper closing)", () => {
    expect(countLarkMentions(
      '<at user_id="ou_1"/>hello<at user_id="ou_2">name</at><at user_id="all"></at>'
    )).toBe(3);
  });

  test("returns 0 for empty content", () => {
    expect(countLarkMentions("")).toBe(0);
  });

  test("returns 0 for no mentions", () => {
    expect(countLarkMentions("hello world")).toBe(0);
  });
});
