/**
 * @fileoverview Link Definition 类型解析测试
 */

import { describe, it, expect } from "vitest";
import { parseTermDefinitions } from "./link-def-types";

describe("parseTermDefinitions", () => {
  it("解析带 title 的 link definition，归类 entity/operator", () => {
    const content = [
      "# 文档",
      "",
      '[星科科技]: ./entity/star-tech.md "entity"',
      '[is-a]: ./r/is-a.md "operator"',
      '[预警]: ./operator/warning.md "operator"',
    ].join("\n");

    const defs = parseTermDefinitions(content);
    expect(defs).toHaveLength(3);

    const byLabel = Object.fromEntries(defs.map((d) => [d.label, d]));
    expect(byLabel["星科科技"].type).toBe("entity");
    expect(byLabel["星科科技"].target).toBe("./entity/star-tech.md");
    expect(byLabel["is-a"].type).toBe("operator");
    expect(byLabel["预警"].type).toBe("operator");
  });

  it("支持单引号和括号形式的 title", () => {
    const content = [
      "[a]: ./a.md 'entity'",
      "[b]: ./b.md (operator)",
    ].join("\n");
    const defs = parseTermDefinitions(content);
    const byLabel = Object.fromEntries(defs.map((d) => [d.label, d]));
    expect(byLabel["a"].type).toBe("entity");
    expect(byLabel["b"].type).toBe("operator");
  });

  it("缺少 title 时 type=undefined，但保留定义", () => {
    const content = "[孤立]: ./x.md";
    const defs = parseTermDefinitions(content);
    expect(defs).toHaveLength(1);
    expect(defs[0].type).toBeUndefined();
    expect(defs[0].rawTitle).toBeUndefined();
  });

  it("非法 title（非 entity/operator）时 type=undefined，保留 rawTitle 供诊断", () => {
    const content = '[x]: ./x.md "concept"';
    const defs = parseTermDefinitions(content);
    expect(defs[0].type).toBeUndefined();
    expect(defs[0].rawTitle).toBe("concept");
  });

  it("range 指向定义所在行", () => {
    const content = ["# h", "", '[x]: ./x.md "entity"'].join("\n");
    const defs = parseTermDefinitions(content);
    expect(defs[0].range.start.line).toBe(2);
  });

  it('"relation" 不再被识别为合法 type（返回 undefined）', () => {
    const content = '[x]: ./x.md "relation"\n';
    const defs = parseTermDefinitions(content);
    expect(defs[0].type).toBeUndefined();
    expect(defs[0].rawTitle).toBe("relation");
  });

  it("忽略正文中的内联链接 [text](url)，只取 link definition", () => {
    const content = [
      "见 [资产负债表](./entity/fs.md) 详情",
      '[资产负债表]: ./entity/fs.md "entity"',
    ].join("\n");
    const defs = parseTermDefinitions(content);
    expect(defs).toHaveLength(1);
    expect(defs[0].label).toBe("资产负债表");
  });
});
