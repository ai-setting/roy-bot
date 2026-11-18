/**
 * @fileoverview Task #4620 — DecisionRenderer 的两个实现
 *
 * `DecisionHintPlugin`（#4481）的判定逻辑是载体无关的；**渲染**不是。
 * 不同载体的模型是在各自的渲染分布上训出来的，把 state/criteria 发成
 * 另一种形态，模型就落到分布外 —— 实测代价高达 32.5 个百分点。
 *
 *   实测（200 条 held-out，laya-train/scripts/format_probe.py）：
 *     laya 原样 state + laya 原样 key  → 79.00%
 *     roy JSON state + laya key        → 56.50%
 *     laya state + roy key             → 63.00%
 *     roy JSON state + roy key         → 46.50%
 */

import type { DecisionRequest } from "./decision-port";
import type { Task } from "../types";
import {
  renderCandidateKey,
  renderCandidateValue,
  formatRelativeAge,
} from "../hooks/verdict";
import {
  layaCandidateKey,
  layaCandidateValue,
  renderLayaState,
  renderLayaCriteria,
  matchChoiceToCandidate,
  LAYA_NEW_TASK_DESC,
} from "./laya-render";
import type { DecisionRenderer } from "./decision-hint-plugin";

/** Stage A 的 instructions —— 两个载体各自训练时用的措辞 */
export const SYSTEMONE_STAGE_A_INSTRUCTIONS =
  "判断本次『新任务请求』应该新建还是复用某个已有任务。若应复用，选该任务的 #id；若应新建，选 NEW_TASK。输出 choice/confidence/probabilities。";

export const LAYA_STAGE_A_INSTRUCTIONS =
  "优先复用：若候选与请求属于同一工作流/同一系列/目标重叠，必须选该候选的 #id；仅当完全无关时才选 NEW_TASK。";

/**
 * systemone 渲染器 —— 阿里百炼 systemone / #4107 的默认形态。
 *
 * state 是 JSON 对象（`task_to_route` + `similar_tasks`），
 * criteria key = `#<id> [<type>] <title[:40]>`。
 */
export const systemoneRenderer: DecisionRenderer = {
  buildStageA(input): DecisionRequest {
    const criteria: Record<string, string> = {};
    const similarTasks = input.candidates.map((t) => {
      const key = renderCandidateKey(t);
      criteria[key] = renderCandidateValue({
        id: t.id,
        status: t.status,
        ago: formatRelativeAge(t.updatedAt, input.now),
        description: t.description ?? "",
        tags: t.tags ?? [],
      });
      return {
        id: t.id,
        status: t.status,
        ago: formatRelativeAge(t.updatedAt, input.now),
        title: t.title,
        snippet: (t.description ?? "").slice(0, 120),
        tags: t.tags ?? [],
      };
    });
    criteria["NEW_TASK"] = "新建为独立任务（与所有现有候选均无明确关联）";

    return {
      state: {
        task_to_route: {
          title: input.title,
          description: input.description,
          goals: input.goals,
          tags: input.tags,
          project_path: input.projectPath,
        },
        similar_tasks: similarTasks,
      },
      questions: {
        reuse_or_create: {
          type: "choice",
          instructions: SYSTEMONE_STAGE_A_INSTRUCTIONS,
          criteria,
        },
      },
    };
  },

  matchChoice(choice: string, candidates: Task[]): number | undefined {
    const keyById = new Map(candidates.map((t) => [renderCandidateKey(t), t.id]));
    let targetTaskId = keyById.get(choice);
    if (targetTaskId === undefined && choice.startsWith("#")) {
      const bareId = Number(choice.slice(1));
      if (Number.isInteger(bareId) && candidates.some((t) => t.id === bareId)) {
        targetTaskId = bareId;
      }
    }
    return targetTaskId;
  },
};

/**
 * laya 渲染器 —— #4614 的 Laya 微调模型的训练格式。
 *
 * state 是中文文本，候选**重复**在 state 与 criteria 里（训练时的形态）。
 * criteria key = `#<id> <title[:50]>`（无 `[type]` 段）。
 */
export const layaRenderer: DecisionRenderer = {
  buildStageA(input): DecisionRequest {
    const candidates = input.candidates.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      ago: formatRelativeAge(t.updatedAt, input.now),
      description: t.description ?? "",
      tags: t.tags ?? [],
    }));

    // Task #4669 — req tags 同时进 state（【请求标签】行）与 question
    //   （instructions 尾部）。无 tags 时两者都保持旧格式（向后兼容）。
    const reqTags = (input.tags ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    return {
      // ⚠️ laya 的 state 是**中文文本**（训练时的形态），不是 JSON —— 这正是
      //   格式敏感性的来源：systemone 载体用 JSON state，laya 载体用文本 state。
      state: renderLayaState({
        title: input.title,
        description: input.description,
        tags: reqTags,
        candidates,
      }),
      questions: {
        reuse_or_create: {
          type: "choice",
          instructions:
            reqTags.length > 0
              ? `${LAYA_STAGE_A_INSTRUCTIONS}\n请求标签：${reqTags.join(",")}`
              : LAYA_STAGE_A_INSTRUCTIONS,
          criteria: renderLayaCriteria(candidates),
        },
      },
    };
  },

  matchChoice(choice: string, candidates: Task[]): number | undefined {
    const layaCands = candidates.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      ago: "",
      description: t.description ?? "",
      tags: t.tags ?? [],
    }));
    const direct = matchChoiceToCandidate(choice, layaCands);
    if (direct !== undefined) return direct;

    // 兜底：模型可能回了 roy-bot 形态的 key（`#<id> [<type>] <title>`）
    const m = /^#(\d+)/.exec(choice);
    if (m) {
      const bare = Number(m[1]);
      if (Number.isInteger(bare) && candidates.some((t) => t.id === bare)) return bare;
    }
    return undefined;
  },
};

export { LAYA_NEW_TASK_DESC, layaCandidateKey, layaCandidateValue };
