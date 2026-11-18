/**
 * @fileoverview commands-registry tests — Task #2312 RED phase
 *
 * 验证:
 * - COMMANDS 注册表包含 10+ 命令
 * - filterCommands 实时过滤 (大小写不敏感, prefix/substring/alias 匹配)
 * - filterCommands("") 返回全部命令
 * - filterCommands("/") 等价于 ""
 */

import { describe, test, expect } from "bun:test";
import {
  COMMANDS,
  filterCommands,
  MAX_POPUP_ITEMS,
  categoryLabel,
  type Command,
} from "./commands-registry";

describe("commands-registry (Task #2312)", () => {
  describe("COMMANDS 静态注册表", () => {
    test("包含 10+ 个命令", () => {
      expect(COMMANDS.length).toBeGreaterThanOrEqual(10);
    });

    test("每个命令必须有 cmd (以 / 开头) + desc + category", () => {
      for (const cmd of COMMANDS) {
        expect(cmd.cmd.startsWith("/")).toBe(true);
        expect(cmd.desc.length).toBeGreaterThan(0);
        expect(["general", "memory", "model", "session", "attachment", "system"]).toContain(
          cmd.category,
        );
      }
    });

    test("cmd 名唯一 (无重复)", () => {
      const cmds = COMMANDS.map((c) => c.cmd);
      const unique = new Set(cmds);
      expect(unique.size).toBe(cmds.length);
    });

    test("包含 welcome card 提到的 4 个核心命令", () => {
      const cmds = COMMANDS.map((c) => c.cmd);
      expect(cmds).toContain("/help");
      expect(cmds).toContain("/init");
      expect(cmds).toContain("/model");
      expect(cmds).toContain("/compact");
    });

    test("包含多模态命令 /attach /list /paste /clear", () => {
      const cmds = COMMANDS.map((c) => c.cmd);
      expect(cmds).toContain("/attach");
      expect(cmds).toContain("/list");
      expect(cmds).toContain("/paste");
      expect(cmds).toContain("/clear");
    });

    test("MAX_POPUP_ITEMS 限制为合理值 (>= 5, <= 20)", () => {
      expect(MAX_POPUP_ITEMS).toBeGreaterThanOrEqual(5);
      expect(MAX_POPUP_ITEMS).toBeLessThanOrEqual(20);
    });
  });

  describe("filterCommands 实时过滤", () => {
    test("空查询返回全部命令", () => {
      const result = filterCommands("");
      expect(result.length).toBe(COMMANDS.length);
    });

    test("\"/\" (只有前导 /) 返回全部命令", () => {
      const result = filterCommands("/");
      expect(result.length).toBe(COMMANDS.length);
    });

    test("\"/he\" 只匹配 /help", () => {
      const result = filterCommands("/he");
      expect(result.map((c) => c.cmd)).toContain("/help");
      // 不应该匹配 /hello-world 之类的 — 我们没有这个命令, 但应该不匹配其他命令
      expect(result.every((c) => c.cmd.startsWith("/h") && c.cmd.includes("e"))).toBe(true);
    });

    test("\"/h\" 匹配 /help (前缀匹配)", () => {
      const result = filterCommands("/h");
      expect(result.map((c) => c.cmd)).toContain("/help");
    });

    test("\"/m\" 匹配 /model 和 /memory (前缀)", () => {
      const result = filterCommands("/m");
      const cmds = result.map((c) => c.cmd);
      expect(cmds).toContain("/model");
      expect(cmds).toContain("/memory");
    });

    test("\"/me\" 只匹配 /memory (前缀更精确)", () => {
      const result = filterCommands("/me");
      const cmds = result.map((c) => c.cmd);
      expect(cmds).toContain("/memory");
      expect(cmds).not.toContain("/model");
    });

    test("\"/q\" 通过 alias 匹配 /quit", () => {
      const result = filterCommands("/q");
      expect(result.map((c) => c.cmd)).toContain("/quit");
    });

    test("\"/c\" 通过 alias 匹配 /compact 和 /clear", () => {
      const result = filterCommands("/c");
      const cmds = result.map((c) => c.cmd);
      expect(cmds).toContain("/compact");
      expect(cmds).toContain("/clear");
    });

    test("大小写不敏感 — \"/H\" 等价于 \"/h\"", () => {
      const upper = filterCommands("/H");
      const lower = filterCommands("/h");
      expect(upper.map((c) => c.cmd).sort()).toEqual(lower.map((c) => c.cmd).sort());
    });

    test("多个前导 / 也能正确处理 — \"//h\" 等价于 \"/h\"", () => {
      const single = filterCommands("/h");
      const multi = filterCommands("//h");
      expect(multi.map((c) => c.cmd).sort()).toEqual(single.map((c) => c.cmd).sort());
    });

    test("无匹配项时返回空数组", () => {
      const result = filterCommands("/nonexistent_xyz");
      expect(result).toEqual([]);
    });

    test("包含匹配 — \"/mod\" 匹配 /model (前缀), \"/ode\" 也匹配 /model (substring)", () => {
      const prefixResult = filterCommands("/mod");
      const substringResult = filterCommands("/ode");
      expect(prefixResult.map((c) => c.cmd)).toContain("/model");
      expect(substringResult.map((c) => c.cmd)).toContain("/model");
    });

    test("前后空白不影响过滤", () => {
      const trimmed = filterCommands("/h");
      const padded = filterCommands("  /h  ");
      expect(padded.map((c) => c.cmd)).toEqual(trimmed.map((c) => c.cmd));
    });

    test("结果保持 COMMANDS 原始顺序 (按使用频率)", () => {
      const result = filterCommands("");
      const original = [...COMMANDS];
      expect(result.map((c) => c.cmd)).toEqual(original.map((c) => c.cmd));
    });
  });

  describe("categoryLabel", () => {
    test("返回非空字符串", () => {
      const labels: Command["category"][] = ["general", "memory", "model", "session", "attachment", "system"];
      for (const cat of labels) {
        expect(categoryLabel(cat).length).toBeGreaterThan(0);
      }
    });
  });
});