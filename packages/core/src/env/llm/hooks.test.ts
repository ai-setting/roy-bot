import { describe, test, expect, beforeEach, afterEach } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
import { LLMHooks, type LLMBeforeInvokeHook, type LLMAfterInvokeHook, type LLMStreamHook, type LLMHookContext } from "./hooks";
import { globalHookManager } from "../hook/global-hook-manager";
import type { LLMInvokeRequest, LLMInvokeResult, LLMOutput, StreamEvent } from "./types";

describe("LLMHooks", () => {
  let hooks: LLMHooks;

  beforeEach(() => {
    hooks = new LLMHooks();
    // 清理 globalHookManager 中的 hooks
    globalHookManager.clear();
  });

  afterEach(() => {
    // 清理 globalHookManager 中的 hooks
    globalHookManager.clear();
  });

  describe("constructor", () => {
    test("should create instance with empty hooks", () => {
      expect(hooks.getHooks()).toEqual([]);
    });
  });

  describe("register", () => {
    test("should register before invoke hook", () => {
      const hook: LLMBeforeInvokeHook = async (context) => {
        // 可以在此处修改 context.request
      };

      hooks.register("before-invoke", hook);
      expect(hooks.getHooks()).toHaveLength(1);
      expect(hooks.getHooks()[0].type).toBe("before-invoke");
    });

    test("should register after invoke hook", () => {
      const hook: LLMAfterInvokeHook = async (context) => {
        // 可以在此处处理结果
      };

      hooks.register("after-invoke", hook);
      expect(hooks.getHooks()).toHaveLength(1);
    });

    test("should register stream hook", () => {
      const hook: LLMStreamHook = async (context, event) => {
        // 可以在此处处理流事件
      };

      hooks.register("stream", hook);
      expect(hooks.getHooks()).toHaveLength(1);
    });

    test("should register multiple hooks", () => {
      hooks.register("before-invoke", async () => {});
      hooks.register("after-invoke", async () => {});
      hooks.register("stream", async () => {});

      expect(hooks.getHooks()).toHaveLength(3);
    });

    test("should register named hooks", () => {
      hooks.register("before-invoke", async () => {}, "custom-before-hook");
      hooks.register("after-invoke", async () => {}, "custom-after-hook");

      const allHooks = hooks.getHooks();
      expect(allHooks[0].name).toBe("custom-before-hook");
      expect(allHooks[1].name).toBe("custom-after-hook");
    });
  });

  describe("unregister", () => {
    test("should unregister hook by reference", () => {
      const hook = async () => {};
      hooks.register("before-invoke", hook);
      hooks.register("before-invoke", async () => {});

      expect(hooks.getHooks()).toHaveLength(2);

      hooks.unregister(hook);
      expect(hooks.getHooks()).toHaveLength(1);
    });

    test("should unregister hook by name", () => {
      hooks.register("before-invoke", async () => {}, "hook1");
      hooks.register("before-invoke", async () => {}, "hook2");

      expect(hooks.getHooks()).toHaveLength(2);

      hooks.unregisterByName("hook1");
      expect(hooks.getHooks()).toHaveLength(1);
      expect(hooks.getHooks()[0].name).toBe("hook2");
    });

    test("should unregister all hooks of a type", () => {
      hooks.register("before-invoke", async () => {});
      hooks.register("after-invoke", async () => {});
      hooks.register("stream", async () => {});

      hooks.unregisterByType("before-invoke");
      expect(hooks.getHooks()).toHaveLength(2);
    });
  });

  describe("clear", () => {
    test("should clear all hooks", () => {
      hooks.register("before-invoke", async () => {});
      hooks.register("after-invoke", async () => {});

      hooks.clear();
      expect(hooks.getHooks()).toEqual([]);
    });
  });

  describe.skipIf(isParallelRun)("executeBeforeInvoke", () => {
    test("should execute before-invoke hooks in order", async () => {
      const executionOrder: string[] = [];

      hooks.register("before-invoke", async () => {
        executionOrder.push("hook1");
      });
      hooks.register("before-invoke", async () => {
        executionOrder.push("hook2");
      });

      const context: LLMHookContext = {
        request: { messages: [] },
        providerId: "openai",
        model: "gpt-4",
      };

      // 使用新的直接调用 globalHookManager 的方式
      await globalHookManager.execute("llm:before.invoke", context);

      expect(executionOrder).toEqual(["hook1", "hook2"]);
    });

    test("should allow hooks to modify context", async () => {
      hooks.register("before-invoke", async (ctx) => {
        ctx.request.messages = [
          { role: "system", content: "You are helpful" },
          ...ctx.request.messages,
        ];
      });

      const context: LLMHookContext = {
        request: { messages: [{ role: "user", content: "Hello" }] },
        providerId: "openai",
        model: "gpt-4",
      };

      await globalHookManager.execute("llm:before.invoke", context);

      expect(context.request.messages).toHaveLength(2);
      expect(context.request.messages[0].role).toBe("system");
    });

    test("should isolate errors and continue executing remaining hooks", async () => {
      const executionOrder: string[] = [];

      hooks.register("before-invoke", async () => {
        executionOrder.push("hook1");
      });
      hooks.register("before-invoke", async () => {
        throw new Error("Hook error");
      });
      hooks.register("before-invoke", async () => {
        executionOrder.push("hook3");
      });

      const context: LLMHookContext = {
        request: { messages: [] },
        providerId: "openai",
        model: "gpt-4",
      };

      // HookManager 会捕获错误并继续执行（错误隔离）
      await globalHookManager.execute("llm:before.invoke", context);
      // 错误被隔离，后续 hooks 继续执行
      expect(executionOrder).toEqual(["hook1", "hook3"]);
    });
  });

  describe.skipIf(isParallelRun)("executeAfterInvoke", () => {
    test("should execute after-invoke hooks in order", async () => {
      const executionOrder: string[] = [];

      hooks.register("after-invoke", async (ctx) => {
        executionOrder.push("hook1");
      });
      hooks.register("after-invoke", async (ctx) => {
        executionOrder.push("hook2");
      });

      const context: LLMHookContext = {
        request: { messages: [] },
        providerId: "openai",
        model: "gpt-4",
      };

      const result: LLMInvokeResult = {
        output: { content: "test", finishReason: "stop" },
        providerId: "openai",
        model: "gpt-4",
        latencyMs: 100,
      };

      await globalHookManager.execute("llm:after.invoke", { ...context, result });

      expect(executionOrder).toEqual(["hook1", "hook2"]);
    });

    test("should allow hooks to modify result", async () => {
      hooks.register("after-invoke", async (ctx, result) => {
        result.output.content = result.output.content + " [modified]";
      });

      const context: LLMHookContext = {
        request: { messages: [] },
        providerId: "openai",
        model: "gpt-4",
      };

      const result: LLMInvokeResult = {
        output: { content: "original", finishReason: "stop" },
        providerId: "openai",
        model: "gpt-4",
        latencyMs: 100,
      };

      await globalHookManager.execute("llm:after.invoke", { ...context, result });

      expect(result.output.content).toBe("original [modified]");
    });
  });

  describe.skipIf(isParallelRun)("executeStream", () => {
    test("should execute stream hooks", async () => {
      const events: StreamEvent[] = [];

      hooks.register("stream", async (ctx, event) => {
        events.push(event);
      });

      const context: LLMHookContext = {
        request: { messages: [] },
        providerId: "openai",
        model: "gpt-4",
      };

      const event: StreamEvent = { type: "text", content: "Hello" };
      await hooks.executeStream(context, event);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    test("should allow hooks to modify stream event", async () => {
      hooks.register("stream", async (ctx, event) => {
        if (event.type === "text") {
          event.content = event.content.toUpperCase();
        }
      });

      const context: LLMHookContext = {
        request: { messages: [] },
        providerId: "openai",
        model: "gpt-4",
      };

      const event: StreamEvent = { type: "text", content: "hello" };
      await hooks.executeStream(context, event);

      expect(event.content).toBe("HELLO");
    });
  });

  describe("getHooksByType", () => {
    test("should return hooks of specific type", () => {
      hooks.register("before-invoke", async () => {});
      hooks.register("after-invoke", async () => {});
      hooks.register("before-invoke", async () => {});
      hooks.register("stream", async () => {});

      const beforeHooks = hooks.getHooksByType("before-invoke");
      expect(beforeHooks).toHaveLength(2);

      const afterHooks = hooks.getHooksByType("after-invoke");
      expect(afterHooks).toHaveLength(1);
    });
  });
});
