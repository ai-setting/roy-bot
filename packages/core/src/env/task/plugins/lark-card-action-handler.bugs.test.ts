/**
 * Task #4337：lark-card-action-handler 中 2 个 bridge 函数的 bug 回归测试（源码 grep 形式）
 *
 * 覆盖:
 *   - Bug A: `createGroupChatViaLarkCli` 不应带 `--output json`（lark-cli 1.0.96 不支持该 flag）
 *   - Bug C (同质): `deleteGroupChatViaLarkCli` 不应带 `--yes`（`lark-cli api` 不接受）
 *
 * 这是 src-level regression（grep source code）。原因：bun:test 的 mock.module + Node util.promisify
 * 存在不兼容（promisify 不传 callback 给 mock，导致 mock 不可达），所以改为源码回归测试：
 *
 *   - 读取 `./lark-card-action-handler.ts` 全文
 *   - 提取被测函数体（剥掉注释和 string literals）
 *   - 断言 cmd 模板不含已知不被 lark-cli 1.0.96 接受的 flag
 *
 * 防止未来有人误加回这俩 lark-cli 1.0.96 不支持的 flag。
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_PATH = join(import.meta.dir, "lark-card-action-handler.ts");
const SRC_CONTENT = readFileSync(SRC_PATH, "utf-8");

// 去掉注释和 string literals，**保留**模板字符串（用 --yes 这样的 flag 只出现在代码里的 cmd 模板）
function stripCommentsAndStrings(src: string): string {
  // 去掉 /* ... */
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // 去掉 // ... 直到行尾
  src = src.replace(/^\s*\/\/.*$/gm, "");
  // 去掉双引号字符串字面量
  src = src.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // 去掉单引号字符串字面量（但保留 --xxx 这样的 flag 在模板字符串里）
  src = src.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  return src;
}

function extractFnBody(name: string, src: string): string {
  // 找 `export async function ${name}(` 起点，向后取到下一个 `^export async` 或 `^export function`（同行头）或文件末尾
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) {
    // 兜底：用 export function ${name}(
    const start2 = src.indexOf(`export function ${name}(`);
    if (start2 === -1) throw new Error(`Cannot find function ${name} in source`);
    return extractFrom(src, start2);
  }
  return extractFrom(src, start);
}

function extractFrom(src: string, start: number): string {
  // 从 start 向后找到下一个 \nexport async function 或 \nexport function（函数定义结尾）
  const rest = src.slice(start);
  // 用 dotall 模式 [^]*? 匹配，然后 lookahead 到 \nexport async function 或 \nexport function 或 EOF
  const re = /export\s+async\s+function\s+\w+[\s\S]*?(?=\n\nexport\s+async\s+function|\n\nexport\s+function|$)/g;
  // 简单方法：从 start 行开始，逐行累积直到下一行匹配 `^export async function` 或 `^export function`
  const lines = src.split("\n");
  let lineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (src.indexOf(lines[i]) >= start && lineIndex === -1) {
      lineIndex = i;
      break;
    }
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

describe("lark-card-action-handler bridge bugs (Task #4337 RED → GREEN)", () => {
  it("Bug A: createGroupChatViaLarkCli 函数体的 cmd 模板不含 '--output json'", () => {
    const raw = extractFnBody("createGroupChatViaLarkCli", SRC_CONTENT);
    const body = stripCommentsAndStrings(raw);
    expect(body).not.toMatch(/--output\s+json/);
    // sanity: 还在用 im +chat-create
    expect(body).toMatch(/im \+chat-create/);
    expect(body).toMatch(/--as bot/);
  });

  it("Bug C (同质): deleteGroupChatViaLarkCli 函数体的 cmd 模板不含 '--yes'", () => {
    const raw = extractFnBody("deleteGroupChatViaLarkCli", SRC_CONTENT);
    const body = stripCommentsAndStrings(raw);
    expect(body).not.toMatch(/--yes/);
    // sanity: 还在用正确的 api DELETE path
    expect(body).toMatch(/api DELETE \/open-apis\/im\/v1\/chats\//);
    expect(body).toMatch(/--as bot/);
  });
});
