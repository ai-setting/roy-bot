/**
 * RecoveryValidator - 分层恢复验证框架
 *
 * 遵循保守策略，严格验证状态完整性
 */

import { TracedAs } from '../../log-trace/decorator';
// Task #2283: WorkflowDefinition / SessionMessage 都是 interface, import type
import type { WorkflowDefinition } from '../types';
import type { SessionMessage } from '../../session/types';
import type {
  ValidationError,
  ValidationResult,
  RecoveryPlan,
} from './validation-rules';
import { ValidationErrorType, SuggestedAction } from './validation-rules';
import { ExecutionStateBuilder } from './execution-state';
import type { ExecutionState } from './validation-rules';

/**
 * RecoveryValidator - 分层恢复验证框架
 * 
 * 遵循保守策略，严格验证状态完整性
 */
export class RecoveryValidator {
  private stateBuilder: ExecutionStateBuilder;
  
  constructor() {
    this.stateBuilder = new ExecutionStateBuilder();
  }
  
  @TracedAs("recovery.validator.validate", { recordParams: true, recordResult: true, log: true })
  async validate(
    messages: SessionMessage[],
    definition: WorkflowDefinition
  ): Promise<ValidationResult> {
    // 构建执行状态
    const state = this.stateBuilder.build(messages, definition);
    
    const errors: ValidationError[] = [];
    const warnings: string[] = [];
    
    // 1. 状态完整性验证
    errors.push(...this.validateStateIntegrity(state, definition));
    
    // 2. 并行分支验证
    errors.push(...this.validateParallelBranches(state, definition));
    
    // 3. 条件分支验证
    errors.push(...this.validateConditionBranches(state, definition));
    
    // 4. 循环状态验证
    errors.push(...this.validateLoopState(state, definition));
    
    // 5. 嵌套 Workflow 验证
    errors.push(...this.validateNestedWorkflows(state, definition));
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }
  
  @TracedAs("recovery.generate.plan", { recordParams: true, recordResult: true, log: true })
  async generatePlan(
    messages: SessionMessage[],
    definition: WorkflowDefinition
  ): Promise<RecoveryPlan> {
    const state = this.stateBuilder.build(messages, definition);
    const validationResult = await this.validate(messages, definition);
    
    const pendingNodes = Array.from(state.pendingNodes);
    const completedNodes = Array.from(state.completedNodes);
    
    // 确定恢复点
    const resumePoint = this.determineResumePoint(state, definition);
    
    // 生成摘要
    const summary = this.generateSummary(state, validationResult);
    
    return {
      canResume: validationResult.isValid,
      resumePoint,
      completedNodes,
      pendingNodes,
      skippedNodes: [],
      validationErrors: validationResult.errors,
      summary,
    };
  }
  
  // === 私有验证方法 ===
  
  @TracedAs("recovery.validator.validateStateIntegrity", { recordParams: true, recordResult: true, log: true })
  private validateStateIntegrity(
    state: ExecutionState,
    definition: WorkflowDefinition
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // 检查待执行节点的变量依赖
    for (const nodeId of state.pendingNodes) {
      const node = definition.nodes?.find(n => n.id === nodeId);
      if (!node?.config) continue;
      
      // 解析输入中的变量引用 {{var}}
      const variableRefs = this.extractVariableRefs(node.config);
      
      for (const varRef of variableRefs) {
        if (!state.nodeOutputs.has(varRef) && !state.variables.has(varRef)) {
          errors.push({
            type: ValidationErrorType.MISSING_VARIABLE,
            nodeId,
            description: `变量 ${varRef} 不存在，需要重新运行`,
            suggestedAction: SuggestedAction.RE_RUN,
            context: { variable: varRef, nodeConfig: node.config },
          });
        }
      }
    }
    
    return errors;
  }
  
  @TracedAs("recovery.validator.validateParallel", { recordParams: true, recordResult: true, log: true })
  private validateParallelBranches(
    state: ExecutionState,
    definition: WorkflowDefinition
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // 识别并行分支（同一个 source，多个 target）
    const parallelGroups = this.identifyParallelGroups(definition);
    
    for (const group of parallelGroups) {
      const completedInGroup = group.filter(id => state.completedNodes.has(id));
      const inProgressInGroup = group.filter(id => state.inProgressNodes.has(id));
      
      // 如果有节点正在执行或未完成
      if (inProgressInGroup.length > 0 || completedInGroup.length < group.length) {
        // 检查合并节点是否应该等待
        const mergeNode = this.findMergeNodeForParallel(group, definition);
        
        if (mergeNode && !state.completedNodes.has(mergeNode)) {
          const incomplete = group.filter(id => !state.completedNodes.has(id));
          errors.push({
            type: ValidationErrorType.INCOMPLETE_PARALLEL,
            nodeId: mergeNode,
            description: `并行分支 ${incomplete.join(', ')} 未完成`,
            suggestedAction: SuggestedAction.RE_RUN,
            context: { incompleteBranches: incomplete, mergeNode },
          });
        }
      }
    }
    
    return errors;
  }
  
  @TracedAs("recovery.validator.validateCondition", { recordParams: true, recordResult: true, log: true })
  private validateConditionBranches(
    state: ExecutionState,
    definition: WorkflowDefinition
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // 查找有条件边的节点（支持 when 与旧版 condition 字段）
    const edges = (definition as any).edges || (definition as any).connections || [];
    const conditionalEdges = edges.filter((e: any) => e.when || e.condition);
    
    for (const edge of conditionalEdges) {
      const condition = edge.when || edge.condition;
      const conditionVars = this.extractVariableRefs(condition);
      
      for (const varRef of conditionVars) {
        if (!state.nodeOutputs.has(varRef) && !state.variables.has(varRef)) {
          errors.push({
            type: ValidationErrorType.AMBIGUOUS_BRANCH,
            nodeId: edge.target || edge.to,
            description: `条件分支无法确定：变量 ${varRef} 不存在`,
            suggestedAction: SuggestedAction.CONFIRM,
            context: { variable: varRef, condition },
          });
        }
      }
    }
    
    return errors;
  }
  
  @TracedAs("recovery.validator.validateLoop", { recordParams: true, recordResult: true, log: true })
  private validateLoopState(
    state: ExecutionState,
    definition: WorkflowDefinition
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // 识别循环结构（回边）
    const loops = this.identifyLoops(definition);
    
    for (const loop of loops) {
      // 检查循环计数器是否保持
      const loopCounter = `loop_count_${loop.header}`;
      
      if (!state.nodeOutputs.has(loopCounter) && state.pendingNodes.has(loop.header)) {
        errors.push({
          type: ValidationErrorType.LOOP_STATE_LOST,
          nodeId: loop.header,
          description: `循环状态丢失，循环计数器 ${loopCounter} 不存在`,
          suggestedAction: SuggestedAction.RE_RUN,
          context: { loopHeader: loop.header },
        });
      }
    }
    
    return errors;
  }
  
  @TracedAs("recovery.validator.validateNested", { recordParams: true, recordResult: true, log: true })
  private validateNestedWorkflows(
    state: ExecutionState,
    definition: WorkflowDefinition
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // 查找 workflow 节点
    const workflowNodes = (definition.nodes || []).filter(n => n.type === 'workflow');
    
    for (const node of workflowNodes) {
      const nodeOutput = state.nodeOutputs.get(node.id) as Record<string, unknown> | undefined;
      const subSessionId = nodeOutput?.sessionId as string | undefined;
      
      if (subSessionId && state.pendingNodes.has(node.id)) {
        // TODO: 检查子 session 状态 - 需要集成 SessionComponent
        // This requires integration with SessionComponent to check sub-session status
      }
    }
    
    return errors;
  }
  
  // === 辅助方法 ===
  
  private extractVariableRefs(obj: unknown): string[] {
    const refs: string[] = [];
    if (!obj) return refs;
    
    const str = JSON.stringify(obj);
    const regex = /\{\{([^}]+)\}\}/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
      refs.push(match[1].trim());
    }
    return refs;
  }
  
  private identifyParallelGroups(definition: WorkflowDefinition): string[][] {
    // 识别并行分支
    const groups: string[][] = [];
    const sources = new Map<string, string[]>();
    
    const edges = (definition as any).edges || (definition as any).connections || [];
    
    for (const edge of edges) {
      const source = edge.source || edge.from;
      const target = edge.target || edge.to;
      const targets = sources.get(source) || [];
      targets.push(target);
      sources.set(source, targets);
    }
    
    for (const [_source, targets] of sources) {
      if (targets.length > 1) {
        groups.push(targets);
      }
    }
    
    return groups;
  }
  
  private findMergeNodeForParallel(parallelIds: string[], definition: WorkflowDefinition): string | null {
    // 找到汇聚节点
    const edges = (definition as any).edges || (definition as any).connections || [];
    
    for (const edge of edges) {
      const target = edge.target || edge.to;
      const source = edge.source || edge.from;
      const allSourcesFromParallel = parallelIds.includes(source);
      const hasIncomingFromParallel = parallelIds.some(id => 
        edges.some((e: any) => (e.source || e.from) === id && (e.target || e.to) === target)
      );
      
      if (allSourcesFromParallel && hasIncomingFromParallel) {
        return target;
      }
    }
    
    return null;
  }
  
  private identifyLoops(definition: WorkflowDefinition): { header: string; body: string[] }[] {
    // 简化实现：查找回边
    const loops: { header: string; body: string[] }[] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();
    
    const edges = (definition as any).edges || (definition as any).connections || [];
    
    const getChildren = (nodeId: string): string[] => {
      return edges
        .filter((e: any) => (e.source || e.from) === nodeId)
        .map((e: any) => e.target || e.to);
    };
    
    const dfs = (nodeId: string, path: string[]): void => {
      visited.add(nodeId);
      recStack.add(nodeId);
      
      const outgoing = getChildren(nodeId);
      for (const childId of outgoing) {
        if (!visited.has(childId)) {
          dfs(childId, [...path, childId]);
        } else if (recStack.has(childId)) {
          // 发现回边
          const loopStart = path.indexOf(childId);
          if (loopStart !== -1) {
            loops.push({
              header: childId,
              body: path.slice(loopStart),
            });
          }
        }
      }
      
      recStack.delete(nodeId);
    };
    
    for (const node of definition.nodes || []) {
      if (!visited.has(node.id)) {
        dfs(node.id, [node.id]);
      }
    }
    
    return loops;
  }
  
  private determineResumePoint(state: ExecutionState, definition: WorkflowDefinition): string {
    // 优先从中断节点恢复
    const inProgress = Array.from(state.inProgressNodes);
    if (inProgress.length > 0) {
      return inProgress[0];
    }
    
    // 否则从第一个待执行节点恢复
    const pending = Array.from(state.pendingNodes);
    if (pending.length > 0) {
      return pending[0];
    }
    
    // 返回 entry
    const entry = definition.entry;
    if (Array.isArray(entry)) {
      return entry[0] || '';
    }
    return entry || '';
  }
  
  private generateSummary(state: ExecutionState, result: ValidationResult): string {
    if (result.isValid) {
      return `恢复验证通过。已完成 ${state.completedNodes.size} 个节点，待执行 ${state.pendingNodes.size} 个节点。`;
    }
    
    const errorTypes = result.errors.map(e => e.type).join(', ');
    return `恢复验证失败：${errorTypes}。${result.errors.length} 个错误需要处理。`;
  }
}
