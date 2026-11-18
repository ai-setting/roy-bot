/**
 * @fileoverview frontmatter 解析测试
 */

import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("解析标准 frontmatter，提取 type/domain", () => {
    const content = [
      "---",
      "type: model",
      "domain: 企业财务管理",
      "version: 1.0",
      "---",
      "",
      "# 标题",
    ].join("\n");

    const fm = parseFrontmatter(content);
    expect(fm.present).toBe(true);
    expect(fm.type).toBe("model");
    expect(fm.domain).toBe("企业财务管理");
    expect(fm.raw.version).toBe(1); // yaml 把 1.0 解析为数字
  });

  it("识别 type: operator", () => {
    const content = "---\ntype: operator\ndomain: 操作算子/warning\n---\n# 预警\n";
    const fm = parseFrontmatter(content);
    expect(fm.type).toBe("operator");
  });

  it("没有 frontmatter 时 present=false", () => {
    const content = "# 普通文档\n\n[A] 是 [B] 的 [is-a]\n";
    const fm = parseFrontmatter(content);
    expect(fm.present).toBe(false);
    expect(fm.type).toBeUndefined();
  });

  it("frontmatter 必须在文件开头（中间的 --- 不算）", () => {
    const content = "# 标题\n\n---\ntype: model\n---\n";
    const fm = parseFrontmatter(content);
    expect(fm.present).toBe(false);
  });

  it("range 覆盖 frontmatter 块的起止行", () => {
    const content = "---\ntype: model\n---\n# x\n";
    const fm = parseFrontmatter(content);
    expect(fm.present).toBe(true);
    expect(fm.range?.start.line).toBe(0);
    expect(fm.range?.end.line).toBe(2);
  });

  it("frontmatter 内容非法 YAML 时不抛错，present=true 但字段缺失", () => {
    const content = "---\n: : : bad\n---\n# x\n";
    const fm = parseFrontmatter(content);
    expect(fm.present).toBe(true);
    expect(fm.type).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // v8.3 (Task #3196) — instance_getter 与 implement 块解析
  // ------------------------------------------------------------------

  it("v8.3: 解析 Entity 的 instance_getter 块（access_mode=http-api）", () => {
    const content = [
      "---",
      "type: model",
      "domain: aviation",
      "instance_getter:",
      "  access_mode: http-api",
      "  description: 通过 API 拉取示例实例",
      "---",
      "# 示例",
    ].join("\n");

    const fm = parseFrontmatter(content);
    expect(fm.present).toBe(true);
    expect(fm.instance_getter).toBeDefined();
    expect(fm.instance_getter?.access_mode).toBe("http-api");
    expect(fm.instance_getter?.description).toBe("通过 API 拉取示例实例");
  });

  it("v8.3: 缺省 instance_getter 块时为 undefined", () => {
    const content = "---\ntype: model\n---\n# x\n";
    const fm = parseFrontmatter(content);
    expect(fm.instance_getter).toBeUndefined();
  });

  it("v8.3: 解析 Operator 的 implement 块（impltype=http-api + http_endpoint）", () => {
    const content = [
      "---",
      "type: operator",
      "implement:",
      "  impltype: http-api",
      "  http_endpoint: https://api.example.com/weather",
      "---",
      "# 取气象",
    ].join("\n");

    const fm = parseFrontmatter(content);
    expect(fm.implement).toBeDefined();
    expect(fm.implement?.impltype).toBe("http-api");
    expect(fm.implement?.http_endpoint).toBe("https://api.example.com/weather");
  });

  it("v8.3: 缺省 implement 块时为 undefined", () => {
    const content = "---\ntype: operator\n---\n# x\n";
    const fm = parseFrontmatter(content);
    expect(fm.implement).toBeUndefined();
  });
});
