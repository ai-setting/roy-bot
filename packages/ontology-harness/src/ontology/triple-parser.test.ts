/**
 * @fileoverview 三元组解析测试
 */

import { describe, it, expect } from "vitest";
import { parseTriples } from "./triple-parser";

describe("parseTriples", () => {
  it("解析谓语在尾部的三元组 [S] 是 [O] 的 [R]", () => {
    const content = "[星科科技] 是 [公司] 的 [is-a]，成立于 2015 年。";
    const triples = parseTriples(content);
    expect(triples).toHaveLength(1);
    const t = triples[0];
    expect(t.subject).toBe("星科科技");
    expect(t.object).toBe("公司");
    expect(t.predicate).toBe("is-a");
  });

  it("支持 属于 / has 等不同连接词（谓语仍在 的 [R] 尾部）", () => {
    const content = [
      "[星科科技] 属于 [软件开发行业] 的 [is-a]。",
      "[星科科技] has [注册资本] 的 [has]。",
    ].join("\n");
    const triples = parseTriples(content);
    expect(triples).toHaveLength(2);
    expect(triples[0].predicate).toBe("is-a");
    expect(triples[0].object).toBe("软件开发行业");
    expect(triples[1].predicate).toBe("has");
    expect(triples[1].object).toBe("注册资本");
  });

  it("解析谓语在中部的三元组 [S] 的 [R] 是 [O]", () => {
    const content = "[汽车] 的 [part-of] 是 [发动机]。";
    const triples = parseTriples(content);
    expect(triples).toHaveLength(1);
    const t = triples[0];
    expect(t.subject).toBe("汽车");
    expect(t.predicate).toBe("part-of");
    expect(t.object).toBe("发动机");
  });

  it("忽略 link definition 行（它们也含 []）", () => {
    const content = [
      "[星科科技] 是 [公司] 的 [is-a]。",
      '[星科科技]: ./entity/star-tech.md "entity"',
      '[公司]: ./entity/org.md "entity"',
      '[is-a]: ./relation/is-a.md "relation"',
    ].join("\n");
    const triples = parseTriples(content);
    expect(triples).toHaveLength(1);
  });

  it("少于三个引用的行不算三元组", () => {
    const content = "见 [公司] 和 [财务部] 两个实体。";
    const triples = parseTriples(content);
    expect(triples).toHaveLength(0);
  });

  it("记录三元组及各部分的位置", () => {
    const content = "前缀 [A] 是 [B] 的 [r]";
    const triples = parseTriples(content);
    expect(triples).toHaveLength(1);
    const t = triples[0];
    expect(t.range.start.line).toBe(0);
    // subject [A] 起始于 "前缀 " 之后 = 第 3 个字符
    expect(t.parts.subject.start.character).toBe(3);
    expect(t.parts.predicate.start.line).toBe(0);
  });

  it("一行多个三元组都能解析", () => {
    const content = "[A] 是 [B] 的 [r1]；[C] 是 [D] 的 [r2]";
    const triples = parseTriples(content);
    expect(triples).toHaveLength(2);
    expect(triples[0].predicate).toBe("r1");
    expect(triples[1].predicate).toBe("r2");
  });
});
