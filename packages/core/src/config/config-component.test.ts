/**
 * ConfigComponent 单元测试 (bun test)
 */
import { z } from "zod";
import {
  MemorySource,
  ConfigSource,
  ConfigComponent,
  AsyncPersistQueue,
  type ConfigChangeEvent,
} from "./config-component";
import type { ComponentSchema } from "../env/component";

// Helper: create a mock function that tracks calls
function createMockFn<T = unknown>() {
  const calls: T[] = [];
  const fn = ((...args: T[]) => {
    calls.push(...args);
  }) as ((...args: T[]) => void) & { calls: T[]; mockImplementation: (fn: (...args: T[]) => void) => typeof fn };
  
  fn.calls = calls;
  fn.mockImplementation = (newFn: (...args: T[]) => void) => {
    const impl = (...args: T[]) => {
      calls.push(...args);
      newFn(...args);
    };
    return impl as typeof fn;
  };
  
  return fn;
}

// Helper: check if object contains expected properties
function expectObjectContaining(obj: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in obj) || !deepEqual(obj[key], value)) {
      return false;
    }
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

describe("MemorySource", () => {
  let source: MemorySource;

  beforeEach(() => {
    source = new MemorySource();
  });

  describe("read", () => {
    it("returns undefined for non-existent key", () => {
      expect(source.read("nonExistent")).toBeUndefined();
    });

    it("returns written value", () => {
      source.write("key1", "value1");
      expect(source.read("key1")).toBe("value1");
    });

    it("returns correct value types", () => {
      source.write("string", "test");
      source.write("number", 42);
      source.write("boolean", true);
      source.write("object", { nested: true });
      source.write("array", [1, 2, 3]);

      expect(source.read("string")).toBe("test");
      expect(source.read("number")).toBe(42);
      expect(source.read("boolean")).toBe(true);
      expect(source.read("object")).toEqual({ nested: true });
      expect(source.read("array")).toEqual([1, 2, 3]);
    });
  });

  describe("write", () => {
    it("stores value and returns true", () => {
      expect(source.write("key", "value")).toBe(true);
      expect(source.read("key")).toBe("value");
    });

    it("overwrites existing value", () => {
      source.write("key", "old");
      source.write("key", "new");
      expect(source.read("key")).toBe("new");
    });
  });

  describe("delete", () => {
    it("removes entry and returns true", () => {
      source.write("key", "value");
      expect(source.delete("key")).toBe(true);
      expect(source.read("key")).toBeUndefined();
    });

    it("returns false for non-existent key", () => {
      expect(source.delete("nonExistent")).toBe(false);
    });
  });

  describe("list", () => {
    it("returns all entries", () => {
      source.write("key1", "value1");
      source.write("key2", "value2");

      const entries = source.list();
      expect(entries).toHaveLength(2);
      expect(entries.some(e => e.key === "key1" && e.value === "value1")).toBe(true);
      expect(entries.some(e => e.key === "key2" && e.value === "value2")).toBe(true);
    });

    it("returns empty array for empty store", () => {
      expect(source.list()).toEqual([]);
    });
  });

  describe("watch", () => {
    it("triggers callback on add", () => {
      const events: ConfigChangeEvent[] = [];
      const unwatch = source.watch((event) => events.push(event));

      source.write("key", "value");

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("add");
      expect(events[0].key).toBe("key");
      expect(events[0].oldValue).toBeUndefined();
      expect(events[0].newValue).toBe("value");
      expect(events[0].source).toBe("memory");

      unwatch();
    });

    it("triggers callback on change", () => {
      const events: ConfigChangeEvent[] = [];
      source.write("key", "oldValue");
      const unwatch = source.watch((event) => events.push(event));

      source.write("key", "newValue");

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("change");
      expect(events[0].key).toBe("key");
      expect(events[0].oldValue).toBe("oldValue");
      expect(events[0].newValue).toBe("newValue");

      unwatch();
    });

    it("triggers callback on delete", () => {
      const events: ConfigChangeEvent[] = [];
      source.write("key", "value");
      const unwatch = source.watch((event) => events.push(event));

      source.delete("key");

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("delete");
      expect(events[0].key).toBe("key");
      expect(events[0].oldValue).toBe("value");
      expect(events[0].newValue).toBeUndefined();

      unwatch();
    });

    it("returns unsubscribe function", () => {
      const events: ConfigChangeEvent[] = [];
      const unwatch = source.watch((event) => events.push(event));

      unwatch();
      source.write("key", "value");

      expect(events.length).toBe(0);
    });

    it("handles multiple watchers", () => {
      const events1: ConfigChangeEvent[] = [];
      const events2: ConfigChangeEvent[] = [];
      source.watch((event) => events1.push(event));
      source.watch((event) => events2.push(event));

      source.write("key", "value");

      expect(events1.length).toBe(1);
      expect(events2.length).toBe(1);
    });
  });
});

describe("AsyncPersistQueue", () => {
  let persistCalls: unknown[][];
  let mockPersistFn: (entries: unknown[]) => Promise<void>;
  let queue: AsyncPersistQueue;

  // Helper to wait for debounce to complete
  const waitForDebounce = (ms: number) => new Promise(resolve => setTimeout(resolve, ms + 10));

  const createQueue = (debounceMs: number = 30) => {
    persistCalls = [];
    mockPersistFn = async (entries: unknown[]) => {
      persistCalls.push(entries);
    };
    queue = new AsyncPersistQueue({
      debounceMs,
      persistFn: mockPersistFn,
    });
    return queue;
  };

  // Cleanup between tests
  afterEach(async () => {
    if (queue) {
      queue.clear();
    }
    await waitForDebounce(100); // Wait for any pending timers
  });

  describe("add", () => {
    it("schedules flush after add", async () => {
      const q = createQueue(50);

      q.add("key1", "value1");

      // Should not flush immediately
      expect(persistCalls.length).toBe(0);
      expect(q.size()).toBe(1);
    });

    it("batches multiple adds within debounce window", async () => {
      const q = createQueue(30);

      q.add("key1", "value1");
      q.add("key2", "value2");
      q.add("key3", "value3");

      expect(q.size()).toBe(3);
      expect(persistCalls.length).toBe(0);

      // Wait for debounce to elapse
      await waitForDebounce(30);

      expect(persistCalls.length).toBe(1);
    });
  });

  describe("flush", () => {
    it("calls persistFn with all entries", async () => {
      const q = createQueue(30);

      q.add("key1", "value1");
      q.add("key2", "value2");

      await waitForDebounce(30);

      expect(persistCalls.length).toBe(1);
      const entries = persistCalls[0];
      expect(entries.some((e: any) => e.key === "key1" && e.value === "value1")).toBe(true);
      expect(entries.some((e: any) => e.key === "key2" && e.value === "value2")).toBe(true);
    });

    it("clears queue after flush", async () => {
      const q = createQueue(30);

      q.add("key1", "value1");

      await waitForDebounce(30);

      expect(q.size()).toBe(0);
    });

    it("handles empty queue gracefully", async () => {
      const q = createQueue(50);

      await q.flush();

      expect(persistCalls.length).toBe(0);
    });

    it("handles persistFn errors gracefully", async () => {
      let errorThrown = false;
      const errorQueue = new AsyncPersistQueue({
        debounceMs: 30,
        persistFn: async () => {
          throw new Error("Persist failed");
        },
      });

      // Capture console.error
      const originalError = console.error;
      let capturedArgs: any[] = [];
      console.error = (...args: any[]) => { 
        capturedArgs = args;
        errorThrown = true; 
      };

      errorQueue.add("key", "value");

      await waitForDebounce(30);

      expect(errorThrown).toBe(true);
      // console.error 被调用，第一个参数是 "Failed to persist config:"
      expect(capturedArgs.length).toBeGreaterThan(0);
      expect(capturedArgs[0]).toContain("Failed to persist config");

      console.error = originalError;
      errorQueue.clear();
    });
  });

  describe("pause/resume", () => {
    it("pause prevents new flush when called before add", async () => {
      const q = createQueue(30);

      q.pause();  // Pause before adding
      q.add("key", "value");

      await waitForDebounce(50);

      expect(q.size()).toBe(1);
      expect(persistCalls.length).toBe(0);
    });

    it("resume schedules flush when queue has items", async () => {
      const q = createQueue(30);

      q.pause();
      q.add("key", "value");
      q.resume();

      expect(q.size()).toBe(1);
      await waitForDebounce(30);

      expect(persistCalls.length).toBe(1);
    });
  });

  describe("clear", () => {
    it("clears queue and timer", () => {
      const q = createQueue(50);

      q.add("key1", "value1");
      q.add("key2", "value2");

      expect(q.size()).toBe(2);

      q.clear();

      expect(q.size()).toBe(0);
    });
  });
});

describe("ConfigComponent", () => {
  let config: ConfigComponent;

  const createTestSchema = (name: string, defaults: Record<string, unknown>): ComponentSchema => ({
    name,
    schema: z.object({}),
    defaults,
  });

  beforeEach(() => {
    config = new ConfigComponent({ debounceMs: 50 });
  });

  afterEach(() => {
    // Clean up timers
    config["persistQueue"].clear();
  });

  describe("name and version", () => {
    it("has correct name", () => {
      expect(config.name).toBe("config");
    });

    it("has correct version", () => {
      expect(config.version).toBe("1.0.0");
    });
  });

  describe("Component registration", () => {
    it("register adds schema", () => {
      const schema = createTestSchema("test", { key: "value" });
      config.register(schema);

      expect(config.isRegistered("test")).toBe(true);
    });

    it("register initializes defaults", () => {
      const schema = createTestSchema("test", { key: "defaultValue" });
      config.register(schema);

      expect(config.get("test.key")).toBe("defaultValue");
    });

    it("register does not overwrite existing values", () => {
      const schema = createTestSchema("test", { key: "defaultValue" });
      config.register(schema);
      config.set("test.key", "customValue");

      config.register(schema);
      expect(config.get("test.key")).toBe("customValue");
    });

    it("unregister removes schema", () => {
      const schema = createTestSchema("test", { key: "value" });
      config.register(schema);
      config.unregister("test");

      expect(config.isRegistered("test")).toBe(false);
    });

    it("listComponents returns all registered", () => {
      config.register(createTestSchema("comp1", {}));
      config.register(createTestSchema("comp2", {}));

      const components = config.listComponents();
      expect(components).toContain("comp1");
      expect(components).toContain("comp2");
    });
  });

  describe("get/set", () => {
    beforeEach(() => {
      config.register(createTestSchema("test", {}));
    });

    it("get returns nested value with dot notation", async () => {
      await config.set("test.nested", { deep: { value: 42 } });

      const result = config.get("test.nested");
      expect(result).toEqual({ deep: { value: 42 } });
    });

    it("get returns nested object property", async () => {
      await config.set("test.nested", { deep: { value: 42 } });

      const result = config.get("test.nested.deep.value");
      expect(result).toBe(42);
    });

    it("get returns undefined for non-existent key", () => {
      expect(config.get("nonExistent")).toBeUndefined();
    });

    it("set updates value", async () => {
      await config.set("test.key", "newValue");
      expect(config.get("test.key")).toBe("newValue");
    });

    it("setMany sets multiple values", async () => {
      await config.setMany({
        "test.key1": "value1",
        "test.key2": "value2",
      });

      expect(config.get("test.key1")).toBe("value1");
      expect(config.get("test.key2")).toBe("value2");
    });

    it("getMany returns multiple values", async () => {
      await config.set("test.key1", "value1");
      await config.set("test.key2", "value2");

      const result = config.getMany(["test.key1", "test.key2", "nonExistent"]);

      expect(result).toEqual({
        "test.key1": "value1",
        "test.key2": "value2",
        nonExistent: undefined,
      });
    });
  });

  describe("reset", () => {
    it("resets to default value", async () => {
      const schema = createTestSchema("test", { key: "default" });
      config.register(schema);

      await config.set("test.key", "custom");
      expect(config.get("test.key")).toBe("custom");

      await config.reset("test.key");
      expect(config.get("test.key")).toBe("default");
    });

    it("does nothing for unregistered component", async () => {
      await config.reset("nonExistent.key");
      // Should not throw
    });
  });

  describe("watch", () => {
    it("triggers on change", async () => {
      const events: any[] = [];
      config.watch("test.key", (event) => events.push(event));

      await config.set("test.key", "value");

      expect(events.length).toBe(1);
      expect(events[0].component).toBe("test");
      expect(events[0].key).toBe("test.key");
      expect(events[0].oldValue).toBeUndefined();
      expect(events[0].newValue).toBe("value");
      expect(events[0].persisted).toBe(false);
    });

    it("pattern matching with wildcard", async () => {
      const events: any[] = [];
      config.watch("test.*", (event) => events.push(event));

      await config.set("test.key1", "value1");
      await config.set("test.key2", "value2");

      expect(events.length).toBe(2);
    });

    it("pattern matching with global wildcard", async () => {
      const events: any[] = [];
      config.watch("*", (event) => events.push(event));

      await config.set("test.key", "value");

      expect(events.length).toBe(1);
    });

    it("returns unsubscribe function", async () => {
      const events: any[] = [];
      const unwatch = config.watch("test.key", (event) => events.push(event));

      unwatch();
      await config.set("test.key", "value");

      expect(events.length).toBe(0);
    });

    it("handles nested key changes", async () => {
      const events: any[] = [];
      config.watch("test.*", (event) => events.push(event));

      await config.set("test.nested.deep", "value");

      expect(events.length).toBe(1);
    });
  });

  describe("getPath", () => {
    it("throws for unregistered component", () => {
      expect(() => config.getPath("nonExistent")).toThrow(
        "Component not registered: nonExistent"
      );
    });
  });

  describe("config sources", () => {
    it("addSource adds to sources list", () => {
      const customSource: ConfigSource = {
        name: "custom",
        priority: 1,
        read: () => undefined,
        list: () => [],
      };

      config.addSource(customSource);

      const sources = config.getSources();
      expect(sources.length).toBe(2); // memory + custom
    });

    it("removeSource removes non-memory source", () => {
      const customSource: ConfigSource = {
        name: "custom",
        priority: 1,
        read: () => undefined,
        list: () => [],
      };

      config.addSource(customSource);
      const result = config.removeSource("custom");

      expect(result).toBe(true);
      expect(config.getSources().length).toBe(1);
    });

    it("cannot remove memory source", () => {
      const result = config.removeSource("memory");
      expect(result).toBe(false);
    });

    it("getSources returns copy of sources", () => {
      const sources = config.getSources();
      sources.push({} as ConfigSource);

      expect(config.getSources().length).toBe(1);
    });
  });

  describe("save", () => {
    it("flushes persist queue", async () => {
      // Add something to the queue first
      config.register(createTestSchema("test", {}));
      await config.set("test.key", "value");

      // Wait for any pending flush
      await new Promise(resolve => setTimeout(resolve, 60));

      await config.save();
      // If we get here without error, the test passes
    });
  });
});
