/**
 * @fileoverview Ontology analyzer 编排 + TM 诊断测试
 */

import { describe, it, expect } from "vitest";
import { analyzeOntology } from "./analyzer";

function codes(diags: { code?: string | number }[]): string[] {
  return diags.map((d) => String(d.code));
}

describe("analyzeOntology", () => {
  it("解析出 frontmatter/defs/triples/partOf 到 document", () => {
    const content = [
      "---",
      "type: model",
      "domain: 测试",
      "---",
      "# 顶层",
      "## 子级",
      "",
      "[星科科技] 是 [公司] 的 [is-a]。",
      "",
      '[星科科技]: ./e/a.md "entity"',
      '[公司]: ./e/b.md "entity"',
      '[is-a]: ./r/is-a.md "operator"',
    ].join("\n");

    const { document } = analyzeOntology("/ws/model.md", content);
    expect(document.frontmatter.type).toBe("model");
    expect(document.definitions).toHaveLength(3);
    expect(document.triples).toHaveLength(1);
    expect(document.partOf).toHaveLength(1);
  });

  it("TM002: Link Definition 缺少 title（Warning）", () => {
    const content = "[孤立]: ./x.md\n";
    const { diagnostics } = analyzeOntology("/ws/business.md", content);
    const tm002 = diagnostics.find((d) => d.code === "TM002");
    expect(tm002).toBeDefined();
    expect(tm002!.severity).toBe(2); // Warning
  });

  it("TM003: 非法 title（Error）", () => {
    const content = '[x]: ./x.md "concept"\n';
    const { diagnostics } = analyzeOntology("/ws/business.md", content);
    const tm003 = diagnostics.find((d) => d.code === "TM003");
    expect(tm003).toBeDefined();
    expect(tm003!.severity).toBe(1); // Error
    expect(tm003!.message).toContain("concept");
  });

  it("TM011: 三元组谓语未定义为 operator（Error）", () => {
    const content = [
      "[A] 是 [B] 的 [未定义关系]。",
      '[A]: ./e/a.md "entity"',
      '[B]: ./e/b.md "entity"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/business.md", content);
    const tm011 = diagnostics.find((d) => d.code === "TM011");
    expect(tm011).toBeDefined();
    expect(tm011!.severity).toBe(1);
  });

  it("operator 作为谓语合法（不报 TM011）", () => {
    const content = [
      "[气压] 是 [负责人] 的 [预警]。",
      '[气压]: ./e/p.md "entity"',
      '[负责人]: ./e/o.md "entity"',
      '[预警]: ./op/warning.md "operator"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/model.md", content);
    expect(codes(diagnostics)).not.toContain("TM011");
  });

  it("TM001: model 文件缺少 type: model（Error）", () => {
    const content = "# 没有 frontmatter 的 model 文件\n";
    const { diagnostics } = analyzeOntology("/ws/finance-model.md", content);
    const tm001 = diagnostics.find((d) => d.code === "TM001");
    expect(tm001).toBeDefined();
    expect(tm001!.severity).toBe(1);
  });

  it("非 model 文件不报 TM001", () => {
    const content = "# 普通业务文档\n";
    const { diagnostics } = analyzeOntology("/ws/star-tech-intro.md", content);
    expect(codes(diagnostics)).not.toContain("TM001");
  });

  it("完整合法 model 文档无 TM 诊断", () => {
    const content = [
      "---",
      "type: model",
      "---",
      "# 管线",
      "## 管道气压",
      "",
      "[管道气压] 是 [设施] 的 [is-a]。",
      "",
      '[管道气压]: ./e/p.md "entity"',
      '[设施]: ./e/f.md "entity"',
      '[is-a]: ./r/is-a.md "operator"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/pipeline-model.md", content);
    expect(diagnostics).toHaveLength(0);
  });

  it("TM007: Attribute type 必须是合法值", () => {
    const content = [
      "---",
      "type: model",
      "---",
      "# 驾驶人模型",
      "## 属性",
      "",
      "| 属性名 | 类型 | 必填 | 描述 |",
      "|--------|------|------|------|",
      "| 姓名 | string | 是 | 驾驶人姓名 |",
      "| 年龄 | integer | 否 | 年龄 |",
      "| 无效类型 | wrongtype | 否 | 非法类型 |",
      "",
      '[驾驶人]: ./entity/driver.md "entity"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/driver-model.md", content);
    const tm007 = diagnostics.filter((d) => d.code === "TM007");
    expect(tm007).toHaveLength(1);
    expect(tm007[0].message).toContain("wrongtype");
  });

  it("TM008: ref Attribute 引用的实体必须定义为 entity（未定义时报错）", () => {
    const content = [
      "---",
      "type: model",
      "---",
      "# 驾驶人模型",
      "## 属性",
      "",
      "| 属性名 | 类型 | 必填 | 描述 |",
      "|--------|------|------|------|",
      "| 姓名 | string | 是 | 姓名 |",
      "| 车辆 | ref:机动车 | 否 | 拥有的车辆 |",
      "",
      '[驾驶人]: ./entity/driver.md "entity"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/driver-model.md", content);
    const tm008 = diagnostics.filter((d) => d.code === "TM008");
    expect(tm008).toHaveLength(1);
    expect(tm008[0].message).toContain("机动车");
    expect(tm008[0].severity).toBe(1);
  });

  it("TM008: ref Attribute 引用已定义的 entity 时不报错", () => {
    const content = [
      "---",
      "type: model",
      "---",
      "# 驾驶人模型",
      "## 属性",
      "",
      "| 属性名 | 类型 | 必填 | 描述 |",
      "|--------|------|------|------|",
      "| 姓名 | string | 是 | 姓名 |",
      "| 车辆 | ref:机动车 | 否 | 拥有的车辆 |",
      "",
      '[驾驶人]: ./entity/driver.md "entity"',
      '[机动车]: ./entity/car.md "entity"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/driver-model.md", content);
    const tm008 = diagnostics.filter((d) => d.code === "TM008");
    expect(tm008).toHaveLength(0);
  });

  it("TM008: ref Attribute 引用 operator 类型的术语时报错", () => {
    const content = [
      "---",
      "type: model",
      "---",
      "# 预警模型",
      "## 属性",
      "",
      "| 属性名 | 类型 | 必填 | 描述 |",
      "|--------|------|------|------|",
      "| 关联算子 | ref:违规判定 | 否 | 关联的算子 |",
      "",
      '[违规判定]: ./op/violation.md "operator"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/violation-model.md", content);
    const tm008 = diagnostics.filter((d) => d.code === "TM008");
    expect(tm008).toHaveLength(1);
    expect(tm008[0].message).toContain("operator");
  });

  // ------------------------------------------------------------------
  // v8.3 规则（Task #3196）：TM127 / TM128
  // ------------------------------------------------------------------

  it("v8.3 TM127: Operator.implement.impltype 非法时报错", () => {
    const content = [
      "---",
      "type: operator",
      "implement:",
      "  impltype: bogus-mode",
      "---",
      "# 取气象",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/operator.md", content);
    const tm127 = diagnostics.filter((d) => d.code === "TM127");
    expect(tm127).toHaveLength(1);
    expect(tm127[0].severity).toBe(1);
    expect(tm127[0].message).toContain("bogus-mode");
  });

  it("v8.3 TM127: implement.impltype 缺省时报告", () => {
    const content = [
      "---",
      "type: operator",
      "implement:",
      "  description: 没有 impltype",
      "---",
      "# 取气象",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/operator.md", content);
    const tm127 = diagnostics.filter((d) => d.code === "TM127");
    expect(tm127).toHaveLength(1);
    expect(tm127[0].severity).toBe(1);
  });

  it("v8.3 TM128: implement.impltype=http-api 缺少 http_endpoint 报错", () => {
    const content = [
      "---",
      "type: operator",
      "implement:",
      "  impltype: http-api",
      "---",
      "# 取气象",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/operator.md", content);
    const tm128 = diagnostics.filter((d) => d.code === "TM128");
    expect(tm128).toHaveLength(1);
    expect(tm128[0].severity).toBe(1);
    expect(tm128[0].message).toContain("http_endpoint");
  });

  it("v8.3 TM128: implement.impltype=coding 缺少 coding_module 报错", () => {
    const content = [
      "---",
      "type: operator",
      "implement:",
      "  impltype: coding",
      "---",
      "# 取气象",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/operator.md", content);
    const tm128 = diagnostics.filter((d) => d.code === "TM128");
    expect(tm128).toHaveLength(1);
    expect(tm128[0].message).toContain("coding_module");
  });

  it("v8.3 合法 implement 块（mcp + mcp_endpoint）无诊断", () => {
    const content = [
      "---",
      "type: operator",
      "implement:",
      "  impltype: mcp",
      "  mcp_endpoint: weather-mcp-server",
      "---",
      "# 取气象",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/operator.md", content);
    const tm127 = diagnostics.filter((d) => d.code === "TM127");
    const tm128 = diagnostics.filter((d) => d.code === "TM128");
    expect(tm127).toHaveLength(0);
    expect(tm128).toHaveLength(0);
  });

  it("v8.3 instance_getter.access_mode 非法时报告 TM127", () => {
    const content = [
      "---",
      "type: model",
      "instance_getter:",
      "  access_mode: foo-bar",
      "---",
      "# entity",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/entity.md", content);
    const tm127 = diagnostics.filter((d) => d.code === "TM127");
    expect(tm127).toHaveLength(1);
    expect(tm127[0].message).toContain("foo-bar");
  });

  it("v8.3 合法 instance_getter（http-api）无诊断", () => {
    const content = [
      "---",
      "type: model",
      "instance_getter:",
      "  access_mode: http-api",
      "---",
      "# entity",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/entity.md", content);
    const tm127 = diagnostics.filter((d) => d.code === "TM127");
    expect(tm127).toHaveLength(0);
  });

  it("v8.3 Operator 缺 implement 块时不报错（optional）", () => {
    const content = [
      "---",
      "type: operator",
      "---",
      "# 简单算子",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/operator.md", content);
    const tm127 = diagnostics.filter((d) => d.code === "TM127");
    expect(tm127).toHaveLength(0);
  });

  it("v8.3 Entity 缺 instance_getter 块时不报错（optional）", () => {
    const content = [
      "---",
      "type: model",
      "---",
      "# 简单实体",
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/entity.md", content);
    const tm127 = diagnostics.filter((d) => d.code === "TM127");
    expect(tm127).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // v8.3 规则：TM125 / TM126（operator chaining）
  // ------------------------------------------------------------------

  it("v8.3 checkOperatorChaining 同 domain 同名同 type 不同 link → TM125", async () => {
    const { checkOperatorChaining } = await import("./diagnostics");
    const all = [
      {
        operatorId: "op1",
        domain: "traffic",
        filePath: "/ws/op1.md",
        name: "op1",
        outputs: [
          { name: "result", type: "string", linkTarget: "./e/a.md" },
        ],
        inputs: [],
      },
      {
        operatorId: "op2",
        domain: "traffic",
        filePath: "/ws/op2.md",
        name: "op2",
        outputs: [
          { name: "result", type: "string", linkTarget: "./e/b.md" },
        ],
        inputs: [],
      },
    ];
    const out = checkOperatorChaining(all);
    const tm125 = out.filter((d) => d.code === "TM125");
    expect(tm125).toHaveLength(1);
    expect(tm125[0].severity).toBe(1);
  });

  it("v8.3 checkOperatorChaining 链式同 link → TM126 (warning)", async () => {
    const { checkOperatorChaining } = await import("./diagnostics");
    const all = [
      {
        operatorId: "opA",
        domain: "weather",
        filePath: "/ws/A.md",
        name: "A",
        outputs: [
          { name: "temp", type: "number", linkTarget: "./e/temp.md" },
        ],
        inputs: [],
      },
      {
        operatorId: "opB",
        domain: "weather",
        filePath: "/ws/B.md",
        name: "B",
        outputs: [],
        inputs: [
          { name: "temp", type: "number", linkTarget: "./e/temp.md" },
        ],
      },
    ];
    const out = checkOperatorChaining(all);
    const tm126 = out.filter((d) => d.code === "TM126");
    expect(tm126).toHaveLength(1);
    expect(tm126[0].severity).toBe(2); // Warning
  });

  // ------------------------------------------------------------------
  // v8.3 规则（Task #3200）：TM129 扩展覆盖 Link Definition `[label]: path`
  // 现有 TM129 只校验 attribute table 中 link 字段。
  // 本扩展新增：Link Definition 行 target 必须是合法相对/绝对路径形式。
  // ------------------------------------------------------------------

  it("v8.3 TM129：Link Definition target 是合法路径（./e/a.md）", () => {
    const content = [
      "---",
      "type: model",
      "---",
      '[星科科技]: ./entity/star-tech.md "entity"',
    ].join("\n");
    const { diagnostics } = analyzeOntology("/ws/model.md", content);
    expect(diagnostics.find((d) => d.code === "TM129")).toBeUndefined();
  });

  it("v8.3 TM129：Link Definition target 是绝对路径（/abs/path.md）也合法", () => {
    const content = '[X]: /abs/path/to/x.md "entity"\n';
    const { diagnostics } = analyzeOntology("/ws/business.md", content);
    expect(diagnostics.find((d) => d.code === "TM129")).toBeUndefined();
  });

  it("v8.3 TM129：Link Definition target 含 URL scheme（http://）也合法", () => {
    const content = '[外部]: https://example.com "entity"\n';
    const { diagnostics } = analyzeOntology("/ws/business.md", content);
    expect(diagnostics.find((d) => d.code === "TM129")).toBeUndefined();
  });

  it("v8.3 TM129：Link Definition target 含非法控制字符 → 报错", () => {
    // LINK_DEF_RE 接受 \S+，但 target 中包含 ? 等不在路径/URL 字符集里的符号
    // 是不规范的。规范要求 target 是单纯路径或 URL scheme。
    // 这里测试 target 是 query string 风格 "?foo=bar"
    const content = '[X]: ?foo=bar "entity"\n';
    const { diagnostics } = analyzeOntology("/ws/business.md", content);
    const tm129 = diagnostics.find((d) => d.code === "TM129");
    expect(tm129).toBeDefined();
    expect(tm129!.severity).toBe(1);
  });

  it("v8.3 TM129：Link Definition target 形如纯单字符（无可识别路径段） → 报错", () => {
    // 解析器对 \S+ 都接受。但 "." 这种纯单字符 target 不像路径，应被 TM129 拒绝。
    const content = '[X]: . "entity"\n';
    const { diagnostics } = analyzeOntology("/ws/business.md", content);
    const tm129 = diagnostics.find((d) => d.code === "TM129");
    expect(tm129).toBeDefined();
    expect(tm129!.severity).toBe(1);
  });
});
