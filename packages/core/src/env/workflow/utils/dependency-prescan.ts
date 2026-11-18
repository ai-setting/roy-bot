/**
 * @fileoverview Workflow 依赖前置检查 (Step 6.0.5 of roy-rd-with-trace v1.3.0)
 *
 * 在 cli-e2e-test 节点的 build/test/cli_smoke/trace_check 之前，对任务涉及的
 * workflow YAML 文件做 4 类静态依赖一致性检查：
 *
 *   1. checkDependsOnNodesExist       — depends_on 节点 ID 是否都存在
 *   2. checkEdgesNodesExist           — edges from/to 节点 ID 是否都存在
 *   3. checkEdgesDependsOnConsistency — edges 目标节点的 depends_on 是否包含 from (fan-out/fan-in 反模式)
 *   4. checkEntryNodeExists           — entry 节点是否存在
 *
 * 任何一个 FAIL → cli_e2e_status = "FAIL"，fail-fast。
 *
 * Task #2241 — v1.3.0 新增（Plan: docs/superpowers/plans/2026-07-21-fix-workflow-parallel-deps-reverify-plan.md）
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import type { WorkflowDefinition, NodeDefinition } from '../types/workflow';
import { wrapFunction } from '../../log-trace/decorator';

/**
 * A single finding from prescan.
 */
export interface PrescanFinding {
  checkName:
    | 'checkDependsOnNodesExist'
    | 'checkEdgesNodesExist'
    | 'checkEdgesDependsOnConsistency'
    | 'checkEntryNodeExists';
  severity: 'FAIL' | 'WARN';
  message: string;
  nodeIds?: string[];
}

/**
 * Aggregate result of prescan.
 */
export interface PrescanResult {
  ok: boolean;
  findings: PrescanFinding[];
}

// ==================== Internal helpers ====================

/**
 * Build a Map<id, node> from workflow.nodes. Used by all 4 checks.
 * Refactor extracted: avoids re-computing the map in each check.
 */
function buildNodeMap(workflow: WorkflowDefinition): Map<string, NodeDefinition> {
  const map = new Map<string, NodeDefinition>();
  for (const node of workflow.nodes ?? []) {
    map.set((node as NodeDefinition).id, node as NodeDefinition);
  }
  return map;
}

// ==================== Internal raw implementations ====================

function _prescanWorkflowImpl(workflow: WorkflowDefinition): PrescanResult {
  const findings: PrescanFinding[] = [];
  const nodeMap = buildNodeMap(workflow);
  const nodeIds = new Set(nodeMap.keys());

  findings.push(...checkDependsOnNodesExist(workflow, nodeIds));
  findings.push(...checkEdgesNodesExist(workflow, nodeIds));
  findings.push(...checkEdgesDependsOnConsistency(workflow, nodeIds));
  findings.push(...checkEntryNodeExists(workflow, nodeIds));

  return {
    ok: findings.filter((f) => f.severity === 'FAIL').length === 0,
    findings,
  };
}

function _checkDependsOnNodesExistImpl(
  workflow: WorkflowDefinition,
  nodeIds: Set<string>
): PrescanFinding[] {
  const findings: PrescanFinding[] = [];
  for (const node of workflow.nodes ?? []) {
    const deps = (node as NodeDefinition).depends_on ?? [];
    const missing = deps.filter((d: string) => !nodeIds.has(d));
    if (missing.length > 0) {
      findings.push({
        checkName: 'checkDependsOnNodesExist',
        severity: 'FAIL',
        message: `Node "${node.id}" declares depends_on=[${missing.join(
          ', '
        )}] but these IDs are not in nodes list`,
        nodeIds: missing,
      });
    }
  }
  return findings;
}

function _checkEdgesNodesExistImpl(
  workflow: WorkflowDefinition,
  nodeIds: Set<string>
): PrescanFinding[] {
  const findings: PrescanFinding[] = [];
  for (const edge of workflow.edges ?? []) {
    const missing: string[] = [];
    if (!nodeIds.has(edge.from)) missing.push(edge.from);
    if (!nodeIds.has(edge.to)) missing.push(edge.to);
    if (missing.length > 0) {
      findings.push({
        checkName: 'checkEdgesNodesExist',
        severity: 'FAIL',
        message: `Edge references missing node IDs: [${missing.join(', ')}]`,
        nodeIds: missing,
      });
    }
  }
  return findings;
}

function _checkEdgesDependsOnConsistencyImpl(
  workflow: WorkflowDefinition,
  _nodeIds: Set<string>
): PrescanFinding[] {
  const findings: PrescanFinding[] = [];
  // Build map fresh — nodeIds arg may be stale; this check needs node.depends_on
  const nodeMap = buildNodeMap(workflow);

  for (const edge of workflow.edges ?? []) {
    const target = nodeMap.get(edge.to);
    if (!target) continue; // checkEdgesNodesExist handles this case
    const deps = (target as NodeDefinition).depends_on ?? [];

    // Self-loop (source == target): intentional retry edge, OK to skip check.
    if (edge.from === edge.to) continue;

    // Back-edge heuristic: a `when` clause referencing FAIL or NEEDS_FIX
    // indicates this edge is control-flow (re-execute on failure), not data
    // dependency. Such edges are exempted from the depends_on check.
    if (isControlFlowEdge(edge)) continue;

    if (!deps.includes(edge.from)) {
      findings.push({
        checkName: 'checkEdgesDependsOnConsistency',
        severity: 'FAIL',
        message: `Edge ${edge.from}→${
          edge.to
        } fires downstream ${edge.to} but ${edge.to} does not declare depends_on including ${edge.from}`,
        nodeIds: [edge.from, edge.to],
      });
    }
  }
  return findings;
}

/**
 * Detect back-edge / control-flow edge from `when` clause keywords.
 *
 * Edges with `when` referencing FAIL or NEEDS_FIX (status keywords) are
 * control-flow edges used for re-execution. They MUST NOT be flagged as
 * missing depends_on, because their semantic is "re-trigger target if source
 * finished with FAIL", not "wait for source before starting target".
 *
 * Plain data edges without `when` (or with non-failure `when`) ARE flagged.
 */
function isControlFlowEdge(edge: { from: string; to: string; when?: string }): boolean {
  const when = edge.when ?? '';
  return /\b(FAIL|NEEDS_FIX)\b/.test(when);
}

function _checkEntryNodeExistsImpl(
  workflow: WorkflowDefinition,
  nodeIds: Set<string>
): PrescanFinding[] {
  const findings: PrescanFinding[] = [];
  if (typeof workflow.entry === 'string' && !nodeIds.has(workflow.entry)) {
    findings.push({
      checkName: 'checkEntryNodeExists',
      severity: 'FAIL',
      message: `Entry node "${workflow.entry}" not found in nodes list`,
      nodeIds: [workflow.entry],
    });
  }
  return findings;
}

// ==================== Exported trace-wrapped functions ====================

/**
 * Main entry: prescan a workflow definition object.
 */
export const prescanWorkflow = wrapFunction(
  _prescanWorkflowImpl,
  'workflow.dependency-prescan.prescanWorkflow',
  { recordParams: true, recordResult: true, log: true }
);

/**
 * Check 1: every depends_on reference resolves to an existing node ID.
 */
export const checkDependsOnNodesExist = wrapFunction(
  _checkDependsOnNodesExistImpl,
  'workflow.dependency-prescan.checkDependsOnNodesExist',
  { recordParams: true, recordResult: true, log: true }
);

/**
 * Check 2: every edge from/to resolves to an existing node ID.
 */
export const checkEdgesNodesExist = wrapFunction(
  _checkEdgesNodesExistImpl,
  'workflow.dependency-prescan.checkEdgesNodesExist',
  { recordParams: true, recordResult: true, log: true }
);

/**
 * Check 3: for every edge from → to, target node declares from in depends_on.
 * This catches the fan-out/fan-in anti-pattern where edges trigger downstream
 * but the downstream's depends_on declaration doesn't include the source.
 */
export const checkEdgesDependsOnConsistency = wrapFunction(
  _checkEdgesDependsOnConsistencyImpl,
  'workflow.dependency-prescan.checkEdgesDependsOnConsistency',
  { recordParams: true, recordResult: true, log: true }
);

/**
 * Check 4: the entry node must exist in the nodes list.
 * (Only checked when entry is a string; arrays are skipped — array entry is
 * considered advanced and not covered by this fail-fast rule.)
 */
export const checkEntryNodeExists = wrapFunction(
  _checkEntryNodeExistsImpl,
  'workflow.dependency-prescan.checkEntryNodeExists',
  { recordParams: true, recordResult: true, log: true }
);

// ==================== File-based convenience ====================

/**
 * Load a workflow YAML file from disk and run prescan.
 * Convenience wrapper for Step 6.0.5 CLI invocation.
 */
export function prescanWorkflowFile(path: string): PrescanResult {
  const absolutePath = resolve(path);
  const content = readFileSync(absolutePath, 'utf-8');
  const wf = parseYaml(content) as WorkflowDefinition;
  return prescanWorkflow(wf);
}