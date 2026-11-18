/**
 * @fileoverview Task #5036 — 生产接线：interactive 的 EventHandler 真的接上卡片链接解析器
 *
 * ## 为什么要单独测「接线」而不是只测纯函数
 *
 * #4588 的教训（写在该文件注释里）：**纯函数全绿 ≠ 生产端真的调用了它**。
 * 那次交叉验证实测「把生产端 telemetrySender 整段删掉，10 个测试依然全绿」。
 *
 * 同类风险在这里同样存在：`card-message-link.ts` / `card-link-resolver.ts`
 * 可以 30/30 全绿，而 `buildInteractiveEventHandlerOptions()` 忘传
 * `resolveCardUrl` —— 功能等于没上。
 *
 * ⇒ 本文件断言的是**生产工厂函数的返回值**里确实带 `resolveCardUrl`，
 *   并且把用户真实链路（终态回执 → telemetrySender）串起来看文案里有没有链接。
 */

import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLarkCardStateStore,
} from "@ai-setting/roy-bot-core/env/task/plugins";

import { buildInteractiveEventHandlerOptions } from "../interactive";
import { clearCardLinkCache } from "./card-message-link";
import { resetCardRecordStoreCacheForTest } from "./card-link-resolver";

/**
 * 剥掉 `//` 行注释（保留 `://` 这类协议前缀里的双斜杠）。
 *
 * 只做到「够用」：本文件断言的源码里没有多行注释包裹的那一行。
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.search(/(^|[^:])\/\//);
      if (idx === -1) return line;
      // `[^:]` 匹配到的那一位也要保留
      return line.slice(0, idx + 1);
    })
    .join("\n");
}

describe("Task #5036 — buildInteractiveEventHandlerOptions 接线", () => {
  test("★ 返回值必须带 resolveCardUrl（忘传 = 功能等于没上）", () => {
    const opts = buildInteractiveEventHandlerOptions({
      env: {} as any,
      sessionComponent: {} as any,
    });
    expect(typeof opts.resolveCardUrl).toBe("function");
  });

  test("★ deps.resolveCardUrl 被原样透传（注入的实现真的被调用）", async () => {
    const CARD_URL = "https://applink.feishu.cn/client/chat/open?openChatId=oc_x&position=7";

    let calledWith: number | undefined;
    const opts = buildInteractiveEventHandlerOptions({
      env: {} as any,
      sessionComponent: {} as any,
      // 生产端透传点：必须能把自定义解析器塞进来（测试 / 未来换实现）
      resolveCardUrl: async (taskId: number) => {
        calledWith = taskId;
        return taskId === 4954 ? CARD_URL : undefined;
      },
    });

    expect(typeof opts.resolveCardUrl).toBe("function");
    expect(await opts.resolveCardUrl!(4954)).toBe(CARD_URL);
    // ★ 不是同义反复：断言注入的实现**真的被调用**且拿到了正确的 taskId
    expect(calledWith).toBe(4954);
    expect(await opts.resolveCardUrl!(9999)).toBeUndefined();
    expect(calledWith).toBe(9999);
  });

  test("★ 默认实现真的走 createCardUrlResolver 生产链路（不是空壳）", async () => {
    // ★ DS review N3：旧写法只断言「对不存在的 task 返回 undefined」——
    //   任何 `async () => undefined` 空壳都能通过，是同义反复。
    //
    //   现在改成**行为区分**：让默认解析器指向一个真实临时库（通过官方
    //   `ROY_AGENT_LARK_CARD_DB` 覆盖点），库里有卡 ⇒ 必须能解析出链接。
    //   空壳实现必然返回 undefined ⇒ 会红。
    const dir = mkdtempSync(join(tmpdir(), "card-link-wiring-n3-"));
    const dbPath = join(dir, "lark-cards.db");
    const prevEnv = process.env.ROY_AGENT_LARK_CARD_DB;
    const store = createLarkCardStateStore(dbPath);
    store.upsert({
      taskId: 4954,
      messageId: "om_n3_msg",
      chatId: "oc_n3_chat",
      pinned: true,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.close();

    try {
      process.env.ROY_AGENT_LARK_CARD_DB = dbPath;
      resetCardRecordStoreCacheForTest();
      clearCardLinkCache();

      const opts = buildInteractiveEventHandlerOptions({
        env: {} as any,
        sessionComponent: {} as any,
        // 不注入 resolveCardUrl → 走默认生产实现；lookup 也不真 spawn：
        // 这里只验证「读到了记录」这一层，故用 chatCare 级链接（无 position 时）
      });
      const url = await opts.resolveCardUrl!(4954);
      // 空壳 ⇒ undefined ⇒ 这里红；真实现 ⇒ 至少是 chat 级 applink
      expect(url).toContain("applink.feishu.cn/client/chat/open");
      expect(url).toContain("oc_n3_chat");
    } finally {
      if (prevEnv === undefined) delete process.env.ROY_AGENT_LARK_CARD_DB;
      else process.env.ROY_AGENT_LARK_CARD_DB = prevEnv;
      resetCardRecordStoreCacheForTest();
      clearCardLinkCache();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

// ============================================================================
// DS review B1：daemon 走的 run.ts 也必须接线（否则功能等于没上）
// ============================================================================

describe("Task #5036 — daemon 生产路径 run.ts 接线（DS review B1）", () => {
  /**
   * 为什么用「源码断言」而不是行为断言：
   *
   * `run.ts` 的 EventHandler 装配在 `createInteractiveCommand()` 的闭包里，
   * 需要完整 EnvironmentService 才能执行到那一层（起不来会 process.exit）。
   *
   * #4588 那次交叉验证明确说「字符串包含能被注释/字面量绕过」—— 所以这里
   * **不是**简单 grep 关键词，而是断言三件事同时成立：
   *   ① `createCardUrlResolver` 被 import 进 run.ts
   *   ② 传给 `createEventHandlerForInteractive` 的对象字面量里出现
   *      `resolveCardUrl: createCardUrlResolver()`
   *   ③ 该出现位置在 `createEventHandlerForInteractive({` 之后、
   *      下一个 `});` 之前（真的是那个调用的属性，不是别处）
   */
  test("★ run.ts 的 EventHandler 装配里真的有 resolveCardUrl: createCardUrlResolver()", async () => {
    const src = await Bun.file(
      new URL("../run.ts", import.meta.url).pathname,
    ).text();

    expect(src).toContain("import { createCardUrlResolver }");

    // ★ DS review N3：必须先剥掉注释再断言。
    //   否则把该行**注释掉**依然能通过（注释文本里仍含关键字）——
    //   实测过这个绕过路径。
    const stripped = stripLineComments(src);

    const callIdx = stripped.indexOf("createEventHandlerForInteractive({");
    expect(callIdx).toBeGreaterThan(-1);

    // 取该调用的对象字面量区间（到首个 `});` 为止）
    const tail = stripped.slice(callIdx);
    const endIdx = tail.indexOf("});");
    expect(endIdx).toBeGreaterThan(-1);
    const objectLiteral = tail.slice(0, endIdx);

    // 断言**未注释**的真实代码行
    expect(objectLiteral).toMatch(
      /^\s*resolveCardUrl:\s*createCardUrlResolver\(\),?\s*$/m,
    );
  });
});
