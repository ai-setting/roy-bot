/**
 * @fileoverview slash-commands — 多模态 REPL slash command 解析
 *
 * TDD RED: 验证 /attach <path> /list /clear /paste 解析
 *
 * 设计：
 * - 输入以 "/" 开头 → slash command；否则返回 null
 * - /attach <path> 必须有 path 参数
 * - /list /clear /paste 接受零个参数
 * - 大小写不敏感（命令部分）
 */

import { describe, test, expect } from "vitest";
import { parseSlashCommand, type SlashCommand } from "./slash-commands";

describe("parseSlashCommand", () => {
  test("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  test("parses /attach <path>", () => {
    const result = parseSlashCommand("/attach ./image.png");
    expect(result).toEqual({ type: "attach", path: "./image.png" });
  });

  test("parses /attach with absolute path", () => {
    const result = parseSlashCommand("/attach /tmp/cat.jpg");
    expect(result).toEqual({ type: "attach", path: "/tmp/cat.jpg" });
  });

  test("parses /attach with http(s) URL", () => {
    const result = parseSlashCommand("/attach https://example.com/cat.png");
    expect(result).toEqual({ type: "attach", path: "https://example.com/cat.png" });
  });

  test("/attach without path returns attach with empty path (error case)", () => {
    const result = parseSlashCommand("/attach");
    expect(result).toEqual({ type: "attach", path: "" });
  });

  test("/attach with extra trailing whitespace is trimmed", () => {
    const result = parseSlashCommand("/attach   ./x.png   ");
    expect(result).toEqual({ type: "attach", path: "./x.png" });
  });

  test("parses /list (no args)", () => {
    const result = parseSlashCommand("/list");
    expect(result).toEqual({ type: "list" });
  });

  test("parses /clear (clear attach list)", () => {
    const result = parseSlashCommand("/clear");
    expect(result).toEqual({ type: "clear" });
  });

  test("parses /paste (no args)", () => {
    const result = parseSlashCommand("/paste");
    expect(result).toEqual({ type: "paste" });
  });

  test("command is case-insensitive", () => {
    expect(parseSlashCommand("/ATTACH ./x.png")).toEqual({ type: "attach", path: "./x.png" });
    expect(parseSlashCommand("/List")).toEqual({ type: "list" });
    expect(parseSlashCommand("/PASTE")).toEqual({ type: "paste" });
  });

  test("returns null for unknown slash commands", () => {
    expect(parseSlashCommand("/unknown")).toBeNull();
    expect(parseSlashCommand("/help")).toBeNull();
    expect(parseSlashCommand("/exit")).toBeNull();
  });

  test("ignores leading/trailing whitespace on input", () => {
    expect(parseSlashCommand("  /list  ")).toEqual({ type: "list" });
    expect(parseSlashCommand("  /attach ./x.png  ")).toEqual({ type: "attach", path: "./x.png" });
  });

  test("parses /attach with paths containing spaces (quoted not supported, single arg only)", () => {
    // 设计权衡: 单个 arg 即整个 path,空格作为 part of path
    const result = parseSlashCommand("/attach /tmp/with space.png");
    expect(result).toEqual({ type: "attach", path: "/tmp/with space.png" });
  });
});
