/**
 * @fileoverview Tasks Organize Command
 * 
 * 命令：roy-bot tasks organize
 * 整理系统中的任务：清理测试任务、聚合相似任务、构建任务树
 */

import type { ArgumentsCamelCase, CommandBuilder } from "yargs";

interface OrganizeArgs {
  dryRun?: boolean;
  deleteTest?: boolean;
  aggregate?: boolean;
  buildTree?: boolean;
  auto?: boolean;
  config?: string;
}

export const command = "organize";
export const desc = "整理系统中的任务（清理测试任务、聚合相似任务、构建任务树）";

export const builder: CommandBuilder = (yargs) =>
  yargs
    .option("dry-run", {
      type: "boolean",
      desc: "试运行模式，只展示计划不执行",
      default: false,
    })
    .option("delete-test", {
      type: "boolean",
      desc: "使用 AI 分析判断哪些是纯测试/示例任务并清理（避免误删正式任务）",
    })
    .option("aggregate", {
      type: "boolean",
      desc: "聚合相似任务（基于标题文本相似度）",
    })
    .option("build-tree", {
      type: "boolean",
      desc: "构建任务树（为散落的同类任务构建父任务）",
    })
    .option("auto", {
      type: "boolean",
      desc: "全自动模式，执行所有整理策略",
    })
    .example([
      ["$0 tasks organize --dry-run", "试运行，只展示整理计划"],
      ["$0 tasks organize --auto", "全自动整理"],
      ["$0 tasks organize --delete-test", "用 AI 清理测试任务"],
    ]) as any;

// ============================================================================
// 整理策略
// ============================================================================

interface TaskItem {
  id: number;
  title: string;
  type: string;
  tags?: string[];
  parent_task_id?: number;
  status: string;
}

/**
 * 用 AI agent 判断哪些是测试任务（避免关键词匹配误删）
 * 通过子进程调用 roy-bot act --agent task-organizer
 */
async function handleDeleteTest(
  store: any,
  allTasks: TaskItem[],
  shouldExecute: boolean,
  report: string[]
): Promise<void> {
  // 智能关键词匹配 + 排除规则，避免误删正式任务
  // 第一类：明确是测试/示例的任务
  const testPatterns = [
    /^test\b/i, /^测试/i, /^示例/i, /^demo\b/i, /^sample\b/i,
    /event test/i, /test task/i,
  ];
  // 排除模式：这些虽然含关键词但是正式工作
  const excludePatterns = [
    /strict-task-agent/i, /集成测试/i, /bench测试/i, /测试用例/i,
    /typecheck/i, /traffic_test/i,
  ];

  // 严格匹配：标题以 test/测试 开头，或者是简单的测试任务
  const matched = allTasks.filter(t => {
    const title = t.title;
    // 先检查排除模式
    for (const pat of excludePatterns) {
      if (pat.test(title)) return false;
    }
    // 再检查匹配模式
    for (const pat of testPatterns) {
      if (pat.test(title)) return true;
    }
    return false;
  });

  if (matched.length === 0) {
    report.push("没有发现需要清理的测试任务");
    return;
  }

  report.push("发现 " + matched.length + " 个测试任务:");
  for (const task of matched) {
    report.push("   - #" + task.id + ": " + task.title + " (" + task.status + ")");
  }

  report.push("");
  report.push("  ℹ\ufe0f 提示：如需更智能的语义分析，请运行:");
  report.push('     roy-bot act "\u6574\u7406\u6d4b\u8bd5\u4efb\u52a1" --agent task-organizer');

  if (shouldExecute) {
    let count = 0;
    for (const task of matched) {
      try {
        await store.deleteTask(task.id);
        report.push("  \u2705 已删除: #" + task.id + " - " + task.title);
        count++;
      } catch (err: any) {
        report.push("  \u274c 删除失败: #" + task.id + " - " + err.message);
      }
    }
    report.push("  共删除 " + count + " 个测试任务");
  }
}async function handleAggregate(
  store: any,
  allTasks: TaskItem[],
  shouldExecute: boolean,
  report: string[]
): Promise<void> {
  // Jaccard similarity
  function sim(a: string, b: string): number {
    const s1 = new Set(a.toLowerCase().split(/[\s_-]+/));
    const s2 = new Set(b.toLowerCase().split(/[\s_-]+/));
    const inter = new Set([...s1].filter(w => s2.has(w)));
    const union = new Set([...s1, ...s2]);
    return inter.size / union.size;
  }

  const visited = new Set<number>();
  const groups: TaskItem[][] = [];
  const THRESHOLD = 0.7;

  for (let i = 0; i < allTasks.length; i++) {
    if (visited.has(allTasks[i].id)) continue;
    const group: TaskItem[] = [allTasks[i]];
    visited.add(allTasks[i].id);
    for (let j = i + 1; j < allTasks.length; j++) {
      if (visited.has(allTasks[j].id)) continue;
      if (sim(allTasks[i].title, allTasks[j].title) >= THRESHOLD) {
        group.push(allTasks[j]);
        visited.add(allTasks[j].id);
      }
    }
    if (group.length > 1) groups.push(group);
  }

  if (groups.length === 0) {
    report.push("未发现相似任务");
    return;
  }

  report.push("发现 " + groups.length + " 组相似任务:");
  for (const g of groups) {
    report.push("  组:");
    for (const t of g) report.push("    - #" + t.id + ": " + t.title);
    if (shouldExecute) {
      const tagName = "group:" + g[0].title.slice(0, 20).replace(/[\s_-]+/g, "-").toLowerCase();
      for (const t of g) {
        const currentTags = t.tags || [];
        if (!currentTags.includes(tagName)) {
          await store.updateTask(t.id, { tags: [...currentTags, tagName] });
        }
      }
      report.push("    -> 添加关联标签: " + tagName);
    }
  }
}

/**
 * 构建任务树
 */
async function handleBuildTree(
  store: any,
  allTasks: TaskItem[],
  shouldExecute: boolean,
  report: string[]
): Promise<void> {
  const rootTasks = allTasks.filter(t => !t.parent_task_id);
  if (rootTasks.length === 0) {
    report.push("所有任务已有父任务");
    return;
  }

  // Group by topic words
  const stopWords = new Set(["test", "测试", "task", "任务", "add", "create", "fix"]);
  const groups = new Map<string, TaskItem[]>();

  for (const task of rootTasks) {
    const words = task.title
      .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, " ").split(/\s+/).filter(Boolean);
    const topicWords = words.filter(w => !stopWords.has(w)).slice(0, 2);
    const topic = topicWords.join("-") || words[0] || "未分类";
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic)!.push(task);
  }

  const toBuild = [...groups.entries()].filter(([, tasks]) => tasks.length >= 2);
  if (toBuild.length === 0) {
    report.push("没有需要构建父任务的主题组");
    return;
  }

  report.push("将为 " + toBuild.length + " 个主题组创建父任务:");
  for (const [topic, tasks] of toBuild) {
    const types = tasks.map(t => t.type);
    const allCycle = types.every(t => t === "cycle");
    const hasLongterm = types.some(t => t === "longterm");
    let parentType = "normal";
    if (allCycle) parentType = "cycle";
    else if (hasLongterm) parentType = "longterm";

    const parentTitle = "[" + topic.toUpperCase() + "] " + topic + "相关工作";
    report.push("  \ud83d\udcc2 主题: " + topic + " -> 父任务: " + parentTitle + " (" + parentType + ")");
    for (const t of tasks) report.push("     - #" + t.id + ": " + t.title);

    if (shouldExecute) {
      try {
        const parentTask = await store.createTask({
          title: parentTitle,
          description: "自动创建，聚合 " + tasks.length + " 个 \"" + topic + "\" 相关子任务",
          type: parentType,
          priority: "medium",
          sessionId: "cli-organize",
          project_path: "organize",
          context: JSON.stringify({ type: "organize-auto", topic }),
        });
        for (const t of tasks) {
          await store.updateTask(t.id, { parent_task_id: parentTask.id });
        }
        report.push("     \u2705 已创建父任务 #" + parentTask.id);
      } catch (err: any) {
        report.push("     \u274c 创建失败: " + err.message);
      }
    }
  }
}

// ============================================================================
// Handler
// ============================================================================

export const handler = async (args: ArgumentsCamelCase<OrganizeArgs>) => {
  console.log("\uD83d\udd0d Task Organizer");

  // Connect to task store
  const { getDefaultTaskDbPath, SQLiteTaskStore } = await import(
    "@ai-setting/roy-bot-core"
  );
  const store = new SQLiteTaskStore(getDefaultTaskDbPath());
  await (store as any).initialize?.();

  const listResult = (await store.listTasks({ limit: 9999 })) as { tasks: TaskItem[]; total: number };
  const allTasks = listResult.tasks;
  console.log("\n\ud83d\udcca 系统中共有 " + allTasks.length + " 个任务 (total=" + listResult.total + ")\n");

  const report: string[] = [];

  if (args.deleteTest || args.auto) {
    await handleDeleteTest(store, allTasks, !args.dryRun, report);
  }
  if (args.aggregate || args.auto) {
    await handleAggregate(store, allTasks, !args.dryRun, report);
  }
  if (args.buildTree || args.auto) {
    await handleBuildTree(store, allTasks, !args.dryRun, report);
  }

  // Output report
  console.log("\n" + "=".repeat(60));
  console.log("\ud83d\udccb 整理报告");
  console.log("=".repeat(60));
  if (report.length === 0) {
    console.log("  \u2728 未指定整理策略。请使用以下选项：");
    console.log("     --delete-test    用 AI 清理测试任务");
    console.log("     --aggregate      聚合相似任务");
    console.log("     --build-tree     构建任务树");
    console.log("     --auto           全自动执行所有策略");
    console.log("     --dry-run        试运行预览");
  } else {
    console.log(report.join("\n"));
  }
  console.log("=".repeat(60));
  if (args.dryRun) {
    console.log("\n\u2728 提示：去掉 --dry-run 参数执行实际整理操作");
  }

  store.close();
};
