/**
 * @fileoverview Task #4620 — create-tool output 拼 hint（行为规范第 7 步）
 *
 * 契约：
 *   - 有 decision_hint → output **追加** hint（不改成功语义）
 *   - 无 decision_hint → output 与改动前**逐字一致**
 *   - hint 里的新任务 id 占位符 → 替换成真实 id
 *   - context 不是合法 JSON / 不是对象 → 不崩，output 与原来一致
 */

import { describe, test, expect } from "bun:test";
import { createTaskTool } from "./create-tool";
import {
  NEW_TASK_ID_PLACEHOLDER,
  NEW_TASK_ID_HASH_PLACEHOLDER,
} from "../hooks/verdict";
import type { TaskComponent } from "../task-component";

/** 只实现 createTask 的假 TaskComponent */
function fakeComponent(createdTask: any): TaskComponent {
  return {
    createTask: async () => createdTask,
    getTask: async () => undefined,
  } as unknown as TaskComponent;
}

async function runCreate(contextJson: string, taskId = 4242, title = "新任务") {
  const created = {
    id: taskId,
    title,
    status: "todo",
    type: "normal",
    context: contextJson,
  };
  const tool = createTaskTool(fakeComponent(created));
  const result = await tool.execute(
    {
      title,
      description: "desc",
      context: contextJson,
      project_path: "/tmp/x",
    } as any,
    { session_id: "sess_decision_hint_001" } as any,
  );
  return result as { success: boolean; output: string };
}

describe("create-tool output — decision hint append", () => {
  test("no decision_hint → output is EXACTLY the original single line", async () => {
    const res = await runCreate(JSON.stringify({ similar_task_ids: [1, 2] }));
    expect(res.success).toBe(true);
    expect(res.output).toBe("Task created successfully: #4242 - 新任务");
    expect(res.output).not.toContain("TASK_CREATE_HINT");
  });

  test("context without decision_hint → output unchanged, no crash", async () => {
    // ⚠️ context 是 schema 必填项（z.string()），所以「无 context」不是合法调用 ——
    // 这里测的是**合法但不含 hint** 的最小 context。
    const res = await runCreate(JSON.stringify({ type: "general" }));
    expect(res.success).toBe(true);
    expect(res.output).toBe("Task created successfully: #4242 - 新任务");
  });

  test("malformed context JSON → output unchanged, no crash", async () => {
    const res = await runCreate("{not json");
    expect(res.success).toBe(true);
    expect(res.output).toBe("Task created successfully: #4242 - 新任务");
  });

  test("context is a JSON array → output unchanged, no crash", async () => {
    const res = await runCreate("[1,2,3]");
    expect(res.success).toBe(true);
    expect(res.output).toBe("Task created successfully: #4242 - 新任务");
  });

  test("decision_hint present → output APPENDS the hint (success semantics unchanged)", async () => {
    const hint = "[TASK_CREATE_HINT] 建议复用 #22。\n  task_update(task_id=22, description=<...>)";
    const res = await runCreate(JSON.stringify({ decision_hint: hint }));

    expect(res.success).toBe(true);
    expect(res.output.startsWith("Task created successfully: #4242 - 新任务")).toBe(true);
    expect(res.output).toContain("[TASK_CREATE_HINT]");
    expect(res.output).toContain("task_update(task_id=22");
  });

  test("empty decision_hint string → output unchanged", async () => {
    const res = await runCreate(JSON.stringify({ decision_hint: "" }));
    expect(res.output).toBe("Task created successfully: #4242 - 新任务");
  });

  test("non-string decision_hint → output unchanged", async () => {
    const res = await runCreate(JSON.stringify({ decision_hint: 12345 }));
    expect(res.output).toBe("Task created successfully: #4242 - 新任务");
  });

  test("NEW_TASK_ID placeholders are replaced with the real task id", async () => {
    const hint = `已创建新任务 ${NEW_TASK_ID_HASH_PLACEHOLDER} / ${NEW_TASK_ID_PLACEHOLDER}`;
    const res = await runCreate(JSON.stringify({ decision_hint: hint }), 4242);

    expect(res.output).toContain("#4242");
    expect(res.output).toContain("4242");
    expect(res.output).not.toContain(NEW_TASK_ID_HASH_PLACEHOLDER);
    expect(res.output).not.toContain(NEW_TASK_ID_PLACEHOLDER);
  });

  test("all occurrences of the placeholder are replaced", async () => {
    const hint = `${NEW_TASK_ID_PLACEHOLDER} ${NEW_TASK_ID_PLACEHOLDER} ${NEW_TASK_ID_HASH_PLACEHOLDER}`;
    const res = await runCreate(JSON.stringify({ decision_hint: hint }), 777);

    expect(res.output).toContain("777 777 #777");
    expect(res.output).not.toContain("__NEW_TASK_ID__");
  });
});
