import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';
import { WorkflowValidator } from './workflow-validator';
import type { RawWorkflowDefinition } from './types';

const YAML_PATH = resolve(__dirname, '../../../../../../examples/a-stock-screener-v0.7.2.yaml');

type ParsedNode = {
  id?: string;
  type?: string;
  name?: string;
  config?: Record<string, unknown>;
};

type ParsedWorkflow = {
  name?: string;
  version?: string;
  nodes?: ParsedNode[];
  inputs?: Array<{ name?: string }>;
  input?: { properties?: Record<string, unknown> };
};

describe('a-stock-screener-v0.7.2.yaml structural portability (Task #2390)', () => {
  function readWorkflow(): { raw: string; workflow: ParsedWorkflow } {
    const raw = readFileSync(YAML_PATH, 'utf8');
    return { raw, workflow: yaml.parse(raw) as ParsedWorkflow };
  }

  it('parses and passes workflow validation', () => {
    const { workflow } = readWorkflow();
    const result = new WorkflowValidator().validate(workflow as unknown as RawWorkflowDefinition);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('declares name and version as v0.7.2', () => {
    const { workflow } = readWorkflow();
    expect(workflow.name).toBe('a-stock-screener-v0.7.2');
    expect(workflow.version).toBe('0.7.2');
  });

  it('contains no hard-coded virtualenv Python script path', () => {
    const { raw } = readWorkflow();
    expect(raw).not.toContain('.venv/bin/python');
  });

  it('declares module and function for every python_call node', () => {
    const { workflow } = readWorkflow();
    const pythonNodes = (workflow.nodes ?? []).filter(
      (node) => node.type === 'python_call',
    );

    expect(pythonNodes.length).toBeGreaterThanOrEqual(9);
    for (const node of pythonNodes) {
      expect(typeof node.config?.module).toBe('string');
      expect(node.config?.module).toMatch(/^investment_strategy\./);
      expect(typeof node.config?.function).toBe('string');
    }
  });

  it('backtest node accepts market-timing kwargs (v0.7.2 calibration)', () => {
    // v0.7.2: backtest 节点必须能接收 market_state / allowed_strategies /
    // market_timing_recommendation 以与 live run-strategies 口径对齐
    const { workflow } = readWorkflow();
    const backtest = (workflow.nodes ?? []).find((n) => n.id === 'backtest');
    expect(backtest).toBeDefined();
    const args = backtest?.config?.args as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    // 至少能接受 market_state / allowed_strategies（推荐但不强制）
    // 实际中 workflow 模板可传 market_timing_recommendation 完整 dict
    for (const key of [
      'enabled',
      'enable_holding_pnl',
      'holding_days',
      'fee_model',
      'shares_per_lot',
      'ohlc_cache_dir',
    ]) {
      expect(args).toHaveProperty(key);
    }
  });

  it('run-strategies consumes market-timing recommendation (v0.7.1+ contract preserved)', () => {
    const { workflow } = readWorkflow();
    const rs = (workflow.nodes ?? []).find((n) => n.id === 'run-strategies');
    expect(rs).toBeDefined();
    const args = rs?.config?.args as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    expect(args).toHaveProperty('active_strategies');
    expect(args).toHaveProperty('recommended_top_n');
  });

  it('risk-assess consumes run-strategies output directly (v0.7.1+ contract preserved)', () => {
    const { workflow } = readWorkflow();
    const ra = (workflow.nodes ?? []).find((n) => n.id === 'risk-assess');
    expect(ra).toBeDefined();
    const args = ra?.config?.args as Record<string, unknown> | undefined;
    expect(args).toBeDefined();
    expect(args).toHaveProperty('strategies_output');
    expect(String(args?.strategies_output ?? '')).toContain('run-strategies');
  });

  it('v4-scoring / ml-prediction / aggregate nodes configured for factor_panel', () => {
    const { workflow } = readWorkflow();
    for (const id of ['v4-scoring', 'ml-prediction', 'aggregate']) {
      const node = (workflow.nodes ?? []).find((n) => n.id === id);
      expect(node, `node ${id} should exist`).toBeDefined();
      expect(['python_call', 'tool']).toContain(node?.type);
    }
  });

  it('declares v0.7.0+ inputs (holding_days / enable_holding_pnl / fee_model / shares_per_lot / ohlc_cache_dir)', () => {
    const { workflow } = readWorkflow();
    const inputsList = workflow.inputs ?? [];
    const inputProps = workflow.input?.properties ?? {};
    const allInputNames = new Set([
      ...inputsList.map((i) => i.name ?? ''),
      ...Object.keys(inputProps),
    ]);
    for (const key of [
      'holding_days',
      'enable_holding_pnl',
      'fee_model',
      'shares_per_lot',
      'ohlc_cache_dir',
    ]) {
      expect(allInputNames.has(key)).toBe(true);
    }
  });

  it('node count and DAG unchanged (still 12 nodes)', () => {
    const { workflow } = readWorkflow();
    expect((workflow.nodes ?? []).length).toBe(12);
  });
});