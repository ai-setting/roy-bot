/**
 * @fileoverview buildLarkRecommendedAction「单条结构化回复」不变量回归测试
 *
 * 合并自 no-segmented-response.test.ts（Task #4242）+ no-segmented-replies.test.ts（Task #4243）。
 *
 * 背景：#4242 与 #4243 是两个**并行 task 修同一个 bug**（sub-agent 把回复拆成多条循环 send），
 * 各自往同一个 prompt 里加了一整节（「关键 0」+「关键 4」），各自 merge 到 main 后
 * 同一条规则在 prompt 里重复三遍、占全 prompt 38% 字符，且两节给出的"照抄模板"互相矛盾
 * （关键 4 用 +messages-send --chat-id，关键 2/3 用 +messages-reply --message-id）。
 *
 * 因此本文件不再断言"某个字面词还在不在"，而是断言**不变量**：
 *   (A) 单一来源：只有 1 个章节标题谈"分段"；--reply-in-thread 全文只出现 1 次
 *   (B) 行为规则：禁分段 / 禁循环 send / 禁"陆续更新" / 禁占位帖 / 发送动作只调一次
 *   (C) 单条语义：长度上限用官方 30 KB 请求体（飞书错误码 230025），不用无出处的 "4096 字符"；
 *       保留 --msg-type post
 *   (D) 模板一致：命令模板不超过 3 份，且回复场景模板用 +messages-reply --message-id
 *   (E) 长内容：不教 HTML 折叠标签，给出已验证的附件区方案（--attachment）
 *   (F) 指令优先级：显式声明本 prompt 覆盖 lark-* skill 文档（否则 sub-agent 被
 *       lark-im 的「Prefer --markdown」带跑，自行拼 flag——#4241 的根因）
 *   (G) 防膨胀：prompt 长度上限（防止再一次"各加一节"）
 *   (H) 保留 #4137 + #4171 全部硬规则（--as bot / 禁 api POST / exit code / idempotency-key）
 */

import { describe, test, expect } from "bun:test";
import { buildLarkRecommendedAction, LARK_PROMPT_LENGTH_BUDGET } from "./event-source-handlers";

const baseOpts = {
  profile: "tongzhuli",
  chatType: "group",
  appId: "cli_aXXXXXXXXXXXXXX",
  chatId: "oc_6bc538acf41894300cf8da037f9f7cd0",
  messageId: "om_x100b63ee7efb8cacb18909655fcba6f",
} as const;

function buildAction(overrides: Record<string, string> = {}): string {
  return buildLarkRecommendedAction({ ...baseOpts, ...overrides }).action;
}

/** 统计 needle 在 hay 里出现次数 */
function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** 章节标题（以 "## " 开头的行） */
function sectionHeadings(action: string): string[] {
  return action.split("\n").filter((line) => line.startsWith("## "));
}

/** 发送类命令模板行（缩进后以 lark-cli 开头、且含 +messages-reply / +messages-send 的示例命令） */
function sendTemplateLines(action: string): string[] {
  return action
    .split("\n")
    .filter((line) => /^\s*lark-cli\s/.test(line))
    .filter((line) => /\+messages-(reply|send)/.test(line))
    .map((line) => line.trim());
}

/** 单行内定位 upload / attachment 示例 */
function lineContaining(action: string, re: RegExp): string | undefined {
  return action.split("\n").find((line) => re.test(line));
}

/** 从首个匹配行开始的连续 count 行（用于断言"某个数字附近的上下文"） */
function blockFrom(action: string, re: RegExp, count: number): string {
  const lines = action.split("\n");
  const idx = lines.findIndex((line) => re.test(line));
  return idx < 0 ? "" : lines.slice(idx, idx + count).join("\n");
}

describe("单条结构化回复 prompt 不变量（#4242 + #4243 合并修复）", () => {
  // ────────────────────────────────────────────────────────────────────
  // (A) 单一来源 —— 同一条规则只允许存在一处
  // ────────────────────────────────────────────────────────────────────
  describe("(A) 单一来源：禁分段规则不得在多处重复", () => {
    test("只有 1 个章节标题谈「分段」（禁止再并列出「关键 0」+「关键 4」）", () => {
      const action = buildAction();
      const segmentedSections = sectionHeadings(action).filter((h) => /分段/.test(h));
      expect(segmentedSections).toHaveLength(1);
    });

    test("--reply-in-thread 全文只出现 1 次（单一来源，不重复告诫）", () => {
      const action = buildAction();
      expect(occurrences(action, "--reply-in-thread")).toBe(1);
    });

    test("语义级去重：核心禁令措辞在全文各只出现 1 次", () => {
      const action = buildAction();
      // 标题级守护（上一条）可被"换个不含『分段』的标题重加一节"绕过，
      // 这里再按**措辞**统计：同一条禁令不该在第二个章节被复述。
      expect(occurrences(action, "禁止分段")).toBe(1);
      expect(occurrences(action, "只发一条")).toBe(1);
      expect(occurrences(action, "陆续更新")).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (B) 行为规则 —— 禁分段 / 禁循环 send / 发送动作只调一次
  // ────────────────────────────────────────────────────────────────────
  describe("(B) 行为规则：禁分段 + 发送动作只调一次", () => {
    test("显式禁止分段发送（拆成多条 / 拆短 / 多条消息）", () => {
      const action = buildAction();
      expect(action).toMatch(/禁止\s*分段|不要\s*分段/);
      expect(action).toMatch(/拆成多条|拆成\s*多\s*条|分\s*多条|多条消息/);
    });

    test("显式禁止用循环多次调发送命令", () => {
      const action = buildAction();
      expect(action).toMatch(/循环/);
      expect(action).toMatch(/for\s*\/\s*while|for.*while|循环.*send|send.*循环/);
    });

    test("显式禁止「陆续更新」与占位帖（子任务结束后不要再补发）", () => {
      const action = buildAction();
      expect(action).toMatch(/陆续更新|陆续发/);
      expect(action).toMatch(/占位/);
    });

    test("「只调一次」被限定为「发送类」命令（不误伤上传/查询等非发送调用）", () => {
      const action = buildAction();
      expect(action).toMatch(/发送类|发送动作|发送命令/);
      // 附带说明：上传/查询等非发送类命令不受此限
      expect(action).toMatch(/上传|非发送/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (C) 单条语义 —— 长度约束必须是真实的 30 KB 请求体上限
  // ────────────────────────────────────────────────────────────────────
  describe("(C) 单条语义：上限用官方 30 KB 请求体，不用无出处的 4096 字符", () => {
    test("不得再出现 4096 这个无出处数字（它会变成 agent 的自定分段阈值）", () => {
      const action = buildAction();
      expect(action).not.toMatch(/4096/);
    });

    test("必须给出官方上限：富文本 post 请求体 ≤ 30 KB，且写明它不是分段阈值", () => {
      const action = buildAction();
      // 断言"30 KB 附近的上下文"（只断言含 /30 KB/ 的那一行 + /单条|请求体/ 近乎永真：
      // 它们必然同句，挡不住"把数字写在无单条语义处"的变体）
      const block = blockFrom(action, /30\s*KB/, 4);
      expect(block).not.toBe("");
      expect(block).toContain("请求体");
      // 核心：30 KB 必须被明确标注为"不是分段阈值"，否则 agent 会拿它当切分依据
      expect(block).toMatch(/不是.*(分段阈值|阈值)|不要.*(据此|数字)/);
      // 且必须给替代动作，不能只给个数字
      expect(block).toMatch(/压缩|附件/);
      // 触发上限时飞书返回 230025，写出来可避免 agent 误判为"路径不对"去换路径
      expect(action).toMatch(/230025/);
    });

    test("prompt 必须保留 --msg-type post 强制指令", () => {
      const action = buildAction();
      expect(action).toMatch(/--msg-type\s+post/);
    });

    test("不得出现任何「按 N 条/段切分」的阈值写法", () => {
      const action = buildAction();
      expect(action).not.toMatch(/split\s+into\s+(multiple|many|\d)/i);
      // 覆盖「每条/每段/每截 + 最多|不超过|小于|上限 + 数字」的多种写法
      expect(action).not.toMatch(/每(条|段|截|块)[^\n]{0,8}(最多|不超过|小于|上限|[<≤])[^\n]{0,4}\d/);
    });

    test("md 语法约束必须写清：表格/引用前后要空一行", () => {
      const action = buildAction();
      expect(action).toMatch(/空一行/);
      expect(action).toMatch(/表格/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (D) 模板一致 —— 不允许再出现第 4 份互相矛盾的命令示例
  // ────────────────────────────────────────────────────────────────────
  describe("(D) 模板一致：命令示例只保留「回复」模板 + 「发到会话」模板", () => {
    test("发送类命令模板不超过 4 份（关键 2 的 jq 模板 + 关键 3 的 reply/send + #5472 群聊 @ sender 示例）", () => {
      const action = buildAction();
      expect(sendTemplateLines(action).length).toBeLessThanOrEqual(4);
    });

    test("回复场景模板必须用 +messages-reply --message-id（不是 +messages-send --chat-id）", () => {
      const action = buildAction();
      expect(action).toMatch(/messages-reply\s+--message-id/);
      // 每份发送模板都必须显式带 --as bot（#4137 P0）
      for (const line of sendTemplateLines(action)) {
        expect(line).toContain("--as bot");
      }
      expect(action).toMatch(/messages-reply[\s\S]*?--as\s+bot/);
      expect(action).toMatch(/messages-send[\s\S]*?--as\s+bot/);
    });

    test("+messages-send 模板必须限定在「无 messageId」分支，不能作为回复主模板", () => {
      const action = buildAction();
      expect(action).toMatch(/无\s*messageId|只有\s*chatId/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (E) 长内容 —— 不教未验证的 HTML 折叠，给附件区方案
  // ────────────────────────────────────────────────────────────────────
  describe("(E) 长内容：单条 post + 附件区，而不是未验证的 HTML 折叠", () => {
    test("不得把 HTML 折叠标签当作长内容方案（飞书 post 的 md 节点不支持 raw HTML）", () => {
      const action = buildAction();
      expect(action).not.toContain("<details>");
      expect(action).not.toContain("<summary>");
    });

    test("必须给出 post 附件区方案（--attachment + im files create）", () => {
      const action = buildAction();
      expect(action).toMatch(/im files create/);
      expect(action).toMatch(/--attachment/);
    });

    test("附件上传模板必须可直接照抄：im files create 需要 --data 且必须 --as bot", () => {
      const action = buildAction();
      const uploadLine = action
        .split("\n")
        .find((line) => /im files create/.test(line) && /^\s*lark-cli\s/.test(line));
      expect(uploadLine).toBeDefined();
      // 实测：只给 --file 会报 234001 Invalid request param，必须带 --data(file_name/file_type)
      expect(uploadLine).toContain("--data");
      expect(uploadLine).toContain("file_type");
      // 实测：im files create 默认 identity=user，与 #4137「出站必须 --as bot」同类风险
      expect(uploadLine).toContain("--as bot");
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (F) 指令优先级 —— 本 prompt 覆盖 lark-* skill 文档
  // ────────────────────────────────────────────────────────────────────
  describe("(F) 指令优先级：本 prompt 覆盖 lark-* skill 文档", () => {
    test("显式声明冲突时以本 prompt 为准", () => {
      const action = buildAction();
      expect(action).toMatch(/以本 prompt 为准|优先于.*skill|覆盖.*skill/);
      expect(action).toMatch(/lark-/); // 点名 lark-* skill 文档
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (G) 防膨胀 —— 长度上限，防止"各加一节"式回归
  // ────────────────────────────────────────────────────────────────────
  describe("(G) 防膨胀：prompt 长度上限", () => {
    // 预算常量：去重前 5395（baseOpts, profile=tongzhuli），当前 5109
    // （Task #5164 需求 1 追加文档交付规范段 +246；
    //  Task #5212 追加引用上下文段后 legacy action 5109 / lean 渠道 prompt 5287）。
    // 这是**防御性上限**（不是编辑预算）：重加一节（原关键 4 约 1330 字符）会立刻超；
    // 正常的小幅扩写（更长的 profile 名、补充说明）仍有 ~5% 余量，不必动这个常量。
    const PROMPT_LENGTH_BUDGET = LARK_PROMPT_LENGTH_BUDGET;

    test(`action 总长度 < ${PROMPT_LENGTH_BUDGET} 字符（去重前 5395）`, () => {
      const action = buildAction();
      expect(action.length).toBeLessThan(PROMPT_LENGTH_BUDGET);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // (H) 保留 #4137 + #4171 硬规则
  // ────────────────────────────────────────────────────────────────────
  describe("(H) 保留 #4137 + #4171 硬规则", () => {
    test("P0 (#4137): 强制 --as bot", () => {
      const action = buildAction();
      expect(action).toMatch(/--as\s+bot/);
      expect(action).toMatch(/必须\s*--as\s*bot|--as\s*bot\s*强制|显式\s*--as\s*bot/);
    });

    test("P0 (#4137): 警告 api POST 是 user-identity 路径（自我回灌根因）", () => {
      const action = buildAction();
      expect(action).toMatch(/api\s+POST|open-apis\/im\/v1\/messages/);
      expect(action).toMatch(/identity\s*=\s*user|user-identity|user\s*身份/);
      expect(action).toMatch(/回灌|自我|self.echo|self-echo/);
    });

    test("(#4171): 禁止 --reply-in-thread（会进 thread，主聊天流看不到）", () => {
      const action = buildAction();
      expect(action).toMatch(/禁止.*--reply-in-thread|不要.*--reply-in-thread|不能.*--reply-in-thread|绝不能加.*--reply-in-thread/);
      expect(action).toMatch(/thread/);
    });

    test("(#4137 P1): 成功判定只看退出码，禁止 parse stdout JSON", () => {
      const action = buildAction();
      expect(action).toMatch(/禁止.*json\.load|json\.tool.*禁止/);
      expect(action).toMatch(/exit\s*code|退出码/);
    });

    test("(#4137 P1): idempotency-key 作为重试建议保留，并提示 50 字符上限", () => {
      const action = buildAction();
      expect(action).toMatch(/idempotency-key|idempotency\s*key|幂等/);
      // 实测 --help: "idempotency key, max 50 characters" —— 不提示会让 agent 塞长 hash 后报错
      expect(action).toMatch(/idempotency-key[\s\S]{0,30}50\s*字符/);
    });

    test("结构化 post 回复路径保留（--msg-type post --content + jq --rawfile）", () => {
      const action = buildAction();
      expect(action).toMatch(/--msg-type\s+post\s+--content/);
      expect(action).toMatch(/--rawfile/);
    });

    test("禁止 --text / --markdown（会丢结构化 at 节点）", () => {
      const action = buildAction();
      expect(action).toMatch(/禁止\s*--text/);
      expect(action).toMatch(/禁止\s*--markdown/);
    });

    test("profile / chatId / messageId 必须取自 replyTo", () => {
      const action = buildAction();
      expect(action).toMatch(/replyTo/);
      const line = lineContaining(action, /recommendedAction\.replyTo/);
      expect(line).toBeDefined();
      // 三个字段都要在这条约束里点名（只断言 /replyTo/ 是近乎永真的）
      expect(line).toContain("profile");
      expect(line).toContain("chatId");
      expect(line).toContain("messageId");
    });
  });
});
