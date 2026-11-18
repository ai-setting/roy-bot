import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';
import { WorkflowValidator } from './workflow-validator';
import type { RawWorkflowDefinition } from './types';

const YAML_PATH = resolve(__dirname, '../../../../../../examples/a-stock-screener-v0.7.0.yaml');

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

describe('a-stock-screener-v0.7.0.yaml structural portability (Task #2379 / #2381)', () => {
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

  it('backtest node carries holding_pnl kwargs (Phase A contract)', () => {
    const { workflow } = readWorkflow();
    const backtest = (workflow.nodes ?? []).find((n) => n.id === 'backtest');
    expect(backtest).toBeDefined();
    expect(backtest?.type).toBe('python_call');
    const args = backtest?.config?.args as Record<string, unknown> | undefined;
    expect(args).toBeDefined();

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

  it('declares v0.7.0 inputs (holding_days / enable_holding_pnl / fee_model / shares_per_lot / ohlc_cache_dir)', () => {
    const { workflow } = readWorkflow();
    // YAML may use either `inputs: [...]` or `input.properties: {...}`
    const inputsList = workflow.inputs ?? [];
    const inputProps = workflow.input?.properties ?? {};
    const inputNamesFromList = inputsList.map((i) => i.name ?? '');
    const inputNamesFromProps = Object.keys(inputProps);
    const allInputNames = new Set([
      ...inputNamesFromList,
      ...inputNamesFromProps,
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
});