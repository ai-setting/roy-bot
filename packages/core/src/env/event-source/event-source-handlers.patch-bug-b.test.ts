/**
 * Task #4337：event-source-handlers.ts 的 Bug B 回归测试（源码 grep 形式）
 *
 * 覆盖:
 *   - Bug B: `patchCardByLarkCli`（Task #4337 从 class private 抽出的 exported helper）的 cmd 模板
 *           不应带 `--yes`（`lark-cli api` 1.0.96 不接受）
 *
 * 这是 src-level regression（grep source code）。理由同 lark-card-action-handler.bugs.test.ts：
 * bun:test 的 mock.module + Node util.promisify 不兼容，改为源码回归测试。
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_PATH = join(import.meta.dir, "event-source-handlers.ts");
const SRC_CONTENT = readFileSync(SRC_PATH, "utf-8");

// 去掉注释和字符串字面量（保留模板字符串）
function stripCommentsAndStrings(src: string): string {
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  src = src.replace(/^\s*\/\/.*$/gm, "");
  src = src.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  src = src.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return src;
}

function extractFnBody(name: string, src: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) {
    const start2 = src.indexOf(`export function ${name}(`);
    if (start2 === -1) throw new Error(`Cannot find function ${name} in source`);
    return extractFrom(src, start2);
  }
  return extractFrom(src, start);
}

function extractFrom(src: string, start: number): string {
  const lines = src.split("\n");
  // 找到 start 在 lines 中的行
  let lineIndex = -1;
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = cursor + lines[i].length + 1; // +1 for \n
    if (cursor <= start && start < end) {
      lineIndex = i;
      break;
    }
    cursor = end;
  }
  if (lineIndex === -1) throw new Error("Cannot find line index");
  const collected: string[] = [];
  for (let i = lineIndex; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (i > lineIndex && (trimmed.startsWith("export async function") || trimmed.startsWith("export function "))) {
      break;
    }
    collected.push(lines[i]);
  }
  return collected.join("\n");
}

describe("event-source-handlers patchCardByLarkCli (Task #4337 Bug B GREEN)", () => {
  it("Bug B: patchCardByLarkCli 函数体的 cmd 模板不含 '--yes'", () => {
    const raw = extractFnBody("patchCardByLarkCli", SRC_CONTENT);
    const body = stripCommentsAndStrings(raw);
    expect(body).not.toMatch(/--yes/);
    // sanity: 还在用正确的 api POST path
    expect(body).toMatch(/api POST \/open-apis\/interactive\/v1\/card\/update/);
    expect(body).toMatch(/--as bot/);
    expect(body).toMatch(/--data/);
  });

  it("Bug B: patchCardByLarkCli 是 exported function（可独立测试）", () => {
    expect(SRC_CONTENT).toMatch(/export\s+async\s+function\s+patchCardByLarkCli/);
  });
});
