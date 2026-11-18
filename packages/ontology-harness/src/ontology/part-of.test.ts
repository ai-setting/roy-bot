/**
 * @fileoverview Header 层级 → part-of 关系测试
 *
 * 约定：更深层级的 header 是上一级 header 的组成部分（child part-of parent）。
 */

import { describe, it, expect } from "vitest";
import { parsePartOf } from "./part-of";

describe("parsePartOf", () => {
  it("子 header part-of 父 header", () => {
    const content = "# 汽车\n## 发动机\n";
    const rels = parsePartOf(content);
    expect(rels).toHaveLength(1);
    expect(rels[0].child).toBe("发动机");
    expect(rels[0].parent).toBe("汽车");
  });

  it("多级嵌套：每级 part-of 上一级", () => {
    const content = "# A\n## B\n### C\n";
    const rels = parsePartOf(content);
    expect(rels).toHaveLength(2);
    expect(rels).toEqual([
      expect.objectContaining({ child: "B", parent: "A" }),
      expect.objectContaining({ child: "C", parent: "B" }),
    ]);
  });

  it("兄弟节点共享同一父", () => {
    const content = "# A\n## B\n## C\n";
    const rels = parsePartOf(content);
    expect(rels).toHaveLength(2);
    expect(rels[0]).toMatchObject({ child: "B", parent: "A" });
    expect(rels[1]).toMatchObject({ child: "C", parent: "A" });
  });

  it("层级回退后正确归属", () => {
    const content = "# A\n## B\n### C\n## D\n";
    const rels = parsePartOf(content);
    expect(rels).toEqual([
      expect.objectContaining({ child: "B", parent: "A" }),
      expect.objectContaining({ child: "C", parent: "B" }),
      expect.objectContaining({ child: "D", parent: "A" }),
    ]);
  });

  it("去除 # 和首尾空白得到干净标题", () => {
    const content = "#   标题带空格   \n##\t制表符\n";
    const rels = parsePartOf(content);
    expect(rels[0].child).toBe("制表符");
    expect(rels[0].parent).toBe("标题带空格");
  });

  it("顶层 header 无父，不产生关系", () => {
    const content = "# 只有一个顶层\n正文\n";
    expect(parsePartOf(content)).toHaveLength(0);
  });

  it("range 指向子 header 行", () => {
    const content = "# A\n\n## B\n";
    const rels = parsePartOf(content);
    expect(rels[0].range.start.line).toBe(2);
  });

  it("忽略代码块内的 # 注释", () => {
    const content = "# 真标题\n```\n# 这是注释不是 header\n```\n## 子标题\n";
    const rels = parsePartOf(content);
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatchObject({ child: "子标题", parent: "真标题" });
  });
});
