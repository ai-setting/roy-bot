/**
 * @fileoverview Task #5360（用户澄清 22:37）—— 卡片实体 = session 主键 + task 可选增强
 *
 * ## 用户澄清（覆盖此前「task-or-session 二选一」）
 *
 * > 「卡片主键 = sub-session（不是 task）；有些 sub-session 内部创建了 task，
 * >   有些没有 —— 都是正常的。如果创建了 task → 把 task 信息同步进卡片；
 * >   无论有无 task，sub-session 相关的刷新逻辑始终存在。」
 *
 * 本文件锁定这个语义，重点是**防止退回「二选一」**：
 * A. `sessionId` 必填、`taskId` 可选
 * B. `pickCardSubject` **绝不能**在没有 sessionId 时靠 taskId 返回 subject
 * C. 有 task 的 subject 仍然以 session 为主键（taskId 只是附加值）
 * D. 序列化可逆 + 附加值缺失不影响解析
 */

import { describe, test, expect } from "bun:test";
import {
  cardKeyOf,
  cardSubjectLabel,
  hasTask,
  isCardKey,
  isLegacyTaskCardKey,
  legacyTaskCardKey,
  parseCardKey,
  pickCardSubject,
  sessionCardKey,
  sessionTaskCardKey,
} from "./card-subject";

const SID = "session_04357c17-9ff8-4e3d-a498-bc254da5caf9";

// ============================================================================
// A. 类型语义：session 必填
// ============================================================================

describe("构造主键（session 永远是主键）", () => {
  test("只有 sessionId → session:<id>", () => {
    expect(sessionCardKey(SID)).toBe(`session:${SID}`);
  });

  test("★ sessionId + taskId → session:<id>#task:<n>（task 是附加段）", () => {
    expect(sessionTaskCardKey(SID, 5360)).toBe(`session:${SID}#task:5360`);
  });

  test("★ 空 sessionId → 抛错（主键不能缺，这是本次澄清的核心）", () => {
    expect(() => sessionCardKey("")).toThrow();
    expect(() => sessionCardKey("   ")).toThrow();
    expect(() => cardKeyOf({ sessionId: "" })).toThrow();
  });

  test("非法 taskId 不产生附加段（0 / 负数 / 小数 / NaN 都忽略）", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(cardKeyOf({ sessionId: SID, taskId: bad })).toBe(`session:${SID}`);
    }
  });

  test("legacy 旧卡主键（迁移期只读）", () => {
    expect(legacyTaskCardKey(5360)).toBe("legacy-task:5360");
    expect(isLegacyTaskCardKey("legacy-task:5360")).toBe(true);
    expect(isLegacyTaskCardKey(`session:${SID}`)).toBe(false);
  });
});

// ============================================================================
// B/C. 解析可逆
// ============================================================================

describe("解析主键", () => {
  test("★ 可逆：无 task", () => {
    const s = { sessionId: SID };
    expect(parseCardKey(cardKeyOf(s))).toEqual(s);
  });

  test("★ 可逆：有 task（taskId 作为附加值保留）", () => {
    const s = { sessionId: SID, taskId: 5360 };
    expect(parseCardKey(cardKeyOf(s))).toEqual(s);
  });

  test("★ 有 task 的 key 解析出的 sessionId 仍是同一个（主键不漂移）", () => {
    const a = parseCardKey(sessionCardKey(SID));
    const b = parseCardKey(sessionTaskCardKey(SID, 5360));
    expect(a?.sessionId).toBe(b?.sessionId);
    expect(b?.taskId).toBe(5360);
  });

  test("★ session id 里含冒号 / 井号也能完整保留", () => {
    for (const id of ["a:b:c", "x#y", "weird:id#with:both"]) {
      const key = sessionTaskCardKey(id, 7);
      expect(parseCardKey(key)?.sessionId).toBe(id);
      expect(parseCardKey(key)?.taskId).toBe(7);
    }
  });

  test("畸形 key 一律 undefined（不猜）", () => {
    for (const bad of [
      "",
      "session:",                    // 空 sessionId
      "session:   ",                 // 空白 sessionId
      "task:5360",                   // 旧前缀不再接受
      "5360",
      "session:abc#task:",           // task 段空
      "session:abc#task:0",          // task 非法
      "session:abc#task:1.5",        // 小数
      "session:abc#task:xyz",
      `#task:5`,                     // 缺 session 段
    ]) {
      expect(parseCardKey(bad)).toBeUndefined();
    }
  });

  test("非字符串 → undefined（不抛）", () => {
    for (const bad of [undefined, null, 1, {}, []]) {
      expect(parseCardKey(bad as unknown)).toBeUndefined();
    }
  });

  test("★ legacy-task 不解析成 CardSubject（它没有 sessionId，无法刷新）", () => {
    expect(parseCardKey("legacy-task:5360")).toBeUndefined();
    expect(isLegacyTaskCardKey("legacy-task:5360")).toBe(true);
  });

  test("isCardKey 卫语句", () => {
    expect(isCardKey(sessionCardKey(SID))).toBe(true);
    expect(isCardKey(sessionTaskCardKey(SID, 1))).toBe(true);
    expect(isCardKey("legacy-task:1")).toBe(false);
    expect(isCardKey(undefined)).toBe(false);
  });
});

// ============================================================================
// B. pickCardSubject —— 防退回「二选一」
// ============================================================================

describe("pickCardSubject（session 必需，task 可选）", () => {
  test("只有 sessionId → subject（无 taskId）", () => {
    expect(pickCardSubject({ sessionId: "s1" })).toEqual({ sessionId: "s1" });
  });

  test("★ sessionId + taskId → 两者都有（**不是**只留 taskId）", () => {
    expect(pickCardSubject({ sessionId: "s1", taskId: "5360" })).toEqual({
      sessionId: "s1",
      taskId: 5360,
    });
  });

  test("★ 只有 taskId、没有 sessionId → undefined（绝不退回 task 主键）", () => {
    // 这是本次澄清的核心防线：旧实现会返回 {kind:"task", taskId} 并当 task 卡刷新，
    // 丢掉 session 层信息。现在必须拒绝 —— 没有 session 主键就没有卡片身份。
    expect(pickCardSubject({ taskId: 5360 })).toBeUndefined();
    expect(pickCardSubject({ taskId: "5360" })).toBeUndefined();
  });

  test("非法 taskId + 合法 sessionId → subject 保留 session，丢掉 taskId", () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      expect(pickCardSubject({ sessionId: "s1", taskId: bad })).toEqual({
        sessionId: "s1",
      });
    }
  });

  test("空 / undefined → undefined", () => {
    expect(pickCardSubject({})).toBeUndefined();
    expect(pickCardSubject({ sessionId: "  " })).toBeUndefined();
    expect(pickCardSubject(undefined as any)).toBeUndefined();
  });
});

// ============================================================================
// D. 展示辅助
// ============================================================================

describe("展示辅助", () => {
  test("label 以 session 为主（task 不抢身份）", () => {
    const label = cardSubjectLabel({ sessionId: SID, taskId: 5360 });
    expect(label).toContain("会话 ");
    expect(label).not.toContain("Task #");
  });

  test("超长 session id 截断", () => {
    const label = cardSubjectLabel({ sessionId: `session_${"a".repeat(60)}` });
    expect(label.length).toBeLessThanOrEqual(40);
  });

  test("hasTask", () => {
    expect(hasTask({ sessionId: SID })).toBe(false);
    expect(hasTask({ sessionId: SID, taskId: 5360 })).toBe(true);
    expect(hasTask({ sessionId: SID, taskId: 0 })).toBe(false);
  });
});