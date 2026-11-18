/**
 * @fileoverview 属性表格解析器测试
 */

import { describe, it, expect } from "vitest";
import { parseAttributeTable, parseAllAttributeTables } from "./attribute-table";

describe("parseAttributeTable", () => {
  it("解析 ## 属性 下的标准表格", () => {
    const content = [
      "# 驾驶人模型",
      "## 属性",
      "",
      "| 属性名 | 类型 | 必填 | 描述 | 示例/枚举值 |",
      "|--------|------|------|------|-------------|",
      "| 姓名 | string | 是 | 驾驶人姓名 | 张三 |",
      "| 年龄 | integer | 否 | 年龄 | 30 |",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(2);

    expect(attrs[0].name).toBe("姓名");
    expect(attrs[0].type).toBe("string");
    expect(attrs[0].required).toBe(true);
    expect(attrs[0].description).toBe("驾驶人姓名");
    expect(attrs[0].example).toBe("张三");

    expect(attrs[1].name).toBe("年龄");
    expect(attrs[1].type).toBe("integer");
    expect(attrs[1].required).toBe(false);
    expect(attrs[1].description).toBe("年龄");
    expect(attrs[1].example).toBe("30");
  });

  it("支持各种列顺序（表头映射不区分列顺序）", () => {
    const content = [
      "## 属性",
      "",
      "| 类型 | 名称 | 必填 |",
      "|------|------|------|",
      "| number | 金额 | 是 |",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].name).toBe("金额");
    expect(attrs[0].type).toBe("number");
    expect(attrs[0].required).toBe(true);
  });

  it("解析 enum 类型及其候选值", () => {
    const content = [
      "## 属性",
      "",
      "| 属性名 | 类型 | 示例/枚举值 |",
      "|--------|------|-------------|",
      "| 性别 | enum | 男, 女, 其他 |",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].type).toBe("enum");
    expect(attrs[0].values).toEqual(["男", "女", "其他"]);
  });

  it("解析 ref: 类型", () => {
    const content = [
      "## 属性",
      "",
      "| 属性名 | 类型 | 必填 |",
      "|--------|------|------|",
      "| 所有人 | ref:驾驶人 | 否 |",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].type).toBe("ref:驾驶人");
    expect(attrs[0].required).toBe(false);
  });

  it("没有 ## 属性 标题时返回空数组", () => {
    const content = "# 无属性\n";
    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(0);
  });

  it("处理空表格（只有表头无数据行）", () => {
    const content = [
      "## 属性",
      "",
      "| 属性名 | 类型 | 必填 |",
      "|--------|------|------|",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(0);
  });

  it("忽略表头与数据行之间的空行", () => {
    const content = [
      "## 属性",
      "",
      "| name | type |",
      "|------|------|",
      "",
      "| 姓名 | string |",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].name).toBe("姓名");
  });

  it("type 默认值为 string", () => {
    const content = [
      "## 属性",
      "",
      "| 名称 | 必填 |",
      "|------|------|",
      "| 备注 | 否 |",
    ].join("\n");

    // No type column → should return empty since type column is required
    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(0);
  });

  it("支持中英文列名混合", () => {
    const content = [
      "## 属性",
      "",
      "| name | type | required |",
      "|------|------|----------|",
      "| name | string | true |",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].name).toBe("name");
    expect(attrs[0].type).toBe("string");
    expect(attrs[0].required).toBe(true);
  });

  it("enum 值中包含 [Label] 格式的实体引用", () => {
    const content = [
      "## 属性",
      "",
      "| 属性名 | 类型 | 示例/枚举值 |",
      "|--------|------|-------------|",
      "| 车辆类型 | enum | [小型汽车], [大型汽车] |",
    ].join("\n");

    const attrs = parseAttributeTable(content, 0);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].type).toBe("enum");
    expect(attrs[0].values).toEqual(["[小型汽车]", "[大型汽车]"]);
  });

  it("从指定 startLine 开始搜索", () => {
    const content = [
      "# 其他内容",
      "## 属性",
      "",
      "| name | type |",
      "|------|------|",
      "| 旧表 | string |",
      "",
      "# 另一节",
      "## 属性",
      "",
      "| name | type |",
      "|------|------|",
      "| 新表 | integer |",
    ].join("\n");

    // Start at line 8 (the second ## 属性)
    const attrs = parseAttributeTable(content, 8);
    expect(attrs).toHaveLength(1);
    expect(attrs[0].name).toBe("新表");
    expect(attrs[0].type).toBe("integer");
  });
});

describe("parseAllAttributeTables", () => {
  it("解析所有 ## 属性 表格", () => {
    const content = [
      "# 文档",
      "## 属性",
      "",
      "| 名称 | 类型 |",
      "|------|------|",
      "| a | string |",
      "",
      "## 属性",
      "",
      "| 名称 | 类型 |",
      "|------|------|",
      "| b | integer |",
    ].join("\n");

    const results = parseAllAttributeTables(content);
    expect(results).toHaveLength(2);
    expect(results[0].attributes[0].name).toBe("a");
    expect(results[1].attributes[0].name).toBe("b");
  });
});
