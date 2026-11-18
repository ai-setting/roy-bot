/**
 * Task #5459 — 飞书协作 skill 的内容守卫
 *
 * ## 为什么用测试守 skill 文本
 *
 * skill 是**给 agent 读的操作手册**。里面每条命令、每个坑，都是实测换来的。
 * 一旦有人「顺手简化」把关键约束删掉（尤其是 `--as user` 这个反直觉要求），
 * agent 就会照着错的手册做，且**不会有任何测试报错** —— 直到真机协作失败。
 *
 * 所以本文件把「必须存在的操作规则」钉成断言：
 *   - 建群拉人：`--as user` + `--users` + `--bots`（含自己）
 *   - @ 通信：结构化 at 参数（不是正文 @）
 *   - 命名规范：bot 名前缀 = 企微用户名
 *   - 触发条件、坑、清单
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** skill 仓库内的落盘路径（相对本测试文件：packages/cli/src/commands/shared/ → 仓库根） */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const SKILL_PATH = join(REPO_ROOT, "skills", "lark-collaboration", "SKILL.md");

function readSkill(): string {
  return readFileSync(SKILL_PATH, "utf-8");
}

describe("Task #5459 — lark-collaboration skill 文件", () => {
  test("SKILL.md 落在 skills/lark-collaboration/ 下（可被扫描器发现）", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  test("frontmatter 含 name + description（scanner 必须能解析）", () => {
    const md = readSkill();
    expect(md.startsWith("---\n")).toBe(true);
    const fm = md.slice(4, md.indexOf("\n---", 4));
    expect(fm).toMatch(/^name:\s*lark-collaboration$/m);
    expect(fm).toMatch(/^description:\s*\S+/m);
  });

  test("触发条件覆盖「协作」字眼 + 企微 @ 命中", () => {
    const md = readSkill();
    expect(md).toContain("协作");
    expect(md).toMatch(/触发条件/);
  });
});

describe("Task #5459 — skill 必须写清楚的三条硬规则", () => {
  test("规则 1：建群拉人 —— 必须有 --as user / --users / --bots", () => {
    const md = readSkill();
    expect(md).toContain("--as user");
    expect(md).toContain("--users");
    expect(md).toContain("--bots");
    // 关键反直觉点：bot 身份不能拉别的 bot（230003）
    expect(md).toContain("230003");
  });

  test("规则 1 补充：--bots 必须含「自己 + 对方」两个 app_id（否则 230002）", () => {
    const md = readSkill();
    expect(md).toContain("230002");
    expect(md).toContain("MY_APP_ID");
  });

  test("规则 2：@ 通信必须用结构化 at 参数，明确禁止正文 @", () => {
    const md = readSkill();
    // 结构化 at 节点的 JSON 形态
    expect(md).toContain('"tag":"at"');
    expect(md).toContain("user_id");
    // 明确写出「不是正文 @」
    expect(md).toMatch(/不是.{0,6}正文/);
  });

  test("规则 3：智能体名前缀 = 企微用户名（匹配依据）", () => {
    const md = readSkill();
    expect(md).toContain("前缀");
    expect(md).toContain("startsWith");
  });

  test("群名必须带企微群名/群Id 标记", () => {
    const md = readSkill();
    expect(md).toMatch(/群名/);
    expect(md).toMatch(/企微群/);
  });

  test("必须包含「回读成员验证」这一步（防静默少人）", () => {
    const md = readSkill();
    expect(md).toContain("+chat-members-list");
    expect(md).toMatch(/验证/);
  });
});

describe("Task #5459 — skill 记录的实测事实（回归护栏）", () => {
  test("记录了 self-echo 门禁坑（#5459）与查证方法", () => {
    const md = readSkill();
    expect(md).toContain("#5459");
    expect(md).toContain("group-bot-message");
    expect(md).toContain("self-echo event dropped");
  });

  test("记录了建群长度限制与数量上限（真实 API 约束）", () => {
    const md = readSkill();
    expect(md).toContain("60");
    expect(md).toContain("100");
    expect(md).toContain("50");
    expect(md).toContain("5");
  });

  test("记录了失效命令的 scope 门槛（避免 agent 照抄报错）", () => {
    const md = readSkill();
    expect(md).toContain("contact:user:search");
    expect(md).toContain("search:bot");
  });

  test("收尾清单存在且可勾选", () => {
    const md = readSkill();
    expect(md).toMatch(/- \[ \]/);
  });
});

describe("Task #5466 — include_bot 平台限制（实测沉淀）", () => {
  test("写出平台不推 bot→bot 消息 + 需要的 scope 名", () => {
    const md = readSkill();
    expect(md).toContain("include_bot");
    expect(md).toMatch(/不把「其他机器人发的消息」推给 bot|bot→bot 消息默认不推送/);
  });

  test("给出排查顺序：先看事件库 sender_type，别误判成门禁 bug", () => {
    const md = readSkill();
    expect(md).toContain("sender_type=bot/app");
    expect(md).toMatch(/误判|门禁 37\/37/);
  });
});

describe("Task #5459 — ping-pong 防护约定（CV 指出的自循环缺口）", () => {
  test("明确写出「禁止无条件回复对方 / 不得回给自己上一轮」", () => {
    const md = readSkill();
    expect(md).toContain("ping-pong");
    expect(md).toMatch(/无条件回/);
  });

  test("给出可执行的自查信号（连续 > 3 条 / 放行计数暴涨）", () => {
    const md = readSkill();
    expect(md).toContain("getSelfEchoAllowedGroupBotCount");
    expect(md).toMatch(/> 3 条|3 条/);
  });
});
