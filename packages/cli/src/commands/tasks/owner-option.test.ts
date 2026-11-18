/**
 * Task #5440 — CLI `--owner` 契约测试。
 *
 * 用户要求：「CLI `tasks create/update` 加 `--owner`」。
 *
 * 这些测试锁定三件事：
 *   1. `tasks create` 注册了 `--owner`，且描述说明了 owner 语义（负责人/可空/多协作）
 *   2. `tasks update` 注册了 `--owner`，且描述说明了「不传 = 不改动，传空 = 清空」
 *   3. create/update 的 handler 真的把 owner 透传给 TaskComponent（不是只加了个 flag）
 *
 * 做法与 create.test.ts 一致：给 builder 一个记录型 stub 读选项定义；
 * handler 用 mock 的 EnvironmentService + 假 TaskComponent 断言入参。
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// === 记录 handler 实际收到的 createTask / updateTask 入参 ===
const captured: { create: any[]; update: any[] } = { create: [], update: [] };

class FakeTaskComponent {
  async createTask(options: any) {
    captured.create.push(options);
    return { id: 1, title: options.title, owner: options.owner ?? null };
  }
  async updateTask(id: number, options: any) {
    captured.update.push({ id, options });
    return { id, title: "t", owner: options.owner ?? null };
  }
  async createOperation() {
    return { id: 1 };
  }
}

class FakeSessionComponent {
  getActiveSessionId() {
    return "sess_test";
  }
}

mock.module("../../services/environment.service", () => ({
  EnvironmentService: class {
    async create(_opts: any) {}
    getEnvironment() {
      return {
        getComponent: (name: string) =>
          name === "task" ? new FakeTaskComponent() : new FakeSessionComponent(),
      };
    }
    async dispose() {}
  },
}));

const { CreateCommand } = await import("./create");
const { UpdateCommand } = await import("./update");

/** 用记录型 stub 收集 builder 注册的选项。 */
function collectOptions(command: { builder?: unknown }): Record<string, any> {
  const recorded: Record<string, any> = {};
  const chainable = {
    positional: () => chainable,
    option: (name: string, opts: any) => {
      recorded[name] = opts;
      return chainable;
    },
    options: (spec: Record<string, any>) => {
      Object.assign(recorded, spec);
      return chainable;
    },
  };
  (command.builder as any)(chainable);
  return recorded;
}

beforeEach(() => {
  captured.create.length = 0;
  captured.update.length = 0;
});

describe("tasks create — --owner", () => {
  it("注册了 --owner 选项", () => {
    const options = collectOptions(CreateCommand);
    expect(options.owner).toBeDefined();
    expect(options.owner.type).toBe("string");
  });

  it("描述说明了 owner 语义（负责人 / 可空 / 协作）", () => {
    const desc = String(collectOptions(CreateCommand).owner?.description ?? "");
    expect(desc).toMatch(/负责人/);
    expect(desc).toMatch(/可空|未指派/);
    expect(desc).toMatch(/协作/);
  });

  it("handler 把 --owner 透传给 createTask", async () => {
    await (CreateCommand.handler as any)({
      title: "T",
      owner: "ou_abc",
      _: [],
      $0: "roy-bot",
    });
    expect(captured.create.length).toBe(1);
    expect(captured.create[0].owner).toBe("ou_abc");
  });

  it("不传 --owner 时 createTask 入参不含 owner（向后兼容，走默认 null）", async () => {
    await (CreateCommand.handler as any)({ title: "T", _: [], $0: "roy-bot" });
    expect(captured.create.length).toBe(1);
    expect(captured.create[0]).not.toHaveProperty("owner");
  });
});

describe("tasks update — --owner", () => {
  it("注册了 --owner 选项", () => {
    const options = collectOptions(UpdateCommand);
    expect(options.owner).toBeDefined();
    expect(options.owner.type).toBe("string");
  });

  it("描述说明了「不传 = 不改动 / 传空 = 清空」", () => {
    const desc = String(collectOptions(UpdateCommand).owner?.description ?? "");
    expect(desc).toMatch(/负责人/);
    expect(desc).toMatch(/不传|不改/);
    expect(desc).toMatch(/清空/);
  });

  it("handler 把 --owner 透传给 updateTask", async () => {
    await (UpdateCommand.handler as any)({
      id: 7,
      owner: "ou_new",
      _: [],
      $0: "roy-bot",
    });
    expect(captured.update.length).toBe(1);
    expect(captured.update[0].id).toBe(7);
    expect(captured.update[0].options.owner).toBe("ou_new");
  });

  it("显式 --owner \"\" 会被透传（清空语义，不能被 falsy 判断吞掉）", async () => {
    await (UpdateCommand.handler as any)({ id: 7, owner: "", _: [], $0: "roy-bot" });
    expect(captured.update[0].options).toHaveProperty("owner");
    expect(captured.update[0].options.owner).toBe("");
  });

  it("不传 --owner 时 updateTask 入参不含 owner（不改动语义）", async () => {
    await (UpdateCommand.handler as any)({ id: 7, _: [], $0: "roy-bot" });
    expect(captured.update[0].options).not.toHaveProperty("owner");
  });
});
