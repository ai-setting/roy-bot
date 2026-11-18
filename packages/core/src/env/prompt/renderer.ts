/**
 * @fileoverview Prompt Renderer - 模板变量替换
 */

export interface RenderOptions {
  prefix: string;
  suffix: string;
  strict: boolean;
  onMissingVariable?: (name: string) => string;
}

export class PromptRenderer {
  constructor(private options: RenderOptions) {}

  /**
   * 渲染模板，替换变量
   */
  render(template: string, variables: Record<string, string>): string {
    const { prefix, suffix, strict, onMissingVariable } = this.options;
    
    const regex = new RegExp(
      `${escapeRegex(prefix)}(.*?)${escapeRegex(suffix)}`,
      "g"
    );

    return template.replace(regex, (match, varName) => {
      const key = varName.trim();
      
      if (key in variables) {
        return variables[key];
      }
      
      if (strict) {
        throw new Error(`Missing required variable: ${key}`);
      }
      
      if (onMissingVariable) {
        return onMissingVariable(key);
      }
      
      // 默认：保留原标记
      return match;
    });
  }

  /**
   * 提取模板中的变量名列表
   */
  extractVariables(template: string): string[] {
    const { prefix, suffix } = this.options;
    const regex = new RegExp(
      `${escapeRegex(prefix)}(.*?)${escapeRegex(suffix)}`,
      "g"
    );
    
    const vars: string[] = [];
    let match;
    while ((match = regex.exec(template)) !== null) {
      vars.push(match[1].trim());
    }
    return [...new Set(vars)];
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
