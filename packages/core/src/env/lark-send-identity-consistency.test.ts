/**
 * @fileoverview 跨文件一致性护栏：`packages/<pkg>/src` 里每个
 *               `+messages-send` / `+messages-reply` 的 **args 容器**
 *               都必须显式带 --as bot（Task #4557）
 *
 * ⚠️ **口径说明（别读成"完备防线"）**：本护栏盯的是「args 数组/实参」里的
 * 身份 flag，覆盖当前仓里的主流写法；**shell 字符串、别名 import、运行期
 * 拼接不在覆盖内**。完整的「能覆盖 / 不覆盖」清单见下文
 * 「扫描范围（诚实边界）」小节。
 *
 * ## 为什么需要这条测试（而不是只把两处缺 flag 补上）
 *
 * 单点修复只修「当下」，防不住「未来新增的发送路径又忘带 flag」。
 * 这个 bug 已经犯过至少两次：
 *
 * 1. **Task #4552**：`telemetry-notice.ts` 的 `buildLarkSendArgs()` 没带
 *    `--as bot` → 提示以 **user 身份**发出 → `lark-cli event consume
 *    im.message.receive_v1` 只看「是不是 user 发的」→ **同一个 consumer
 *    把自己的提示当用户消息回灌** → 又跑一次完整 agent run（188 spans）。
 *    真实 E2E 量化：回灌率 **5/11 = 45%**，token 一点没省还翻倍；
 *    修复后 **0/5 = 0%**。证据：本机 E2E 报告 `reports/4552-a1-real-e2e.md` §6（`reports/` 被 .gitignore 忽略，未入库）。
 * 2. **Task #4557**（本任务）：上面修完之后做全仓扫描，发现
 *    `error-reply.ts`（失败回执，**真实可达**）与
 *    `lark-cli-notification-channel.ts`（`@deprecated` 但 opt-in 可启用）
 *    的 `+messages-send` 分支仍然没带 —— 因为它们 `+messages-reply` 分支
 *    里写了 `--as bot`，`+messages-send` 分支漏了，而 A1 当初「抄」的
 *    正是漏的那一支。
 *
 * ⇒ 两次都是「同一个类」的疏漏，两次都是靠人肉 grep 才发现。这条测试
 * 把「人肉 grep」变成 CI 护栏。
 *
 * ## 本测试锁定什么契约
 *
 * 对 `packages/<pkg>/src/**` 下每个**源码**文件（排除 `*.test.ts` /
 * `*.spec.ts` / `node_modules` / `dist`），找到每个命令名字符串字面量
 * （`"+messages-send"` **以及** `"+messages-reply"` —— reply 以 user 身份
 * 发出同样会被 consumer 回灌，属同一 bug 类），取它所在的 **args 容器**，
 * 断言容器内出现 `"--as"` 且其后紧跟 `"bot"`。
 *
 * ### 「args 容器」的定义（刻意保持严格）
 *
 * - 字面量在数组字面量里（`const args = ["im", "+messages-send", ..., "--as", "bot"]`）
 *   → 容器 = 该数组
 * - 字面量是调用实参（`args.push("+messages-send", "--chat-id", x, "--as", "bot", ...)`）
 *   → 容器 = 该调用的实参列表
 *
 * **刻意不向「外层函数体」升级**。原因：`error-reply.ts` / `notification-channel.ts`
 * 里 `+messages-reply` 分支带着 `--as bot`、`+messages-send` 分支没带，
 * 两者在**同一个函数体内**。一旦允许向外层升级，这两处 bug 就会被
 * 同一函数里的那个 `--as bot`「掩护」过关 —— 测试变空转。
 *
 * 代价：写成 `const args = [...]; args.push("--as", "bot");` 这种
 * 「身份 flag 独立 push」的风格会被判失败。这是可接受的 —— 仓里现有
 * 全部写法都是「同容器」，而且合并到一个容器本来就更清晰。真需要例外
 * 就登记 `ALLOWLIST` 并写清理由。
 *
 * ## 扫描范围（诚实边界 —— 请按实际覆盖读，别当成完备防线）
 *
 * **目录**：`packages/<pkg>/src` 全量自动发现（跳过 `desktop`，见
 * `sourceDirs()`）。2026-10-27 实测纳入 4 个包：`core` / `cli` /
 * `coder-harness` / `ontology-harness`；`roy-bot-standalone` 无 `src`。
 * 新增包会自动纳入，不需要改本文件。
 *
 * **命令**：`+messages-send` **和** `+messages-reply`（reply 以 user 身份发出
 * 同样会被 consumer 回灌，属同一 bug 类）。
 *
 * **能覆盖的形态**：
 * - 完整的命令名字面量（`["im", "+messages-send", ...]` / `args.push(...)`）
 * - 命令名抽成常量（本地 `const CMD = "..."` / `export const CMD = "..."` /
 *   跨文件 import），会到**使用点**找 args 容器
 * - 包装层：`as const` / `satisfies` / 括号 / `<T>x` / 反引号无插值模板
 *
 * **明确不覆盖（🟡 已知边界，不是"可以忽略"而是"今天没防"）**：
 * - **shell 字符串**：`execSync(`lark-cli im +messages-send --chat-id ${x}`)`
 *   或把整条命令拼成一个字符串再 split 成数组。命令名藏在模板串里，AST
 *   看不到。今天仓里**有 1 个**发送点位是这种形态：`event-source-handlers.ts`
 *   的 `replyMessage()`（走 `sh -c <整条命令>`）；其余 6 个 `spawn("lark-cli", ...)`
 *   都用数组参数，能扫到。
 *   ⚠️ 正因为扫不到，`replyMessage()` 的 `--as bot` 由
 *   `lark-cli-handler-v2.test.ts` 里**单独的显式断言**兜底
 *   （见该文件「★ Task #4557 (F1)」两处 `expect(cmd).toContain("--as bot")`）。
 * - **别名 import**：`import { CMD as X } from ...` 后使用 `X` → 认不出。
 * - **拼接**：本文件另有一条护栏禁止拼接（见下），但只覆盖能静态折叠的
 *   形态（含常量代入 + 递归）；运行期才决定的字符串（`PREFIX + name`）不行。
 * - **`--as` 与 `bot` 分开 push**：`args.push("--as","bot")` 独立一行会被判违规
 *   （容器定义刻意不向外层函数升级，见下文「args 容器」）。仓里无此写法。
 *
 * **根治方向（follow-up，不在本任务范围）**：仓里 5 个文件各有一份几乎重复的
 * args builder —— 这才是这个 bug 类的根因（两次都是"抄了漏的那一支"）。
 * 合并成一个 `buildLarkMessageArgs()` 后，本护栏可以退化成「字面量只许出现在
 * 那个 builder 里」，几十行且能盖住 shell 字符串 / 别名 / 拼接全部形态。
 *
 * ## 附加护栏（两条）
 *
 * - 禁止用拼接拼出命令名（AST 判定，递归折叠常量；**不看注释**）
 * - 命令名抽常量时到使用点找容器（既不误报也不漏报）
 *
 * ## 为什么用 TypeScript AST 而不是正则
 *
 * 注释和其它字符串里到处都有 `+messages-send` 字样（例如
 * `event-source-handlers.ts:340` 的 prompt 模板、`env-context.ts` 的
 * 文档注释、`card-patch-notifier.ts` 的报错文案）。正则要么误报一片，
 * 要么写得足够绕最后自己也看不懂。AST 天然只看**真代码里的字符串字面量**。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

// ---------------------------------------------------------------------------
// 仓库根定位：test 文件在 <root>/packages/core/src/env/
// ---------------------------------------------------------------------------

/** `<root>/packages/core/src/env` → `<root>` */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

// 例外登记：**目前为空，且希望长期为空**。
//
// 曾经这里豁免过 `event-source-handlers.ts` 的 `sendLarkMessage` —— 因为它的
// args 里身份是变量 `identity`（类型 `"bot" | "user"`），只能靠「所有调用点
// 都传 as: 'bot'」这条**间接**测试兜底。Task #4557 的交叉验证实测出这个兜底
// 是**漏的**：把 `identity` 硬编码成 `"user"`、或把 `--as` 整段删掉，调用点
// 照样传 `as: "bot"`，测试全绿而 bug 复活。
//
// 所以那个 `as` 参数被整个删掉了（4 个调用点本来就全传 `"bot"`，`"user"`
// 分支零使用），身份改成 args 里的**字面量 `"bot"`**，于是白名单不再需要。
//
// 若将来确实需要非 bot 身份（例如真的要以用户身份做事），必须：
//   1. 在本表登记 `reason`（为什么不能是 bot）+ `expectedSites`（钉死点位数）
//   2. 同时补一条测试证明那个 user 身份路径**不会被 event consumer 回灌**
//      （或该路径根本不在 `im.message.receive_v1` 的可见范围内）

// ---------------------------------------------------------------------------
// 扫描实现
// ---------------------------------------------------------------------------

const MESSAGE_COMMANDS = ["+messages-send", "+messages-reply"] as const;
/** 兼容旧名（本文件里多处引用） */
const SEND_COMMAND = MESSAGE_COMMANDS[0];
/** 是否是本测试关注的命令名（send 与 reply 同样必须 --as bot） */
const isMessageCommand = (t: string): boolean =>
  (MESSAGE_COMMANDS as readonly string[]).includes(t);
const IDENTITY_FLAG = "--as";
const BOT_IDENTITY = "bot";

/**
 * 从变量初始化表达式里取出「纯字符串字面量值」。
 *
 * 需要剥离这些壳子，否则 `const X = "+messages-send" as const` 会被当成
 * 「不是字符串字面量」→ 常量解析失效 → 误报违规（交叉验证实测 P4）。
 */
function unpackStringLiteral(init: ts.Expression): string | undefined {
  let e: ts.Expression = init;
  for (;;) {
    if (ts.isStringLiteralLike(e)) return e.text;
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
      continue;
    }
    // `X as const` / `X satisfies T` / `<T>X`
    if (ts.isAsExpression?.(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression?.(e)) {
      e = (e as ts.AsExpression).expression;
      continue;
    }
    return undefined;
  }
}

/**
 * 要扫描的源码目录：`packages/<pkg>/src` **全量**（Task #4557 F2）。
 *
 * 曾经手工写死 `core` + `cli` 两个包 —— 那样将来在 desktop / coder-harness /
 * ontology-harness / standalone 里加发送路径就完全没护栏。改成遍历
 * `packages/*` 后，新增包自动纳入。
 *
 * 跳过 `desktop` 的理由：它是 Electron 前端，依赖重、今天 0 个 lark-cli 调用，
 * 且其 `src` 巨大（会拖慢这条测试）。若将来 desktop 真要发飞书，把它加回来。
 */
function sourceDirs(): string[] {
  const packagesRoot = join(REPO_ROOT, "packages");
  const SKIP = new Set(["desktop"]);
  let entries: string[];
  try {
    entries = readdirSync(packagesRoot);
  } catch {
    return [];
  }
  return entries
    .filter((e) => !SKIP.has(e))
    .map((e) => join(packagesRoot, e, "src"))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/** 递归收集目录下所有源码文件（排除测试 / 构建产物 / 依赖） */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".turbo" ||
      entry === "coverage"
    ) {
      continue;
    }
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 把绝对路径转成 repo 相对路径（统一用 `/`，便于跨平台 + 报错可读） */
function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

type Container = ts.NodeArray<ts.Expression> | ts.ArrayLiteralExpression;

/**
 * 找到承载 `+messages-send` 的 args 容器。
 *
 * 只认两种（见文件头说明，刻意不向外层升级）：
 * 1. 数组字面量（`["im", "+messages-send", ...]`）
 * 2. 调用实参列表（`args.push("+messages-send", ...)`）
 */
function findArgsContainer(node: ts.Node): Container | undefined {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isArrayLiteralExpression(parent) && parent.elements.includes(current as ts.Expression)) {
      return parent;
    }
    if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) {
      return parent.arguments;
    }
    // 只看一层：再往外就是「外层函数体」，会掩护 bug（见文件头）
    current = parent;
    // 遇到语句/声明边界就放弃，避免越界到整个函数
    if (
      ts.isExpressionStatement(parent) ||
      ts.isVariableStatement(parent) ||
      ts.isFunctionLike(parent) ||
      ts.isBlock(parent) ||
      ts.isSourceFile(parent)
    ) {
      return undefined;
    }
  }
  return undefined;
}

/** 容器里所有字符串字面量（含模板无插值）的文字 */
function containerStrings(container: Container): string[] {
  const elements: readonly ts.Expression[] = Array.isArray(container)
    ? (container as readonly ts.Expression[])
    : (container as ts.ArrayLiteralExpression).elements;
  const out: string[] = [];
  for (const el of elements) {
    if (ts.isStringLiteralLike(el)) out.push(el.text);
  }
  return out;
}

/** 容器是否带 `--as` 且紧跟 `bot` */
function containerHasBotIdentity(container: Container): boolean {
  const elements: readonly ts.Expression[] = Array.isArray(container)
    ? (container as readonly ts.Expression[])
    : (container as ts.ArrayLiteralExpression).elements;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    if (!ts.isStringLiteralLike(el) || el.text !== IDENTITY_FLAG) continue;
    const next = elements[i + 1];
    if (next && ts.isStringLiteralLike(next) && next.text === BOT_IDENTITY) {
      return true;
    }
  }
  return false;
}

interface SendSite {
  /** repo 相对路径 */
  file: string;
  /** 1-based 行号（从 `+messages-send` 字面量开始，便于定位） */
  line: number
  /** 容器里有没有 --as bot */
  hasBotIdentity: boolean;
  /** 容器里的全部字符串（失败信息里给出，便于一眼看出缺什么） */
  containerStrings: string[];
}

/** 扫单个文件的所有 `+messages-send` 点位 */
function collectSendSites(
  absPath: string,
  /** 全仓导出常量表（变量名 → 命令名），用于识别跨文件引用的命令常量 */
  globalCommandConsts?: ReadonlyMap<string, string>,
): SendSite[] {
  const sourceText = readFileSync(absPath, "utf8");
  const sf = ts.createSourceFile(
    absPath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const relFile = toRepoRelative(absPath);
  const sites: SendSite[] = [];

  // ── 常量解析 ──────────────────────────────────────────────────────────
  // 命令名可能被抽成常量：`const CMD = "+messages-send"`（含 as const /
  // satisfies / 括号 / <T>x 包装）。这类写法下「容器」在使用点，定义点本身
  // 不是发送站点，必须跳过（否则误报）。
  //
  // ⚠️ 判定必须精确，别把 `const args = ["im", "+messages-send", ...]` 也
  //   当成「定义点」—— 那会把仓库点位从 6 直接掉到 0（实测踩过）。
  //   正确判据：**只穿过包装层**，然后看落点的 parent 是不是以它作 initializer
  //   的变量声明。
  const isWrapper = (n: ts.Node): boolean =>
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isTypeAssertionExpression(n);

  const outermostWrapper = (node: ts.Node): ts.Node => {
    let cur: ts.Node = node;
    while (cur.parent && isWrapper(cur.parent)) cur = cur.parent;
    return cur;
  };

  /** 该字面量是否是「常量定义点的值」（本地 or export 都算） */
  const isConstDefinitionValue = (node: ts.Node): boolean => {
    const root = outermostWrapper(node);
    return (
      !!root.parent &&
      ts.isVariableDeclaration(root.parent) &&
      root.parent.initializer === root
    );
  };

  /**
   * 本文件内**所有**字符串常量（名字 → 值）。
   *
   * 注意：存**全部**而不是只存「值是命令名」的那些 —— 因为判断「这个标识符
   * 是不是命令常量」需要知道本地有没有一个**同名但不同值**的定义。
   * 只存命令名的话，`const CMD = "hello-world"` 就不会进表，
   * 于是外部同名 export 会把本地的 CMD 抢走 → 误报（MINOR-2，实测过）。
   */
  const localStrConsts = new Map<string, string>();
  const visitConsts = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = unpackStringLiteral(n.initializer);
      if (v !== undefined) localStrConsts.set(n.name.text, v);
    }
    ts.forEachChild(n, visitConsts);
  };
  visitConsts(sf);

  const pushSite = (node: ts.Node, container: Container | undefined): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    sites.push({
      file: relFile,
      line: line + 1,
      hasBotIdentity: container ? containerHasBotIdentity(container) : false,
      containerStrings: container ? containerStrings(container) : [],
    });
  };

  /**
   * 该标识符是否解析出「命令名」。
   *
   * ⚠️ 两条铁律（都被交叉验证抓过）：
   * 1. **本地定义优先**：本文件里同名变量若是别的值（`const CMD = "hello-world"`），
   *    必须以本地为准，不能被跨文件表里的同名 export 抢走。
   * 2. **跨文件表按「名字 + 值」双重比对**：光看名字存在会把同名无关变量
   *    误判成命令常量（MINOR-2）。
   *
   * 因为本函数只接受**名字**，拿不到调用点的绑定信息，所以保守做法是：
   * 本地有定义 → 只信本地；本地没有 → 才看跨文件表。
   * 这样「A 文件 export CMD=命令、B 文件本地 CMD=别的值」不会误报。
   */
  const resolveCmdConst = (name: string): string | undefined => {
    // 本地有同名常量：**只信本地**。值不是命令名 → 它不是命令常量（返回
    // undefined），绝不能让外部同名 export 顶替（那正是 MINOR-2 的误报）。
    if (localStrConsts.has(name)) {
      const v = localStrConsts.get(name)!;
      return isMessageCommand(v) ? v : undefined;
    }
    // 本地没定义 → 可能 import 了外部命令常量
    return globalCommandConsts?.get(name);
  };

  const visit = (node: ts.Node): void => {
    // 情况 1：完整的命令名字面量
    if (ts.isStringLiteralLike(node) && isMessageCommand(node.text)) {
      // 定义点（`const CMD = "+messages-send"`）→ 交给使用点判定
      if (isConstDefinitionValue(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const container = findArgsContainer(node);
      // ⚠️ 只在**args 容器**里才算发送站点。`if (cmd === "+messages-send")`、
      //   `return "+messages-reply"`、`{ cmd: "+messages-send" }` 这类非发送
      //   上下文不能当违规（交叉验证实测 MINOR-4）。
      if (container) pushSite(node, container);
    }
    // 情况 2：标识符引用已抽出的命令常量 → 到使用点找容器
    else if (ts.isIdentifier(node) && resolveCmdConst(node.text) !== undefined) {
      // 定义点自身（`const CMD = ` 里的 CMD）没有容器，跳过
      const container = findArgsContainer(node);
      if (container && !isConstDefinitionValue(node)) pushSite(node, container);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return sites;
}

/** 扫全仓（`packages/<pkg>/src` 自动发现，与 `sourceDirs()` 一致） */
function collectAllSites(): SendSite[] {
  const dirs = sourceDirs();
  const files = dirs.flatMap((d) => collectSourceFiles(d));

  // 第一遍：收集**全仓 export 出去的命令常量名**（跨文件引用场景）。
  // 交叉验证实测 P5：常量定义在 A 文件、使用在 B 文件时，原先整条路径零检出。
  const globalCommandConsts = new Map<string, string>();
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.getCombinedModifierFlags(n as unknown as ts.Declaration) &
          ts.ModifierFlags.Export) !== 0
      ) {
        const v = unpackStringLiteral(n.initializer);
        if (v !== undefined && isMessageCommand(v)) globalCommandConsts.set(n.name.text, v);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  return files.flatMap((f) => collectSendSites(f, globalCommandConsts));
}

/** 人类可读的失败清单 */
function formatViolations(sites: SendSite[]): string {
  return sites
    .map(
      (s) =>
        `  ✗ ${s.file}:${s.line}\n` +
        `      args 容器字符串: [${s.containerStrings.map((x) => JSON.stringify(x)).join(", ")}]`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("#4557 跨文件一致性：packages/<pkg>/src 里 +messages-send / +messages-reply 的 args 必须带 --as bot", () => {
  test("扫描器本身可用：确实扫到了仓里的 +messages-send 点位（防扫描器静默返回空集）", () => {
    const sites = collectAllSites();

    // 防空转：如果扫描器写坏了（比如 collectSourceFiles 路径错、
    // 或 findArgsContainer 永远返回 undefined），它会安静地返回 []，
    // 而「所有点位都合规」在空集上恒真 —— 那种测试毫无意义。
    // 这里钉住一个下界：仓里已知有 ≥5 个 +messages-send 构造点。
    expect(sites.length).toBeGreaterThanOrEqual(5);

    // 再钉住「必须被扫到」的关键文件，防止目录遍历漏掉子目录
    const files = new Set(sites.map((s) => s.file));
    expect(files.has("packages/core/src/env/error-reply.ts")).toBe(true);
    expect(files.has("packages/core/src/env/plugin/lark-cli-notification-channel.ts")).toBe(true);
    expect(files.has("packages/core/src/env/event-source/event-source-handlers.ts")).toBe(true);
    expect(files.has("packages/core/src/env/task/plugins/lark-card-patch-notifier.ts")).toBe(true);
    expect(files.has("packages/cli/src/commands/shared/telemetry-notice.ts")).toBe(true);
  });

  test("扫描器能真的判出「缺 --as bot」（自测：数组字面量形态的负例）", () => {
    // 负例（数组字面量）：构造一段**不含** --as bot 的源码文本（临时文件），
    // 断言判定为 false。正例（仓里真实合规写法）由下一条「全仓扫描」覆盖，
    // args.push 形态的正反例由「args.push 形态也被识别」那条覆盖。
    const tmp = join(REPO_ROOT, ".tmp-consistency-selftest.ts");
    const badSource = [
      "declare const chatId: string;",
      "declare const text: string;",
      "function bad() {",
      '  const args = ["im", "+messages-send", "--chat-id", chatId, "--markdown", text];',
      "  return args;",
      "}",
    ].join("\n");
    writeFileSync(tmp, badSource, "utf8");
    try {
      const sites = collectSendSites(tmp);
      expect(sites.length).toBe(1);
      expect(sites[0]!.hasBotIdentity).toBe(false);
    } finally {
      unlinkSync(tmp);
    }
  });

  test("packages/<pkg>/src 里所有命令名点位的 args 容器都必须带 --as bot", () => {
    const sites = collectAllSites();

    // 白名单已清空 ⇒ 不再按文件豁免，全仓统一断言。
    // 若将来必须恢复例外，请把分组 + expectedSites 钉死逻辑加回来（见文件头）。
    const violations = sites.filter((s) => !s.hasBotIdentity);

    expect(
      violations,
      violations.length === 0
        ? ""
        : `\n发现 ${violations.length} 个 +messages-send 缺少 --as bot（默认身份是 user）：\n` +
          formatViolations(violations) +
          `\n\n为什么必须修：\n` +
          `  bot 用 user 身份发出的消息会被 lark-cli 自己的 event consume\n` +
          `  (im.message.receive_v1) 当成「用户消息」回灌 → 再跑一次完整 agent run。\n` +
          `  Task #4552 实测回灌率 5/11 = 45%（token 没省还翻倍），修好后 0/5 = 0%。\n` +
          `  证据：本机报告 reports/4552-a1-real-e2e.md §6（gitignored，未入库）\n\n` +
          `修法：在 args 里加 "--as", "bot"（与 event-source-handlers.ts /\n` +
          `  lark-card-patch-notifier.ts / telemetry-notice.ts 的写法一致）。\n` +
          `  确需 user 身份 → 登记本文件顶部 ALLOWLIST 并写清理由。\n`,
    ).toEqual([]);
  });

  test("★ 不许用拼接拼出命令名（AST；不依赖声明顺序、支持跨文件片段常量）", () => {
    // 交叉验证抓出的漏网：`"+messages-" + "send"` 这类写法里没有**完整的**
    // `+messages-send` 字面量，一致性扫描看不到，等于开了个绕过口子。
    //
    // 这一版针对前两版被指出的缺陷逐条加固：
    // - ❌ 裸正则会**误伤注释**（注释里提一句就变红）→ 改用 AST，注释不在 AST 里
    // - ❌ 只认「以 +messages- 收尾」的片段 → 漏 `const P = "+messages"; P + "-send"`
    //   → 改为**递归折叠**：能算出「常量值」就把它代进去，看拼出来的结果
    // - ❌ 片段常量表按遍历顺序建 → 声明在使用点之后就不命中
    //   → 改为**先建完整表**（两遍遍历），与顺序无关
    // - ❌ 片段常量表每文件一张 → 跨文件漏
    //   → 改为**全仓**收集（本测试自带一次全仓扫描）
    //
    // 判定标准：把拼接表达式里的常量都代入，若结果**包含** `+messages-`
    // 前缀（即可能拼出命令名），就算违规。
    const offenders: string[] = [];

    // ⚠️ 必须走 sourceDirs()，与主扫描同一套范围。若在这里硬编码
    //   core+cli，新纳入的包（coder-harness / ontology-harness）就会在
    //   「拼接绕过」这条路径上裸奔 —— F2 想堵的洞在那些包里还开着
    //   （交叉验证 MINOR-A 实测过）。
    const files = sourceDirs().flatMap((d) => collectSourceFiles(d));

    // ── 第 1 遍：全仓收集「字符串常量值」表（名字 → 值）──────────────
    // 与顺序无关、与文件无关。同名冲突时保留「含 +messages- 的值」那个，
    // 因为那正是我们要追的可疑常量。
    const constValues = new Map<string, string>();
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const collect = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          const v = unpackStringLiteral(n.initializer);
          if (v === undefined) {
            ts.forEachChild(n, collect);
            return;
          }
          const prev = constValues.get(n.name.text);
          // 优先保留「像命令名片段」的值，避免同名无关常量把它挤掉
          if (prev === undefined || (!prev.includes("+messages") && v.includes("+messages"))) {
            constValues.set(n.name.text, v);
          }
        }
        ts.forEachChild(n, collect);
      };
      collect(sf);
    }

    // ── 第 2 遍：逐文件找拼接表达式 ────────────────────────────────
    /** 把表达式折叠成字符串（含常量代入）；无法确定则 undefined */
    const fold = (e: ts.Expression, depth = 0): string | undefined => {
      if (depth > 8) return undefined; // 防常量循环引用
      if (ts.isStringLiteralLike(e)) return e.text;
      if (ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
      if (ts.isParenthesizedExpression(e)) return fold(e.expression, depth + 1);
      if (ts.isIdentifier(e)) return constValues.get(e.text);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const l = fold(e.left, depth + 1);
        const r = fold(e.right, depth + 1);
        if (l !== undefined && r !== undefined) return l + r;
      }
      return undefined;
    };

    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const rel = toRepoRelative(f);
      const report = (node: ts.Node, why: string) => {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push(`  ✗ ${rel}:${line + 1} → ${why}`);
      };

      const visit = (n: ts.Node): void => {
        // 形态 A：+ 拼接（含常量代入后判定）
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          // 只判最外层的 + 链，避免同一处报多次
          const parentIsPlus =
            ts.isBinaryExpression(n.parent) &&
            n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
          if (!parentIsPlus) {
            const folded = fold(n);
            if (folded !== undefined && folded.includes("+messages-")) {
              report(n, `拼接表达式折叠后含命令名前缀：${JSON.stringify(folded)}`);
            }
          }
        }
        // 形态 B：带插值的模板串（无法静态折叠，只看头部是否有命令名前缀）
        if (ts.isTemplateExpression(n)) {
          const head = n.head.text;
          // 只看「以片段收尾」的 head，避免误伤
          // `lark-cli +messages-send did not return message_id: ${...}` 这类错误提示
          if (head.endsWith("+messages-")) {
            report(n, "模板串插值拼出命令名");
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\n发现拼装 +messages-* 命令名的写法（会让一致性扫描静默漏网）：\n` +
          offenders.join("\n") +
          `\n\n请写成完整字面量 "+messages-send" / "+messages-reply"。\n` +
          `若确实要抽常量，请让常量值是**完整命令名**（一致性扫描的常量解析\n` +
          `能盯住它的使用点），不要抽「片段」再拼接。\n`,
    ).toEqual([]);
  });

  test("args.push 形态也被识别：容器 = 调用实参（不是靠「外层函数里别处有 --as bot」蒙对）", () => {
    // 交叉验证抓出的洞：全仓 `args.push(...)` 形态只出现在
    // event-source-handlers.ts（当时被白名单豁免），所以 `findArgsContainer`
    // 里的 `ts.isCallExpression` 分支**零覆盖** —— 把它整个禁用，测试依然全绿。
    // 这里用临时文件给 push 形态正反两个例子，把该分支钉住。
    const cases: Array<{ name: string; src: string; expectBot: boolean }> = [
      {
        name: "push 带 --as bot → 合规",
        src: [
          "declare const args: string[]; declare const id: string;",
          'args.push("+messages-send", "--chat-id", id, "--as", "bot");',
        ].join("\n"),
        expectBot: true,
      },
      {
        name: "push 缺 --as bot → 违规（哪怕同一函数里别处有 --as bot）",
        src: [
          "declare const args: string[]; declare const id: string;",
          'args.push("+messages-reply", "--as", "bot");',
          'args.push("+messages-send", "--chat-id", id);',
        ].join("\n"),
        expectBot: false,
      },
    ];

    const tmp = join(REPO_ROOT, ".tmp-consistency-push-selftest.ts");
    try {
      for (const c of cases) {
        writeFileSync(tmp, c.src, "utf8");
        const sites = collectSendSites(tmp);
        // 现在 send 与 reply 都在扫描范围内，所以第二个 case 会扫到 2 个点位
        // （reply 那个自带 --as bot，合规；send 那个才是被测对象）。
        const sendSites = sites.filter((x) => x.containerStrings.includes(SEND_COMMAND));
        const bad = sendSites.filter((x) => !x.hasBotIdentity);
        expect(bad.length, `${c.name}: 判定期望不符（扫到 ${sendSites.length} 个 send）`).toBe(
          c.expectBot ? 0 : 1,
        );
      }
    } finally {
      unlinkSync(tmp);
    }
  });

  test("event-source-handlers 的 sendLarkMessage 身份必须是**字面量** bot（不是变量兜底）", () => {
    // Task #4557 交叉验证的 BLOCKING：收窄前身份是变量 `identity`，
    // 一致性测试只能断言「调用点传了 as: 'bot'」，断言不到「identity 真的被
    // 拼进 args」。实测：把 identity 换成硬编码 "user"、或把 `--as` 整段删掉，
    // 调用点照样传 as: "bot"，**测试全绿而 bug 复活**。
    //
    // 现在 as 参数已整个删除，身份是字面量。这条测试锁死这个性质：
    // 一旦有人把变量塞回来（args 里出现非字面量身份），立刻变红。
    const absPath = join(
      REPO_ROOT,
      "packages/core/src/env/event-source/event-source-handlers.ts",
    );
    const sourceText = readFileSync(absPath, "utf8");
    const sf = ts.createSourceFile(
      absPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    // 收集所有 push 到 +messages-* 的实参列表，断言 `--as` 后紧跟字符串字面量 "bot"
    const offenders: Array<{ line: number; detail: string }> = [];

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const isPush = node.expression.name.text === "push";
        if (isPush && node.arguments.some((a) => ts.isStringLiteralLike(a) && a.text.startsWith("+messages-"))) {
          const args = node.arguments;
          let ok = false;
          let asIndex = -1;
          for (let i = 0; i < args.length; i++) {
            const a = args[i]!;
            if (ts.isStringLiteralLike(a) && a.text === IDENTITY_FLAG) {
              asIndex = i;
              const next = args[i + 1];
              if (next && ts.isStringLiteralLike(next) && next.text === BOT_IDENTITY) ok = true;
            }
          }
          if (!ok) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            offenders.push({
              line: line + 1,
              detail:
                asIndex === -1
                  ? "args 里没有 --as"
                  : `--as 后不是字面量 "bot"（第 ${asIndex + 2} 个实参不是 "bot" 字面量）`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    // 防空转：真的找到了 push 站点
    const pushSiteCount = (sourceText.match(/args\.push\("\+messages-/g) ?? []).length;
    expect(
      pushSiteCount,
      "没扫到 args.push(\"+messages-*\") 站点 —— 发送路径被重写，请人工确认",
    ).toBeGreaterThanOrEqual(3);

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\nevent-source-handlers.ts 里 args.push 的身份不是字面量 bot：\n` +
          offenders
            .map((o) => `  ✗ packages/core/src/env/event-source/event-source-handlers.ts:${o.line} → ${o.detail}`)
            .join("\n") +
          `\n\n注意：身份**不能**是变量。变量会让「调用点都传 as: 'bot'」这类\n` +
          `间接测试变成空转 —— 变量被改成 "user" 也测不出来（Task #4557 交叉验证实测）。\n`,
    ).toEqual([]);
  });
});
