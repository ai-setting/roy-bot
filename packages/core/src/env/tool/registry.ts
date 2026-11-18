import type {
  Tool,
  ToolRegistration,
  ToolListFilter,
} from "./types";

/**
 * 工具注册中心
 * 管理所有已注册的工具
 */
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  /**
   * 注册工具
   */
  register(tool: Tool, registration: ToolRegistration): void {
    this.tools.set(tool.name, registration);
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 获取工具
   */
  getTool(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有工具注册信息
   */
  getAllTools(): ToolRegistration[] {
    return Array.from(this.tools.values());
  }

  /**
   * 列出工具（带过滤）
   */
  listTools(filter?: ToolListFilter): Tool[] {
    let tools = this.getAllTools();

    if (!filter) {
      return tools.map((r) => r.tool);
    }

    // 按名称过滤
    if (filter.name) {
      const names = Array.isArray(filter.name) ? filter.name : [filter.name];
      tools = tools.filter((r) =>
        names.some((pattern) => this.matchGlob(r.tool.name, pattern))
      );
    }

    // 按分类过滤
    if (filter.category) {
      tools = tools.filter((r) => r.tool.metadata?.category === filter.category);
    }

    // 按标签过滤
    if (filter.tags && filter.tags.length > 0) {
      tools = tools.filter((r) =>
        filter.tags!.some((tag) => r.tool.metadata?.tags?.includes(tag))
      );
    }

    // 按来源过滤
    if (filter.source) {
      tools = tools.filter((r) => r.source === filter.source);
    }

    // 只返回启用的工具
    if (filter.enabledOnly) {
      tools = tools.filter((r) => r.enabled);
    }

    // 排除工具
    if (filter.exclude && filter.exclude.length > 0) {
      tools = tools.filter((r) => !filter.exclude!.includes(r.tool.name));
    }

    // 按 agent 名称过滤（工具级 allowedAgentTypes 可见性）
    // - allowedAgent 未设置 → 不过滤（向后兼容）
    // - allowedAgent 设置 → 工具 metadata.allowedAgentTypes 未声明/空数组 视为对所有 agent 可见；
    //                              非空数组时仅当 allowedAgent 命中任一元素才返回
    if (filter.allowedAgent !== undefined) {
      const agentName = filter.allowedAgent;
      tools = tools.filter((r) => {
        const allowedList = r.tool.metadata?.allowedAgentTypes;
        if (!allowedList || allowedList.length === 0) return true;
        return allowedList.includes(agentName);
      });
    }


    return tools.map((r) => r.tool);
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取工具数量
   */
  getCount(): number {
    return this.tools.size;
  }

  /**
   * 启用工具
   */
  enable(name: string): boolean {
    const reg = this.tools.get(name);
    if (reg) {
      reg.enabled = true;
      return true;
    }
    return false;
  }

  /**
   * 禁用工具
   */
  disable(name: string): boolean {
    const reg = this.tools.get(name);
    if (reg) {
      reg.enabled = false;
      return true;
    }
    return false;
  }

  /**
   * 清除所有工具
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * 导出工具注册表快照
   */
  snapshot(): ToolRegistration[] {
    return this.getAllTools();
  }

  /**
   * 从快照恢复
   */
  restore(snapshot: ToolRegistration[]): void {
    this.clear();
    for (const reg of snapshot) {
      this.tools.set(reg.tool.name, reg);
    }
  }

  /**
   * 简单的 glob 模式匹配
   * 支持 * 匹配任意字符
   */
  private matchGlob(str: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return str === pattern;

    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special regex chars
      .replace(/\*/g, ".*"); // Convert * to .*

    return new RegExp(`^${regexPattern}$`).test(str);
  }
}
