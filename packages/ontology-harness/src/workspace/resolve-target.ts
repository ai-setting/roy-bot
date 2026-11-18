/**
 * @fileoverview link-definition 目标路径解析
 *
 * 把一条 link definition 的目标（相对定义文件书写）解析为工作区内的绝对路径，
 * 并剥离 `#锚点`。外部链接（http/https）不解析。
 */

import path from "node:path";

export interface ResolvedTarget {
  /** 解析后的绝对路径；外部链接为 null */
  absPath: string | null;
  /** `#` 之后的锚点（如有） */
  fragment?: string;
}

/**
 * @param definingFileAbs 该 link definition 所在文件的绝对路径
 * @param rawTarget       link definition 的原始目标字符串
 */
export function resolveTargetPath(
  definingFileAbs: string,
  rawTarget: string
): ResolvedTarget {
  // 外部链接不解析
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawTarget)) {
    return { absPath: null };
  }

  // 拆出 #锚点
  const hashIdx = rawTarget.indexOf("#");
  const pathPart = hashIdx >= 0 ? rawTarget.slice(0, hashIdx) : rawTarget;
  const fragment =
    hashIdx >= 0 ? decodeURIComponent(rawTarget.slice(hashIdx + 1)) : undefined;

  // 纯锚点 → 指向定义文件自身
  if (pathPart === "") {
    return { absPath: definingFileAbs, fragment };
  }

  const baseDir = path.dirname(definingFileAbs);
  const absPath = path.resolve(baseDir, pathPart);
  return { absPath, fragment };
}
