import type { Node, NodeDefinition, NodeExecutionContext, NodeExecutionResult } from '../types';
import { TracedAs } from '../../log-trace/decorator';

/**
 * Skill Registry interface for looking up skills
 */
export interface SkillRegistry {
  getSkill(name: string): Skill | undefined;
  hasSkill(name: string): boolean;
}

/**
 * Skill interface for invocation
 */
export interface Skill {
  name: string;
  invoke(input: any, context: any): Promise<any>;
}

/**
 * SkillNode invokes a registered Skill with the provided input.
 * 
 * Input can contain template strings like {{nodeId.output.path}} that will be
 * resolved via context.templateResolver.
 */
export class SkillNode implements Node {
  readonly type = 'skill';
  readonly id: string;
  
  constructor(
    private definition: NodeDefinition,
    private skillRegistry: SkillRegistry
  ) {
    this.id = definition.id;
  }
  
  @TracedAs('workflow.skill.execute')
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const startTime = Date.now();
    
    try {
      // 1. Get skill name from definition.config.skill
      const skillName = this.definition.config?.skill as string | undefined;
      
      if (!skillName) {
        throw new Error('Skill name is required. Please specify config.skill in the node definition.');
      }
      
      // 2. Look up skill from registry
      const skill = this.skillRegistry.getSkill(skillName);
      
      if (!skill) {
        throw new Error(`Skill not found: ${skillName}`);
      }
      
      // 3. Prepare input (may reference previous outputs and workflow input)
      // Use pre-resolved config from context if available (avoids duplicate resolution)
      // Falls back to raw config for backward compatibility
      const config = context.resolvedConfig ?? this.definition.config ?? {};
      const input = config.input ?? {};
      const resolvedInput = context.templateResolver
        ? context.templateResolver.resolveValue(input)
        : input;
      
      // 4. Prepare context for skill invocation
      const skillContext = {
        runId: context.runId,
        workflowName: context.workflowName,
        nodeId: context.nodeId,
        debug: context.debug,
        sessionId: context.sessionId,
      };
      
      // 5. Invoke skill
      const output = await skill.invoke(resolvedInput, skillContext);
      
      // 6. Return result
      return {
        output,
        error: undefined,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        output: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: Date.now() - startTime,
      };
    }
  }
}
