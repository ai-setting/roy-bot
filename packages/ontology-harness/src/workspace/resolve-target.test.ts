/**
 * @fileoverview link-definition 目标路径解析测试
 */

import { describe, it, expect } from "vitest";
import { resolveTargetPath } from "./resolve-target";

const FROM = "/ws/model/finance-model.md";

describe("resolveTargetPath", () => {
  it("相对路径相对定义文件所在目录解析为绝对路径", () => {
    const r = resolveTargetPath(FROM, "./entity/account.md");
    expect(r.absPath).toBe("/ws/model/entity/account.md");
    expect(r.fragment).toBeUndefined();
  });

  it("上跳路径 ../ 正确解析", () => {
    const r = resolveTargetPath("/ws/business/intro.md", "../model/entity/organization.md");
    expect(r.absPath).toBe("/ws/model/entity/organization.md");
  });

  it("剥离 #锚点，absPath 不含 fragment", () => {
    const r = resolveTargetPath(FROM, "./entity/financial-statement.md#资产负债表");
    expect(r.absPath).toBe("/ws/model/entity/financial-statement.md");
    expect(r.fragment).toBe("资产负债表");
  });

  it("自引用：目标解析回定义文件本身", () => {
    const r = resolveTargetPath("/ws/model/relation/is-a.md", "./is-a.md");
    expect(r.absPath).toBe("/ws/model/relation/is-a.md");
  });

  it("非本地链接（http/https）不解析，absPath 为 null", () => {
    expect(resolveTargetPath(FROM, "https://example.com/x.md").absPath).toBeNull();
    expect(resolveTargetPath(FROM, "http://example.com").absPath).toBeNull();
  });

  it("纯锚点（#xxx）指向自身文档，absPath 为定义文件本身", () => {
    const r = resolveTargetPath(FROM, "#预算执行");
    expect(r.absPath).toBe(FROM);
    expect(r.fragment).toBe("预算执行");
  });
});
