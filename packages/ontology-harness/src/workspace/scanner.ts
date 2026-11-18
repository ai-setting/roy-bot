/**
 * @fileoverview workspace 扫描器
 *
 * 遍历工作区目录下的 markdown 文件，解析术语定义并填入 WorkspaceIndex。
 * 同时提供 `indexDocument` 供插件在单文件变更时做增量更新。
 *
 * v8.3（Task #3200）：扫描器同时把 operator 文件的完整 OntologyDocument
 * 写入 WorkspaceIndex，供跨文件 operator chaining 钩子（TM125/TM126）使用。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceIndex } from "./index";
import { parseTermDefinitions } from "../ontology/link-def-types";
import { analyzeOntology } from "../ontology/analyzer";

const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", ".cache"]);
const DEFAULT_EXTENSIONS = [".md", ".markdown"];

export interface ScanOptions {
  /** 忽略的目录名 */
  ignoreDirs?: Set<string>;
  /** 纳入扫描的扩展名 */
  extensions?: string[];
  /** 单次扫描的文件数上限（防止误扫超大目录） */
  maxFiles?: number;
}

/** 把单个文件内容解析并写入索引（增量更新）。 */
export function indexDocument(
  index: WorkspaceIndex,
  fileAbs: string,
  content: string
): void {
  index.setFile(fileAbs, parseTermDefinitions(content));
  // v8.3（Task #3200）：operator 文件额外注册 OntologyDocument，
  // 供 TM125/TM126 跨文件钩子使用。
  try {
    const { document } = analyzeOntology(fileAbs, content);
    if (document.frontmatter.type === "operator" && document.frontmatter.domain) {
      index.setOperatorDocument(fileAbs, document);
    }
  } catch {
    // 解析失败不阻断索引
  }
}

/** 扫描工作区，返回填充好的 WorkspaceIndex。 */
export async function scanWorkspace(
  root: string,
  opts: ScanOptions = {}
): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex();
  const ignore = opts.ignoreDirs ?? DEFAULT_IGNORE;
  const exts = opts.extensions ?? DEFAULT_EXTENSIONS;
  const maxFiles = opts.maxFiles ?? 5000;

  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!exts.includes(ext)) continue;
        try {
          const content = await fs.readFile(full, "utf-8");
          indexDocument(index, full, content);
          count++;
        } catch {
          // 读取失败的文件跳过，不阻断整体扫描
        }
      }
    }
  };

  await walk(root);
  return index;
}
