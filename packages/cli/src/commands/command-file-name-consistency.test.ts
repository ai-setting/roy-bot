/**
 * @fileoverview 护栏：命令文件名 ↔ 注册命令名 ↔ UI 实现 三者必须自洽。
 *
 * ## 为什么有这个测试（Task #4674）
 *
 * 本仓库历史上 `commands/run.ts` 与 `commands/interactive.ts` 的**文件名和它们注册
 * 的命令名是反的**：
 *
 * | 文件（对调前） | 注册的命令名 | UI 实现 |
 * |---|---|---|
 * | `commands/run.ts` | `interactive` | opentui/Solid |
 * | `commands/interactive.ts` | `run` | Ink `ChatTui` |
 *
 * Task #4674 把两个**文件名**对调，使「文件名 ↔ 注册命令名」自洽：
 *
 * | 文件（对调后） | 注册的命令名 | UI 实现 |
 * |---|---|---|
 * | `commands/interactive.ts` | `interactive` | opentui/Solid |
 * | `commands/run.ts` | `run` | Ink `ChatTui` |
 *
 * ⚠️ **导出符号名故意不跟文件名对齐**（历史包袱，public API 冻结）：
 *
 * | 文件 | 导出符号 | 注册的命令名 |
 * |---|---|---|
 * | `commands/interactive.ts` | `RunCommand` | `interactive` |
 * | `commands/run.ts` | `InteractiveCommand` | `run` |
 *
 * `packages/cli/src/index.ts` 把 `InteractiveCommand` / `createInteractiveCommand`
 * 作为 npm 包的 public API 导出，改符号名会破坏外部消费者 —— 符号重命名是
 * 后续独立 PR。所以**符号名与文件名故意不匹配**，本测试只断言「文件名 ↔ 注册
 * 命令名 ↔ UI 链路」，不断言符号名。
 *
 * ## 用户点名的行为不变式（最高优先级）
 *
 * > 「我需要跟你确定下目前的 roy-bot interactive 最终用的是 run.ts 里面的逻辑，
 * >   run 用的是 interactive.ts 里面的逻辑和 UI 哈。你的任务 A 也要保证这一点哈。」
 *
 * 对调**只是搬家**，**行为零变化**：
 * - `roy-bot interactive` 仍走 **opentui/Solid** TUI
 * - `roy-bot run` 仍走 **Ink `ChatTui`** REPL
 *
 * 本测试把这条不变式**锁死**：只要有人再把两个文件搞反，或者把某个命令的 UI
 * 实现接错到另一个链路，本测试立刻 RED。
 *
 * ## 断言分三层
 *
 * 1. **注册层**：文件名 ↔ 注册命令名一致，且两者互不相同
 * 2. **实现层**：每个文件里确实引用了对应链路的特征符号
 *    （opentui 侧 `mountInteractiveScreen` / Ink 侧 `REPL` + `renderInkREPL`）
 * 3. **交叉层**：两个文件**不**同时出现对方的特征符号
 *    （防止"两头都挂"，那会让实现层断言失去区分度）
 *
 * 注意：这里**只读源码文本**，不 import 被测模块 —— 因为 import `commands/interactive.ts`
 * 会拉起 Ink/React 依赖，在 bun test 环境下是已知的不稳定来源。文本断言更稳，
 * 且对"文件与命令名是否对调"这个纯结构问题足够。
 */

import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const COMMANDS_DIR = path.join(import.meta.dir);
const INTERACTIVE_SRC = path.join(COMMANDS_DIR, "interactive.ts");
const RUN_SRC = path.join(COMMANDS_DIR, "run.ts");

function readSource(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/**
 * 抽出 `command: "<name>"` 的值。
 *
 * 只匹配 `command:` 开头的属性（yargs CommandModule 的字段），
 * 避免误命中 `createInteractiveCommand(` 之类的标识符。
 */
function extractRegisteredCommand(src: string): string | undefined {
  const m = src.match(/\bcommand:\s*"([^"]+)"/);
  return m?.[1];
}

// ---------------------------------------------------------------------------
// 1. 注册层：文件名 ↔ 注册命令名
// ---------------------------------------------------------------------------

describe("命令文件名 ↔ 注册命令名 一致性", () => {
  test("commands/interactive.ts 注册的命令名是 'interactive'", () => {
    expect(extractRegisteredCommand(readSource(INTERACTIVE_SRC))).toBe("interactive");
  });

  test("commands/run.ts 注册的命令名是 'run'", () => {
    expect(extractRegisteredCommand(readSource(RUN_SRC))).toBe("run");
  });

  test("两个文件注册的命令名互不相同（防止又搞反）", () => {
    const interactiveCmd = extractRegisteredCommand(readSource(INTERACTIVE_SRC));
    const runCmd = extractRegisteredCommand(readSource(RUN_SRC));
    expect(interactiveCmd).toBeTruthy();
    expect(runCmd).toBeTruthy();
    expect(interactiveCmd).not.toBe(runCmd);
  });
});

// ---------------------------------------------------------------------------
// 2. 实现层：命令 ↔ UI 链路特征符号
// ---------------------------------------------------------------------------

describe("命令 ↔ UI 实现链路绑定（行为不变式）", () => {
  test("'interactive' 命令的实现来自 opentui/Solid 链路（mountInteractiveScreen）", () => {
    const src = readSource(INTERACTIVE_SRC);
    // 用布尔断言而非 toContain：失败时只打印 true/false，不倒灌整份源码。
    expect({
      hasMountInteractiveScreen: src.includes("mountInteractiveScreen"),
      hasTuiSolidMountImport: /tui-solid\/mount(\.js)?/.test(src),
    }).toEqual({
      hasMountInteractiveScreen: true,
      hasTuiSolidMountImport: true,
    });
  });

  test("'run' 命令的实现来自 Ink REPL 链路（REPL 类 + repl-ink 渲染）", () => {
    const src = readSource(RUN_SRC);
    expect({
      hasReplClass: /export class REPL\b/.test(src),
      // Ink 链路的渲染入口：`repl-ink` 模块的 renderInkREPL
      hasReplInkRender: src.includes("renderInkREPL"),
    }).toEqual({
      hasReplClass: true,
      hasReplInkRender: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 交叉层：两个文件不同时出现对方的特征符号
// ---------------------------------------------------------------------------

describe("两条链路互不串台", () => {
  test("commands/interactive.ts 不含 Ink REPL 链路的 class REPL 定义", () => {
    expect(/export class REPL\b/.test(readSource(INTERACTIVE_SRC))).toBe(false);
  });

  test("commands/run.ts 不含 opentui 桥接的 mountInteractiveScreen 调用", () => {
    expect(readSource(RUN_SRC).includes("mountInteractiveScreen")).toBe(false);
  });
});
