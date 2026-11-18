/**
 * @fileoverview 深度合并工具
 * 
 * 将源对象深度合并到目标对象
 * - target 现有值会被保留
 * - source 中的值会覆盖 target 中的值
 * - 嵌套对象递归合并
 * - 数组会被替换而非合并
 */

/**
 * 深度合并两个对象
 * 
 * @param target - 目标对象（现有值会被保留）
 * @param source - 源对象（值会覆盖 target）
 * @returns 合并后的新对象
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T;

/**
 * 深度合并两个对象（支持任意结构）
 */
export function deepMerge<T extends object>(
  target: T,
  source: Partial<T>
): T;

export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        // 两者都是对象，递归合并
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        );
      } else {
        // 其他情况直接覆盖
        result[key] = sourceValue as unknown;
      }
    }
  }

  return result as T;
}
