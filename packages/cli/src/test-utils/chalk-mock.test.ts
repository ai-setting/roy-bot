/**
 * @fileoverview Unit test for chalk-mock helper
 *
 * 验证 createChalkMock() 在 bun:test 下能正确链式调用并永不抛错。
 * 这是 Batch 1 (chalk.hex polyfill) 的 RED→GREEN 闭环测试。
 */

import { describe, test, expect } from "bun:test";
import { createChalkMock } from "./chalk-mock";

describe("chalk-mock helper", () => {
  test("createChalkMock returns object with default property", () => {
    const m = createChalkMock();
    expect(typeof m.default).toBe("function");
  });

  test("chalk.hex (top-level) is a function (the failing scenario)", () => {
    const chalk = createChalkMock();
    expect(typeof chalk.hex).toBe("function");
    expect(typeof chalk.hex("#ff6b6b")).toBe("function");
    expect(typeof chalk.hex("#ff6b6b")("hello")).toBe("string");
  });

  test("chalk.bold.whiteBright is chainable (stream-output.service.ts:27)", () => {
    const chalk = createChalkMock();
    const fn = chalk.bold.whiteBright;
    expect(typeof fn).toBe("function");
    expect(typeof fn("test")).toBe("string");
  });

  test("chalk.dim is a function (Task #2252 status-bar regression)", () => {
    const chalk = createChalkMock();
    expect(typeof chalk.dim).toBe("function");
    expect(typeof chalk.dim("text")).toBe("string");
  });

  test("chalk.dim.gray is chainable (reasoning color in stream-output)", () => {
    const chalk = createChalkMock();
    const fn = chalk.dim.gray;
    expect(typeof fn).toBe("function");
    expect(typeof fn("text")).toBe("string");
  });

  test("chalk.white is a function (renderRunResult regression)", () => {
    const chalk = createChalkMock();
    expect(typeof chalk.white).toBe("function");
    expect(typeof chalk.white("text")).toBe("string");
  });

  test("any unknown property also returns chainable function", () => {
    const chalk = createChalkMock();
    const fn = chalk.someUnknownProperty.deepChain.terminal;
    expect(typeof fn).toBe("function");
    expect(typeof fn("text")).toBe("string");
  });

  test("call with no args returns empty string", () => {
    const chalk = createChalkMock();
    expect(chalk.cyan()).toBe("");
  });

  test("call with multiple args joins them", () => {
    const chalk = createChalkMock();
    expect(chalk.cyan("a", "b", "c")).toBe("a b c");
  });
});