/**
 * @fileoverview EventSource schedule 选项解析（Task #4815）
 *
 * CLI 的 `--schedule` 接受 JSON 字符串：
 * ```bash
 * roy-bot eventsource add daily-summary timer \
 *   --schedule '[{"time":"10:00","prompt":"早报"},{"time":"20:00","prompt":"晚报"}]'
 * ```
 *
 * 解析失败时**不抛异常**，返回 undefined（由调用方报错退出），
 * 避免 CLI 因用户 JSON 笔误直接抛栈。
 */

/** 单条 schedule 项（CLI 侧结构，与 core 保持一致） */
export interface ScheduleOptionEntry {
  time: string;
  prompt: string;
  label?: string;
  sessionId?: string;
}

/**
 * 解析 `--schedule` JSON 字符串
 *
 * @param raw 原始字符串；undefined / 空串 → undefined
 * @returns 解析后的数组（非空数组）；非法输入 → undefined
 */
export function parseScheduleOption(raw: unknown): ScheduleOptionEntry[] | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  return parsed as ScheduleOptionEntry[];
}

/**
 * 解析 `--schedule` JSON 字符串，**允许空数组**（用于清除 schedule）
 *
 * ★ Task #4815 review M-7：`--schedule '[]'` 表示"清除 schedule，退回 interval 模式"，
 *   但 `parseScheduleOption` 把空数组判成 undefined → 用户无法清空，
 *   只能 remove + 重新 add。
 *
 * @param raw 原始字符串
 * @returns 解析后的数组（可为空）；非法 JSON / 非数组 → undefined
 */
export function parseScheduleOptionAllowEmpty(
  raw: unknown,
): ScheduleOptionEntry[] | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) return undefined;
  return parsed as ScheduleOptionEntry[];
}

/** `HH:MM` 格式（与 core 侧 isValidScheduleTime 保持一致） */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * 校验 schedule 语义（与 core 侧 validateScheduleConfig 规则一致）
 *
 * ★ Task #4815 review MINOR-2：CLI 层也做语义校验，
 *   否则 `--schedule '[{"time":"25:00","prompt":"x"}]'` 会通过 CLI、
 *   在 `esComponent.register()` 里抛错 → 用户看到堆栈而不是友好提示。
 *
 * @param schedule 待校验的 schedule 数组
 * @returns 错误描述数组；空数组 = 合法
 */
export function validateScheduleEntries(schedule: ScheduleOptionEntry[]): string[] {
  const errors: string[] = [];
  schedule.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      errors.push(`schedule[${index}] 必须是对象`);
      return;
    }
    if (typeof entry.time !== "string" || !TIME_PATTERN.test(entry.time)) {
      errors.push(
        `schedule[${index}].time 必须是 HH:MM 格式（00:00-23:59），当前: ${String(entry.time)}`,
      );
    }
    if (typeof entry.prompt !== "string" || entry.prompt.trim().length === 0) {
      errors.push(`schedule[${index}].prompt 必填且不能为空`);
    }
  });

  // ★ Task #4815（DS review3）：重复的 time 必须拒绝。
  //   同一时刻配两项时只有第一项会触发（后一项被静默忽略）。
  const seenTimes = new Set<string>();
  const duplicatedTimes = new Set<string>();
  for (const entry of schedule) {
    if (!entry || typeof entry !== "object") continue;
    const time = entry.time;
    if (typeof time !== "string" || !TIME_PATTERN.test(time)) continue;
    if (seenTimes.has(time)) {
      duplicatedTimes.add(time);
    }
    seenTimes.add(time);
  }
  if (duplicatedTimes.size > 0) {
    errors.push(
      `schedule 中存在重复的时间点：${Array.from(duplicatedTimes).join(", ")}（同一时刻只能配置一项）`,
    );
  }

  return errors;
}

/**
 * 累积式合并 event-source 的 options patch
 *
 * ★ Task #4815 review MAJOR-2：旧写法是多段各自
 *   `partial.options = { ...existingOptions, X }`（每段都从原始基线重建），
 *   同时传 --prompt/--schedule/--session-id 时后面的会覆盖前面的，
 *   导致 --schedule 被静默丢弃。
 *
 * @param existing 事件源现有 options
 * @param patch 要更新的 key-value（只包含本次显式传入的字段）
 * @returns 合并后的 options
 */
export function mergeEventSourceOptions(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...patch };
}
