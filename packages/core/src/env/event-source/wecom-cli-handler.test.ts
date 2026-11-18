/**
 * @fileoverview Task #5142 — `wecom-cli` EventSource handler 测试
 *
 * ## 为什么测这些点
 *
 * 企微 EventSource 的落地有 4 条硬契约，任何一条破了都会静默丢消息：
 *
 * 1. **落库 esType 必须是 `wecom-cli`**（不是 `lark-cli`）。
 *    `getHandlerForEsType(esType)` 是 v2 notify prompt 的唯一分派 key。
 *    抄成 `lark-cli` 会让 agent 收到「用 lark-cli 发到 oc_xxx」的 prompt，
 *    而企微根本没有 oc_xxx。
 *
 * 2. **`replyChannel.chatId` 永不为空**。
 *    `_captureReplyChannelSnapshot()`（delegate-tool.ts:2864）要求
 *    `chatId || messageId` 至少一个非空，否则**整份快照被丢弃** →
 *    notify event 无回复目标 → 规则通知静默丢失。
 *    企微群聊时 `chatid` 可能缺失（单聊只有 userid），所以必须能落到
 *    `messageId`（msgid）上。
 *
 * 3. **外部二进制 / SDK 缺失时优雅降级**，不 crash、不假装 running。
 *    企微 ES 依赖 `wecom-cli` 二进制 + `@wecom/aibot-node-sdk`，
 *    两者都不是 roy-bot 的硬依赖。
 *
 * 4. **notify prompt 四段式**：用哪个 CLI、什么 flag、禁什么、怎么判成功。
 *    企微 CLI 的错误是 compact JSON `{"error":{type,code,message}}`，
 *    不是 lark-cli 那种 exit code only —— prompt 必须教会 agent 解析 error.type/code。
 */

import { describe, expect, test, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  WECOM_CLI_ES_TYPE,
  wecomCliHandler,
  buildWecomReplyChannel,
  parseWecomFrame,
  buildWecomNotifyPrompt,
  buildWecomChannelSystemPrompt,
  WECOM_CHANNEL_PROMPT_SECTION_TITLE,
  readWecomCredentialsFile,
  resolveWecomCredentials,
  resolveWecomBinary,
  WECOM_CHAT_ID_PREFIX,
} from "./wecom-cli-handler";
import type { EventSourceConfig, EventSourceEvent } from "./types";

// =============================================================================
// 测试夹具
// =============================================================================

function makeConfig(overrides: Partial<EventSourceConfig> = {}): EventSourceConfig {
  return {
    id: "es-wecom-1",
    name: "wecom-test",
    type: WECOM_CLI_ES_TYPE,
    ...overrides,
  } as EventSourceConfig;
}

/** 企微长连接 `aibot_msg_callback` 文本消息帧（真实协议形状） */
const TEXT_MSG_FRAME = {
  cmd: "aibot_msg_callback",
  headers: { req_id: "req-abc-123" },
  body: {
    msgid: "MSGID-0001",
    aibotid: "AIBOT123",
    chatid: "CHATID-GROUP-1",
    chattype: "group",
    from: { userid: "zhangsan" },
    msgtype: "text",
    text: { content: "@RobotA hello robot" },
  },
};

/** 企微长连接 `aibot_event_callback` 进入会话事件帧 */
const ENTER_CHAT_FRAME = {
  cmd: "aibot_event_callback",
  headers: { req_id: "req-event-1" },
  body: {
    msgid: "MSGID-EVT-1",
    create_time: 1700000000,
    aibotid: "AIBOT123",
    from: { userid: "zhangsan" },
    msgtype: "event",
    event: { eventtype: "enter_chat" },
  },
};

/** 企微长连接「单聊」消息帧 —— 无 chatid（只有 userid） */
const SINGLE_MSG_FRAME = {
  cmd: "aibot_msg_callback",
  headers: { req_id: "req-single-1" },
  body: {
    msgid: "MSGID-SINGLE-1",
    aibotid: "AIBOT123",
    chattype: "single",
    from: { userid: "lisi" },
    msgtype: "text",
    text: { content: "你好" },
  },
};

// =============================================================================
// 1. esType 注册
// =============================================================================

describe("wecom-cli handler — esType 注册", () => {
  test("esType 常量是 'wecom-cli'（不能抄 lark-cli）", () => {
    expect(WECOM_CLI_ES_TYPE).toBe("wecom-cli");
    expect(WECOM_CLI_ES_TYPE).not.toBe("lark-cli");
  });

  test("handler.type 与常量一致", () => {
    expect(wecomCliHandler.type).toBe("wecom-cli");
  });
});

// =============================================================================
// 2. validateConfig
// =============================================================================

describe("wecom-cli handler — validateConfig", () => {
  test("缺少 botId 报错", () => {
    const errors = wecomCliHandler.validateConfig(makeConfig());
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("botId");
  });

  test("缺少 secret 报错", () => {
    const errors = wecomCliHandler.validateConfig(makeConfig({ botId: "b1" } as never));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("secret");
  });

  test("botId + secret 齐备时无错误", () => {
    const errors = wecomCliHandler.validateConfig(
      makeConfig({ botId: "b1", secret: "s1" } as never),
    );
    expect(errors).toEqual([]);
  });

  test("缺 id / name 也报错", () => {
    const errors = wecomCliHandler.validateConfig(
      makeConfig({ botId: "b1", secret: "s1", id: "", name: "" } as never),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("secret 支持从 options.secret 读取（CLI 透传路径）", () => {
    const errors = wecomCliHandler.validateConfig(
      makeConfig({
        botId: "b1",
        options: { secret: "from-options" },
      } as never),
    );
    expect(errors).toEqual([]);
  });
});

// =============================================================================
// 3. createInstance + 状态机
// =============================================================================

describe("wecom-cli handler — createInstance 与状态机", () => {
  test("createInstance 返回可用的 instance", () => {
    const inst = wecomCliHandler.createInstance(
      makeConfig({ botId: "b1", secret: "s1" } as never),
    );
    expect(inst).toBeDefined();
    expect(typeof inst.start).toBe("function");
    expect(typeof inst.stop).toBe("function");
    expect(typeof inst.getStatus).toBe("function");
    expect(typeof inst.onEvent).toBe("function");
    expect(typeof inst.offEvent).toBe("function");
  });

  test("初始状态不是 running", () => {
    const inst = wecomCliHandler.createInstance(
      makeConfig({ botId: "b1", secret: "s1" } as never),
    );
    expect(inst.getStatus()).not.toBe("running");
  });

  test("二进制缺失时 start 不抛异常，状态可见为 error", async () => {    const inst = wecomCliHandler.createInstance(
      makeConfig({
        // 指向绝对不存在的二进制路径
        command: "/nonexistent/definitely-not-wecom-cli --consume",
      } as never),
    );
    // 关键：不抛（显式传不存在的凭据文件 → 走骨架路径）
    await (inst as unknown as {
      startWithBridge: (
        f: (u: string) => unknown,
        p?: string,
      ) => Promise<void>;
    }).startWithBridge(
      (u) => ({ on: () => {}, send: () => {}, close: () => {}, terminate: () => {} }),
      "/nonexistent/wecom-credentials.json",
    );
    const st = inst.getStatus();
    // 状态必须能看出「没跑起来」
    expect(st === "running").toBe(false);
  });

  test("wecom-cli 不在 PATH 时同步降级为 error，且给出可执行的安装提示", async () => {
    const inst = wecomCliHandler.createInstance(
      makeConfig({} as never),
    );
    await (inst as unknown as {
      startWithBridge: (
        f: (u: string) => unknown,
        p?: string,
      ) => Promise<void>;
    }).startWithBridge(
      (u) => ({ on: () => {}, send: () => {}, close: () => {}, terminate: () => {} }),
      "/nonexistent/wecom-credentials.json",
    );
    // 如果本机恰好装了 wecom-cli，则跳过该断言（环境相关）
    if (resolveWecomBinary().found) {
      expect(inst.getStatus()).toBe("running");
      await inst.stop();
      return;
    }
    expect(inst.getStatus()).toBe("error");
    const err = (inst as unknown as { getLastError?: () => string | undefined })
      .getLastError?.();
    expect(err).toContain("wecom-cli");
    expect(err).toContain("npmmirror");
  });

  test("stop 在未 start 时是安全的 no-op", async () => {
    const inst = wecomCliHandler.createInstance(
      makeConfig({ botId: "b1", secret: "s1" } as never),
    );
    await inst.stop();
    expect(inst.getStatus()).not.toBe("running");
  });

  // ==========================================================================
  // ★ Task #5193：handleRule.plugins → hook 注册到 globalHookManager
  // ==========================================================================
  describe("插件加载（Task #5193）", () => {
    test("handleRule.plugins 配置 WecomTaskNotifyPlugin → 5 个 task hook 点注册", async () => {
      const { globalHookManager } = await import("../hook/global-hook-manager");
      const inst = wecomCliHandler.createInstance(
        makeConfig({
          botId: "b1",
          secret: "s1",
          handleRule: { plugins: ["WecomTaskNotifyPlugin"] },
        } as never),
      );
      await inst.start();
      // stop 先注销（避免污染其它测试）
      try {
        for (const hp of [
          "task:after.create",
          "task:after.update",
          "task:operation:after.create",
          "task:after.complete",
          "task:after.delete",
        ]) {
          const name = `WecomTaskNotifyPlugin:${hp}`;
          const hooks = (globalHookManager as any)._hooks.get(hp) ?? [];
          const found = hooks.some((h: any) => h.name === name);
          expect(found).toBe(true);
        }
      } finally {
        await inst.stop();
      }
      // stop 后 hooks 已注销
      const { globalHookManager: gm2 } = await import(
        "../hook/global-hook-manager"
      );
      const hooks2 =
        (gm2 as any)._hooks.get("task:after.create") ?? [];
      expect(
        hooks2.some((h: any) => h.name === "WecomTaskNotifyPlugin:task:after.create")
      ).toBe(false);
    });

    test("不配 plugins → 不注册任何 wecom 插件 hook", async () => {
      const { globalHookManager } = await import("../hook/global-hook-manager");
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      );
      await inst.start();
      try {
        const hooks =
          (globalHookManager as any)._hooks.get("task:after.create") ?? [];
        expect(
          hooks.some((h: any) =>
            h.name?.startsWith("WecomTaskNotifyPlugin:")
          )
        ).toBe(false);
      } finally {
        await inst.stop();
      }
    });
  });
});

// =============================================================================
// 4. 事件解析（入站帧 → EventSourceEvent）
// =============================================================================

describe("wecom-cli handler — parseWecomFrame", () => {
  test("解析文本消息帧：chatId / messageId / senderId 齐全", () => {
    const parsed = parseWecomFrame(TEXT_MSG_FRAME);
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata.chatId).toBe("CHATID-GROUP-1");
    expect(parsed!.metadata.messageId).toBe("MSGID-0001");
    expect(parsed!.metadata.senderId).toBe("zhangsan");
    expect(parsed!.metadata.chatType).toBe("group");
    expect(parsed!.metadata.messageType).toBe("text");
    expect(parsed!.metadata.eventType).toBe("wecom.message.receive");
    expect(parsed!.text).toBe("@RobotA hello robot");
  });

  test("解析事件帧（enter_chat）", () => {
    const parsed = parseWecomFrame(ENTER_CHAT_FRAME);
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata.eventType).toBe("wecom.event.enter_chat");
    expect(parsed!.metadata.senderId).toBe("zhangsan");
  });

  test("单聊帧（无 chatid）时用 userid 兜底成 chatId，绝不为空", () => {
    const parsed = parseWecomFrame(SINGLE_MSG_FRAME);
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata.chatId).toBeTruthy();
    // 单聊时 chatId 退化成 userid 形式
    expect(parsed!.metadata.chatId).toContain("lisi");
  });

  test("非法帧返回 null（不抛）", () => {
    expect(parseWecomFrame(null)).toBeNull();
    expect(parseWecomFrame({} as never)).toBeNull();
    expect(parseWecomFrame({ cmd: "ping" } as never)).toBeNull();
    expect(parseWecomFrame({ cmd: "aibot_msg_callback" } as never)).toBeNull();
  });

  test("ack 帧（无 body.msgid）返回 null", () => {
    expect(
      parseWecomFrame({
        cmd: "aibot_msg_callback",
        headers: { req_id: "r" },
        body: { msgtype: "text" },
      } as never),
    ).toBeNull();
  });
});

// =============================================================================
// 4b. 引用消息 quote（Task #5251，对齐 #5212 lark replyContext 模式）
// =============================================================================

describe("wecom-cli handler — 引用消息 quote（Task #5251）", () => {
  /** 带引用的文本消息帧（quote 内嵌被引用内容，企微协议无被引用 msgid） */
  const QUOTE_MSG_FRAME = {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-quote-1" },
    body: {
      msgid: "MSGID-QUOTE-1",
      aibotid: "AIBOT123",
      chatid: "CHATID-GROUP-1",
      chattype: "group",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "请解释一下这句话" },
      quote: {
        msgtype: "text",
        text: { content: "被引用的原文内容" },
      },
    },
  };

  test("parseWecomFrame：quote 存在 → metadata.replyContext.quotedText 提取", () => {
    const parsed = parseWecomFrame(QUOTE_MSG_FRAME);
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata.replyContext).toBeDefined();
    expect(parsed!.metadata.replyContext?.quotedText).toBe(
      "被引用的原文内容",
    );
  });

  test("parseWecomFrame：无 quote → replyContext 保持 undefined（不产生空对象）", () => {
    const parsed = parseWecomFrame(TEXT_MSG_FRAME);
    expect(parsed).not.toBeNull();
    expect(parsed!.metadata.replyContext).toBeUndefined();
  });

  test("parseWecomFrame：quote 是非文本类型（image）→ quotedText 为类型占位", () => {
    const parsed = parseWecomFrame({
      ...QUOTE_MSG_FRAME,
      body: {
        ...QUOTE_MSG_FRAME.body,
        quote: { msgtype: "image", image: { url: "https://x", aeskey: "k" } },
      },
    } as never);
    expect(parsed!.metadata.replyContext?.quotedText).toBe("[image]");
  });

  test("handleWsFrame：quote → recommendedAction.replyContext（agent 可见）", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
        handleWsFrame: (f: unknown) => void;
        onEvent: (h: (e: EventSourceEvent) => void) => void;
      };
      await inst.startWithBridge(() => ({
        on: () => {},
        send: () => {},
        close: () => {},
        terminate: () => {},
      }));
      const events: EventSourceEvent[] = [];
      inst.onEvent((e) => events.push(e));
      inst.handleWsFrame(QUOTE_MSG_FRAME);
      expect(events.length).toBe(1);
      const ra = events[0].recommendedAction as
        | { replyContext?: { quotedText?: string } }
        | undefined;
      expect(ra?.replyContext).toBeDefined();
      expect(ra?.replyContext?.quotedText).toBe("被引用的原文内容");
      // metadata 侧同步有（供 lean/legacy 双路径读取）
      const md = events[0].metadata as {
        replyContext?: { quotedText?: string };
      };
      expect(md.replyContext?.quotedText).toBe("被引用的原文内容");
      await inst.stop();
    } finally {
      err.mockRestore();
    }
  });

  test("handleWsFrame：无 quote → recommendedAction.replyContext 不出现", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
        handleWsFrame: (f: unknown) => void;
        onEvent: (h: (e: EventSourceEvent) => void) => void;
      };
      await inst.startWithBridge(() => ({
        on: () => {},
        send: () => {},
        close: () => {},
        terminate: () => {},
      }));
      const events: EventSourceEvent[] = [];
      inst.onEvent((e) => events.push(e));
      inst.handleWsFrame(TEXT_MSG_FRAME);
      expect(events.length).toBe(1);
      // ★ DS review MINOR-2：前置断言 recommendedAction 本身存在，
      //   避免「事件结构变异 → ra undefined → 误通过」。
      const ra = events[0].recommendedAction as
        | { replyContext?: unknown }
        | undefined;
      expect(ra).toBeDefined();
      expect(ra?.replyContext).toBeUndefined();
      await inst.stop();
    } finally {
      err.mockRestore();
    }
  });

  test("渠道 systemPrompt 含「引用消息上下文」章节（指 recommendedAction.replyContext）", () => {
    const prompt = buildWecomChannelSystemPrompt({});
    expect(prompt).toContain("引用消息上下文");
    expect(prompt).toContain("recommendedAction.replyContext");
    expect(prompt).toContain("quotedText");
  });

  // ★ Task #5317：截图内容边界——截图里内嵌的其他群聊天记录
  //   不是本群对话上下文，禁止当作刚发生的消息转述（跨群串扰观感根因）。
  test("渠道 systemPrompt 含「截图内容边界」规则（Task #5317）", () => {
    const prompt = buildWecomChannelSystemPrompt({});
    expect(prompt).toContain("截图内容边界");
    expect(prompt).toContain("不是本群的对话上下文");
    expect(prompt).toContain("截图里包含的内容");
  });

  // ★ Task #5271：user message 必须携带引用内容。
  //   #5212 MAJOR-2 教训（企微重演）：lark 的 user message 是
  //   JSON.stringify({rawData, recommendedAction})，quotedText 挂
  //   recommendedAction 上 agent 能看到；但企微的 user message 是
  //   `message: parsed.text` **纯文本**，recommendedAction 根本不进
  //   user message → quotedText 挂了也白挂（trace 取证实锤：
  //   session wo26OgBgAAPgnGSqivtEgW7-HeDepvgA 13:42:28 帧 user
  //   message 只有正文，agent 回复时不知道引用内容）。
  //   修复：replyContext 存在时把引用内容拼进 payload.message。
  test("handleWsFrame：quote 存在 → payload.message 含引用内容（LLM 可见）", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
        handleWsFrame: (f: unknown) => void;
        onEvent: (h: (e: EventSourceEvent) => void) => void;
      };
      await inst.startWithBridge(() => ({
        on: () => {},
        send: () => {},
        close: () => {},
        terminate: () => {},
      }));
      const events: EventSourceEvent[] = [];
      inst.onEvent((e) => events.push(e));
      inst.handleWsFrame(QUOTE_MSG_FRAME);
      expect(events.length).toBe(1);
      const msg = (events[0].payload as { message?: string }).message ?? "";
      // 正文仍在
      expect(msg).toContain("请解释一下这句话");
      // ★ 决定性断言：引用内容进了 user message
      expect(msg).toContain("被引用的原文内容");
      await inst.stop();
    } finally {
      err.mockRestore();
    }
  });

  test("handleWsFrame：无 quote → payload.message 保持纯正文（不注入任何引用标记）", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
        handleWsFrame: (f: unknown) => void;
        onEvent: (h: (e: EventSourceEvent) => void) => void;
      };
      await inst.startWithBridge(() => ({
        on: () => {},
        send: () => {},
        close: () => {},
        terminate: () => {},
      }));
      const events: EventSourceEvent[] = [];
      inst.onEvent((e) => events.push(e));
      inst.handleWsFrame(TEXT_MSG_FRAME);
      expect(events.length).toBe(1);
      const msg = (events[0].payload as { message?: string }).message ?? "";
      expect(msg).not.toContain("引用");
      expect(msg).not.toContain("quotedText");
      await inst.stop();
    } finally {
      err.mockRestore();
    }
  });
});

// =============================================================================
// 5. replyChannel（★ 硬约束：chatId || messageId 至少一个非空）
// =============================================================================

describe("wecom-cli handler — replyChannel", () => {
  test("群聊：chatId 与 messageId 都非空，且 chatId 是**可直接回复的原始 chatid**", () => {
    const rc = buildWecomReplyChannel({
      chatId: "CHATID-GROUP-1",
      messageId: "MSGID-0001",
      chatType: "group",
      userId: "zhangsan",
    });
    expect(rc.type).toBe("wecom-cli");
    // ⚠️ 必须是原始值 —— agent 会把它原样塞进 wecom-cli send 的 chat_id
    expect(rc.chatId).toBe("CHATID-GROUP-1");
    expect(rc.messageId).toBe("MSGID-0001");
    expect(rc.params!.chatType).toBe("group");
    expect(rc.params!.userId).toBe("zhangsan");
    expect(rc.params!.wecomChatId).toBe("CHATID-GROUP-1");
  });

  test("单聊：无 chatid 时 chatId 退化成 userid 形式，仍非空", () => {
    const rc = buildWecomReplyChannel({
      chatId: undefined,
      messageId: "MSGID-SINGLE-1",
      chatType: "single",
      userId: "lisi",
    });
    expect(rc.chatId).toBe("lisi");
    expect(rc.messageId).toBe("MSGID-SINGLE-1");
    expect(rc.params!.chatType).toBe("single");
    expect(rc.params!.wecomUserId).toBe("lisi");
  });

  test("★ 恒不返回 chatId/messageId 双空的 replyChannel", () => {
    // 极端输入：全空
    const rc = buildWecomReplyChannel({
      chatId: undefined,
      messageId: undefined,
      chatType: "single",
      userId: undefined,
    });
    expect(Boolean(rc.chatId || rc.messageId)).toBe(true);
    // 占位值带可识别前缀
    expect(rc.chatId).toContain(WECOM_CHAT_ID_PREFIX);
  });

  test("渠道区分靠 type + params.chatType（不靠 chatId 前缀）", () => {
    const rc = buildWecomReplyChannel({
      chatId: "CHATID-GROUP-1",
      messageId: "MSGID-0001",
      chatType: "group",
      userId: "zhangsan",
    });
    expect(rc.type).toBe("wecom-cli");
    expect(rc.params!.chatType).toBe("group");
  });

  // ★ Task #5311（CV M1）：失败回执的 WS fallback 依赖 params.sourceId /
  //   params.reqId；缺了 error-reply 的 spawnWecomReply 只能走 CLI 一条路
  //   （sourceId="unknown" → getWecomRespondTarget 反查不到实例）。
  test("sourceId / reqId 进 params（失败回执 WS fallback 用），缺省时不产生空键", () => {
    const withBoth = buildWecomReplyChannel({
      chatId: "CHATID-GROUP-1",
      messageId: "MSGID-0001",
      chatType: "group",
      userId: "zhangsan",
      sourceId: "es-wecom-prod",
      reqId: "req-5311",
    });
    expect(withBoth.params!.sourceId).toBe("es-wecom-prod");
    expect(withBoth.params!.reqId).toBe("req-5311");

    // 缺省 → 不写空键（避免下游 typeof 检查被 "" 骗过）
    const without = buildWecomReplyChannel({ chatId: "C1" });
    expect("sourceId" in (without.params as object)).toBe(false);
    expect("reqId" in (without.params as object)).toBe(false);
  });
});

// =============================================================================
// 6. notify prompt（四段式）
// =============================================================================

describe("wecom-cli handler — notify prompt 四段式", () => {
  const prompt = buildWecomNotifyPrompt({
    chatId: "CHATID-GROUP-1",
    messageId: "MSGID-0001",
    chatType: "group",
    userId: "zhangsan",
  });

  test("① 段：告诉 agent 用哪个工具回消息", () => {
    expect(prompt).toContain("wecom_respond");
  });

  test("② 段：给出关键参数（content / chat_id / req_id）", () => {
    expect(prompt).toContain("content");
    expect(prompt).toContain("chat_id");
    expect(prompt).toContain("req_id");
  });

  test("③ 段：禁掉绕过官方通道的做法（curl / 直连 API）", () => {
    expect(prompt).toMatch(/curl|qyapi\.weixin\.qq\.com/);
  });

  test("④ 段：教 agent 判断成功（工具 success 字段）", () => {
    expect(prompt).toContain("success");
  });

  test("明确禁止套用 lark-cli 的 flag", () => {
    expect(prompt).toContain("lark-cli");
  });
});

// =============================================================================
// 7. 优雅降级：二进制缺失
// =============================================================================

describe("wecom-cli handler — 二进制缺失优雅降级", () => {
  const originalSpawn = require("child_process").spawn;

  afterEach(() => {
    mock.restore();
  });

  test("spawn 抛 ENOENT 时 start 不 crash，且状态非 running", async () => {
    const cp = require("child_process");
    mock.module("child_process", () => ({
      ...cp,
      spawn: () => {
        const err = new Error("spawn ENOENT");
        (err as { code?: string }).code = "ENOENT";
        throw err;
      },
    }));

    const inst = wecomCliHandler.createInstance(
      makeConfig({} as never),
    );
    await (inst as unknown as {
      startWithBridge: (
        f: (u: string) => unknown,
        p?: string,
      ) => Promise<void>;
    }).startWithBridge(
      (u) => ({ on: () => {}, send: () => {}, close: () => {}, terminate: () => {} }),
      "/nonexistent/wecom-credentials.json",
    );
    expect(inst.getStatus()).not.toBe("running");
  });

  test("子进程立即退出（非 0）时状态变 error", async () => {
    const cp = require("child_process");
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const fakeChild = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        handlers[ev] = cb;
        return fakeChild;
      },
      kill: () => {},
      killed: false,
    };
    mock.module("child_process", () => ({
      ...cp,
      spawn: () => {
        setTimeout(() => handlers["exit"]?.(1, null), 0);
        return fakeChild;
      },
    }));

    const inst = wecomCliHandler.createInstance(
      makeConfig({} as never),
    );
    await (inst as unknown as {
      startWithBridge: (
        f: (u: string) => unknown,
        p?: string,
      ) => Promise<void>;
    }).startWithBridge(
      (u) => ({ on: () => {}, send: () => {}, close: () => {}, terminate: () => {} }),
      "/nonexistent/wecom-credentials.json",
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(inst.getStatus()).toBe("error");
  });
});

// =============================================================================
// 8. DS review MINOR 修复（M1 / M2 / M3）
// =============================================================================

describe("wecom-cli handler — DS review MINOR 修复", () => {
  test("M3：resolveWecomBinary 支持 Windows 扩展名兜底（.exe / .cmd）", () => {
    // 纯命令名探测时，候选应包含 Windows 变体
    const bin = resolveWecomBinary("definitely-not-a-real-binary-xyz");
    expect(bin.found).toBe(false);

    // 显式给出 .exe 后缀时应能找到（构造一个真实存在的临时文件）
    const tmpDir = mkdtempSync(join(tmpdir(), "wecom-bin-"));
    const exeName = "wecom-cli-test-probe.exe";
    const exePath = join(tmpDir, exeName);
    writeFileSync(exePath, "#!/bin/sh\nexit 0\n");
    try {
      const r = resolveWecomBinary(exePath);
      expect(r.found).toBe(true);
      expect(r.path).toBe(exePath);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("M1：骨架模式在 start 时输出醒目告警（不假装能收消息）", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 无 command 且无凭据 → 骨架模式
      const inst = wecomCliHandler.createInstance(
        makeConfig({} as never),
      );
      await (inst as unknown as {
        startWithBridge: (
          f: (u: string) => unknown,
          p?: string,
        ) => Promise<void>;
      }).startWithBridge(
        (u) => ({ on: () => {}, send: () => {}, close: () => {}, terminate: () => {} }),
        "/nonexistent/wecom-credentials.json",
      );
      const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).toContain("骨架");
      await inst.stop();
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });

  test("M1b：自定义 command 时不打印骨架告警（用户已知自己在做什么）", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({
          botId: "b1",
          secret: "s1",
          command: "/bin/echo custom-probe",
        } as never),
      );
      await (inst as unknown as {
        startWithBridge: (
          f: (u: string) => unknown,
          p?: string,
        ) => Promise<void>;
      }).startWithBridge(
        (u) => ({ on: () => {}, send: () => {}, close: () => {}, terminate: () => {} }),
        "/nonexistent/wecom-credentials.json",
      );
      const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).not.toContain("骨架");
      await inst.stop();
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });

  test("M2：无法解析的行会输出可排查的日志（而不是完全静默）", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({
          botId: "b1",
          secret: "s1",
          command: "/bin/echo skeleton-probe",
        } as never),
      );
      await inst.start();
      // 直接驱动内部解析路径：非 JSON 行
      (
        inst as unknown as { handleEventLine: (l: string) => void }
      ).handleEventLine("this is not json");
      const logs = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logs).toContain("wecom-cli");
      expect(logs).toContain("skipping");
      await inst.stop();
    } finally {
      err.mockRestore();
    }
  });
});

// =============================================================================
// 9. Phase 2 — 渠道 system prompt（对标 buildLarkChannelSystemPrompt）
// =============================================================================

describe("wecom-cli handler — buildWecomChannelSystemPrompt", () => {
  test("包含章节标题 + 回复工具 + req_id 透传要求", () => {
    const prompt = buildWecomChannelSystemPrompt({});
    expect(prompt).toContain(WECOM_CHANNEL_PROMPT_SECTION_TITLE);
    expect(prompt).toContain("wecom_respond");
    expect(prompt).toContain("req_id");
  });

  test("文档交付规范：文档类产出必须上传企微文档（微盘/在线文档）并给链接交付（Task #5236）", () => {
    const prompt = buildWecomChannelSystemPrompt({});
    // 覆盖文档类产出类型（调研文档 / docs / ppt）
    expect(prompt).toContain("调研文档");
    expect(prompt).toContain("ppt");
    // 上传企微文档：在线文档 + 微盘两条通道
    expect(prompt).toContain("wecom-cli doc create");
    expect(prompt).toContain("wecom-cli disk files upload");
    // 链接作为交付物，不落本地路径
    expect(prompt).toContain("链接");
    expect(prompt).toContain("不落本地路径");
  });

  test("长度守护：channel prompt 不超过 2200 字符（防膨胀硬上限）", () => {
    const prompt = buildWecomChannelSystemPrompt({});
    expect(prompt.length).toBeLessThanOrEqual(2200);
  });

  test("同一入参多次调用逐字节一致（prompt cache 前缀稳定）", () => {
    const a = buildWecomChannelSystemPrompt({});
    const b = buildWecomChannelSystemPrompt({});
    expect(a).toBe(b);
  });

  test("不读 event/rawEvent（构造入参只有渠道配置）", () => {
    // 签名层面保证：opts 只允许 botId 相关渠道级字段
    const p1 = buildWecomChannelSystemPrompt({});
    const p2 = buildWecomChannelSystemPrompt({ botId: "AIBOT123" });
    expect(p1).not.toBe(p2); // botId 可出现在 prompt 里（渠道身份）
  });
});

// =============================================================================
// 10. Phase 2 — 凭据读取（credentials file 接入 + 优雅降级）
// =============================================================================

describe("wecom-cli handler — 凭据读取", () => {
  test("readWecomCredentialsFile：文件存在时读出 agentId + secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-cred-"));
    const file = join(dir, "wecom-credentials.json");
    writeFileSync(
      file,
      JSON.stringify({ agent_id: "1000003", secret: "sec-test-1" }),
    );
    try {
      const cred = readWecomCredentialsFile(file);
      expect(cred).not.toBeNull();
      expect(cred!.botId).toBe("1000003");
      expect(cred!.secret).toBe("sec-test-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件缺失 / 坏 JSON → 返回 null（不抛）", () => {
    expect(readWecomCredentialsFile("/nonexistent/wecom-credentials.json")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "wecom-cred-bad-"));
    const file = join(dir, "wecom-credentials.json");
    writeFileSync(file, "{not json");
    try {
      expect(readWecomCredentialsFile(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveWecomCredentials：config 优先，其次默认凭据文件，全缺 → undefined", () => {
    // config 里给了 → 直接用
    const fromConfig = resolveWecomCredentials(
      makeConfig({ botId: "b1", secret: "s1" } as never),
      "/nonexistent/wecom-credentials.json",
    );
    expect(fromConfig).toEqual({ botId: "b1", secret: "s1" });

    // 全缺 → undefined（调用方据此优雅降级）
    const none = resolveWecomCredentials(
      makeConfig({} as never),
      "/nonexistent/wecom-credentials.json",
    );
    expect(none).toBeUndefined();
  });

  // ★ Task #5228：options.credentialsPath 曾是 dead config（声明≠实现），
  //   wecom-bot-2 配置了独立凭据文件却仍用生产默认凭据连接 → 无回复。
  test("resolveWecomCredentials：options.credentialsPath 指向独立凭据文件时优先于默认文件（Task #5228）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-cred-opt-"));
    const customFile = join(dir, "wecom-credentials-2.json");
    writeFileSync(
      customFile,
      JSON.stringify({ agent_id: "bot-2-id", secret: "sec-bot-2" }),
    );
    try {
      // config 无显式 botId/secret，仅 options.credentialsPath 指向独立文件
      // → 必须用该文件的凭据（而非默认 ~/.roy-bot/wecom-credentials.json）
      const fromOptions = resolveWecomCredentials(
        makeConfig({
          options: { credentialsPath: customFile },
        } as never),
      );
      expect(fromOptions).toEqual({ botId: "bot-2-id", secret: "sec-bot-2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveWecomCredentials：显式 credentialsPath 参数仍生效（不回归）", () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-cred-param-"));
    const customFile = join(dir, "wecom-credentials-x.json");
    writeFileSync(
      customFile,
      JSON.stringify({ agent_id: "param-id", secret: "sec-param" }),
    );
    try {
      const fromParam = resolveWecomCredentials(
        makeConfig({} as never),
        customFile,
      );
      expect(fromParam).toEqual({ botId: "param-id", secret: "sec-param" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// 11. Phase 2 — Instance 长连接模式（WS 入站真实实现）
// =============================================================================

describe("wecom-cli handler — Instance 长连接模式", () => {
  test("有凭据（config）→ start 走 WS 模式：创建 bridge 并 connect，不发骨架告警", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const created: unknown[] = [];
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
      };
      await inst.startWithBridge((url) => {
        created.push(url);
        // 最小 mock：open 事件不触发也行（start 不等待认证）
        return {
          on: () => {},
          send: () => {},
          close: () => {},
          terminate: () => {},
        };
      });
      expect(created.length).toBe(1);
      expect(String(created[0])).toContain("openws.work.weixin.qq.com");
      const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).not.toContain("骨架");
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });

  test("无凭据（config + 凭据文件都缺）→ 降级骨架模式（告警 + 不连 WS）", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const created: unknown[] = [];
      const inst = wecomCliHandler.createInstance(
        makeConfig({} as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
      };
      await inst.startWithBridge((url) => {
        created.push(url);
        return { on: () => {}, send: () => {}, close: () => {}, terminate: () => {} };
      }, "/nonexistent/wecom-credentials.json");
      expect(created.length).toBe(0); // 没连 WS
      const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).toContain("骨架");
      // 占位命令需要 wecom-cli 二进制；测试环境缺失 → error（不假装 running）
      expect(inst.getStatus()).not.toBe("running");
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });

  test("凭据文件兜底：config 缺 secret 时从凭据文件读出并连 WS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wecom-cred-inst-"));
    const credFile = join(dir, "wecom-credentials.json");
    writeFileSync(
      credFile,
      JSON.stringify({ agent_id: "1000003", secret: "file-secret" }),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const created: unknown[] = [];
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
      };
      await inst.startWithBridge((url) => {
        created.push(url);
        return { on: () => {}, send: () => {}, close: () => {}, terminate: () => {} };
      }, credFile);
      expect(created.length).toBe(1);
      const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).not.toContain("骨架");
    } finally {
      warn.mockRestore();
      err.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WS 收到消息帧 → 产出 EventSourceEvent（metadata.systemPrompt 注入渠道 prompt）", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
        getBridge: () => unknown;
      };
      let mockWs: {
        on: (ev: string, cb: (...a: unknown[]) => void) => void;
        send: (d: string) => void;
        close: () => void;
        terminate: () => void;
        emit: (ev: string, ...a: unknown[]) => void;
      } | null = null;
      await inst.startWithBridge(() => {
        const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
        mockWs = {
          on: (ev, cb) => (handlers[ev] ??= []).push(cb),
          send: () => {},
          close: () => {},
          terminate: () => {},
          emit: (ev, ...a) => {
            for (const cb of handlers[ev] ?? []) cb(...a);
          },
        };
        return mockWs as unknown as WebSocketLike;
      });
      // 认证成功
      (mockWs as unknown as { emit: (ev: string, ...a: unknown[]) => void }).emit("open");
      // 直接驱动 handleWsFrame（绕开 send 细节）
      const events: EventSourceEvent[] = [];
      (inst as unknown as { onEvent: (h: (e: EventSourceEvent) => void) => void }).onEvent(
        (e) => events.push(e),
      );
      (inst as unknown as { handleWsFrame: (f: unknown) => void }).handleWsFrame({
        cmd: "aibot_msg_callback",
        headers: { req_id: "r1" },
        body: {
          msgid: "M-WS-1",
          aibotid: "AIBOT123",
          chatid: "CHAT-G",
          chattype: "group",
          from: { userid: "zhangsan" },
          msgtype: "text",
          text: { content: "hello" },
        },
      });
      expect(events.length).toBe(1);
      const evt = events[0];
      expect(evt.type).toBe("event-source.event.wecom-cli");
      expect(evt.metadata.chatId).toBe("CHAT-G");
      expect(evt.metadata.systemPrompt).toBeDefined();
      expect(evt.metadata.systemPrompt).toContain(
        WECOM_CHANNEL_PROMPT_SECTION_TITLE,
      );
      expect(evt.replyChannel.chatId).toBe("CHAT-G");
    } finally {
      err.mockRestore();
    }
  });
});

// =============================================================================
// 12. Task #5174 — 回复注册表接线（startWithBridge 登记 / stop 注销 / reqId 透传）
// =============================================================================

import {
  getWecomRespondTarget,
  __resetWecomRespondRegistryForTest,
} from "./wecom-respond-registry";

describe("wecom-cli handler — 回复注册表接线（Task #5174）", () => {
  beforeEach(() => __resetWecomRespondRegistryForTest());

  test("startWithBridge 成功建桥 → 注册表登记 sourceId → respond 走 ws.send", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sent: string[] = [];
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
      };
      let mockWs: any = null;
      await inst.startWithBridge(() => {
        const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
        mockWs = {
          on: (ev: string, cb: (...a: unknown[]) => void) =>
            (handlers[ev] ??= []).push(cb),
          send: (d: string) => sent.push(d),
          close: () => {},
          terminate: () => {},
          emit: (ev: string, ...a: unknown[]) => {
            for (const cb of handlers[ev] ?? []) cb(...a);
          },
          readyState: 1,
          feed: (frame: unknown) => {
            mockWs.emit(
              "message",
              Buffer.from(JSON.stringify(frame)),
            );
          },
        };
        return mockWs;
      });
      mockWs.emit("open");
      const auth = JSON.parse(sent[0]);
      mockWs.feed({ headers: { req_id: auth.headers.req_id }, errcode: 0 });

      // 注册表应有该 sourceId
      const target = getWecomRespondTarget("es-wecom-1");
      expect(target).toBeDefined();

      // respond → aibot_respond_msg 帧发出
      const before = sent.length;
      const sendErr = target!.respond("orig-req-9", {
        msgtype: "text",
        text: { content: "reply" },
      });
      expect(sendErr).toBeUndefined();
      const frame = JSON.parse(sent[sent.length - 1]);
      expect(frame.cmd).toBe("aibot_respond_msg");
      expect(frame.headers.req_id).toBe("orig-req-9");
      void before;

      await inst.stop();
      // stop 后注销
      expect(getWecomRespondTarget("es-wecom-1")).toBeUndefined();
    } finally {
      err.mockRestore();
    }
  });

  test("handleWsFrame 产出事件 metadata.reqId = 原帧 req_id", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
        handleWsFrame: (f: unknown) => void;
        onEvent: (h: (e: EventSourceEvent) => void) => void;
      };
      await inst.startWithBridge(() => ({
        on: () => {},
        send: () => {},
        close: () => {},
        terminate: () => {},
      }));
      const events: EventSourceEvent[] = [];
      inst.onEvent((e) => events.push(e));
      inst.handleWsFrame({
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-xyz-777" },
        body: {
          msgid: "M-777",
          aibotid: "AIBOT123",
          chattype: "single",
          from: { userid: "DongZhaoKun" },
          msgtype: "text",
          text: { content: "hi" },
        },
      });
      expect(events.length).toBe(1);
      expect(events[0].metadata.reqId).toBe("req-xyz-777");
      // recommendedAction 也带 req_id（agent 可直接读到）
      expect(events[0].recommendedAction?.action).toContain("req-xyz-777");
      await inst.stop();
    } finally {
      err.mockRestore();
    }
  });
});

// =============================================================================
// 13. Task #5174 — payload.message 必填（否则 agent 收到 "[unknown] undefined"）
// =============================================================================

describe("wecom-cli handler — payload.message（Task #5174 RED）", () => {
  test("handleWsFrame 产出事件必须带 payload.message（含用户正文）", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        startWithBridge: (f: (url: string) => unknown) => Promise<void>;
        handleWsFrame: (f: unknown) => void;
        onEvent: (h: (e: EventSourceEvent) => void) => void;
      };
      await inst.startWithBridge(() => ({
        on: () => {},
        send: () => {},
        close: () => {},
        terminate: () => {},
      }));
      const events: EventSourceEvent[] = [];
      inst.onEvent((e) => events.push(e));
      inst.handleWsFrame({
        cmd: "aibot_msg_callback",
        headers: { req_id: "req-payload-1" },
        body: {
          msgid: "M-PAYLOAD",
          aibotid: "AIBOT123",
          chattype: "single",
          from: { userid: "DongZhaoKun" },
          msgtype: "text",
          text: { content: "1234" },
        },
      });
      expect(events.length).toBe(1);
      const payload = events[0].payload as { message?: string } | undefined;
      // ★ 根因：formatter 只读 payload.message；缺失 → agent 看到 "[unknown] undefined"
      expect(payload).toBeDefined();
      expect(typeof payload?.message).toBe("string");
      expect(payload?.message).toContain("1234");
      await inst.stop();
    } finally {
      err.mockRestore();
    }
  });

  test("handleEventLine（骨架路径）同样带 payload.message", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      const inst = wecomCliHandler.createInstance(
        makeConfig({ botId: "b1", secret: "s1" } as never),
      ) as unknown as {
        handleEventLine?: (line: string) => void;
        onEvent: (h: (e: EventSourceEvent) => void) => void;
      };
      const events: EventSourceEvent[] = [];
      inst.onEvent((e) => events.push(e));
      const line = JSON.stringify(TEXT_MSG_FRAME);
      // 骨架路径的 handleEventLine 是 private；用 as any 直调（测试专用）
      (inst as unknown as { handleEventLine: (l: string) => void }).handleEventLine(
        line,
      );
      expect(events.length).toBe(1);
      const payload = events[0].payload as { message?: string } | undefined;
      expect(typeof payload?.message).toBe("string");
      expect(payload?.message).toContain("hello");
    } finally {
      err.mockRestore();
    }
  });
});
