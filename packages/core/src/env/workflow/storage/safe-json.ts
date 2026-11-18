/**
 * @fileoverview Safe JSON parsing helpers for storage layer
 *
 * 历史背景：Bug 修复 Task #4033 / Task #4037
 * ----------------------------------------------------------------
 * Bug #4033：task-store 的 rowToTask 对 tags 字段做裸 `JSON.parse`，
 *   当 tags 被存成 CSV 字符串 `'html-styling, css-refactor, v34, ...'`
 *   时抛 SyntaxError，整个 `tasks list` 命令挂掉。
 *
 * Bug #4037（sibling-risk）：workflow-repo 的 rowToWorkflow 同样有 4 处
 *   裸 JSON.parse（metadata / definition / config / tags），本文件统一
 *   收口成 4 个语义明确的 helper：
 *
 *   - parseJsonOrThrow(raw, fieldName, rowCtx)
 *       业务关键字段（definition / metadata）损坏时直接抛错。
 *       错误信息带 fieldName + row.name + row.id，便于排查。
 *       原则：宁可让上层在 ReportError 路径上挂掉，也别返回 silent-corrupt 数据。
 *
 *   - parseJsonObjectOrEmpty(raw, fieldName)
 *       辅助对象字段（config）损坏时 fallback 到 {}。
 *
 *   - parseTagsSafely(raw)
 *       tags 字段专用，复用 task-store 的 5-tier fallback 策略：
 *         1. null/undefined/空串 → []
 *         2. 合法 JSON 数组 → 原样返回
 *         3. 合法 JSON 但不是数组（如 "tag1" 单字符串）→ 包成单元素数组
 *         4. 非法 JSON（CSV / 纯文本）→ 当作单个 tag，包成单元素数组
 *         5. 其他类型 → []
 *
 *   - parseJsonArrayOrEmpty(raw, fieldName)
 *       通用数组字段 fallback（如未来 workflow_tags 表新增数组字段）。
 *       当前 task-store 的 parseTagsSafely 是 private static，未来重构时
 *       可以考虑迁到这里以避免重复。
 */

export interface RowContext {
  /** 数据库行 id（UUID），用于错误信息定位 */
  id?: string;
  /** workflow/task 名字，便于人在错误里直接 grep */
  name?: string;
}

/**
 * 业务关键字段：损坏时抛错，错误信息带 fieldName + row.name + row.id。
 *
 * @throws {Error} 包含 fieldName / row.name / row.id / 原始片段
 */
export function parseJsonOrThrow<T = unknown>(
  raw: unknown,
  fieldName: string,
  rowCtx: RowContext = {},
): T {
  if (raw === null || raw === undefined || raw === "") {
    throw new Error(
      `[workflow-repo] Required field "${fieldName}" is empty for row id=${rowCtx.id ?? "?"} name=${rowCtx.name ?? "?"}`,
    );
  }
  const str = typeof raw === "string" ? raw : String(raw);
  try {
    return JSON.parse(str) as T;
  } catch (err) {
    const snippet = str.length > 80 ? str.slice(0, 80) + "..." : str;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[workflow-repo] Corrupt JSON in required field "${fieldName}" for row id=${rowCtx.id ?? "?"} name=${rowCtx.name ?? "?"}: ${detail}. Raw: ${snippet}`,
    );
  }
}

/**
 * 辅助对象字段：损坏时 fallback 到 {}，不抛错。
 */
export function parseJsonObjectOrEmpty<T extends object = Record<string, unknown>>(
  raw: unknown,
  fieldName: string,
): T {
  if (raw === null || raw === undefined || raw === "") {
    return {} as T;
  }
  const str = typeof raw === "string" ? raw : String(raw);
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return {} as T;
  } catch {
    return {} as T;
  }
}

/**
 * 通用数组字段 fallback。
 * 损坏时返回 []，不抛错。
 */
export function parseJsonArrayOrEmpty<T = unknown>(
  raw: unknown,
  fieldName: string,
): T[] {
  if (raw === null || raw === undefined || raw === "") {
    return [];
  }
  const str = typeof raw === "string" ? raw : String(raw);
  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
    if (typeof parsed === "string") {
      return [parsed] as T[];
    }
    return [];
  } catch {
    // 损坏数据 fallback：整段 raw 当作单个元素
    return [str as unknown as T];
  }
}

/**
 * tags 字段专用，语义与 task-store 的 parseTagsSafely 完全一致。
 *
 * 未来如果 task-store 的 private static parseTagsSafely 重构到这里，
 * 可以从 sqlite-task-store.ts 删掉私有版本，统一从本函数导入。
 */
export function parseTagsSafely(raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === "") {
    return [];
  }
  const str = typeof raw === "string" ? raw : String(raw);
  try {
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) {
      return parsed as string[];
    }
    if (typeof parsed === "string") {
      return [parsed];
    }
    // 其他类型（number/object 等）按"无法识别"处理
    return [];
  } catch {
    // 损坏数据 fallback：整段 raw 当作单个 tag
    return [str];
  }
}