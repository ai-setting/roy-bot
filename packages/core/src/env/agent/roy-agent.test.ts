/**
 * @fileoverview Tests for roy built-in subagent
 *
 * 验证 roy 作为内置子智能体的完整可用性：
 * - prompts-index.ts 中已存在 'roy' 内置 prompt
 * - registerRoyAgent() 注册 AgentDefinition 含正确 systemPromptRef
 * - AgentRegistry 注册后通过 systemPromptRef 解析到 roy prompt
 * - subagent-resolver 接受 roy 作为已知 subagent 类型
 * - listKnownSubagentDescriptions 包含 roy
 *
 * 业务动机：
 *   新装用户无需 `agent add roy` 即可使用 roy 子智能体。
 *   roy 的 prompt 是 bundle-time 内置（builtInPrompts['roy']），
 *   但之前必须通过外部 YAML 注册才能使用 — 现在改为内置。
 */

import { describe, it, expect } from 'vitest';
import { getBuiltInPrompt, builtInPrompts } from '../prompt/prompts-index';
import { AgentRegistry } from './agent-registry';
import {
  builtInSubAgents,
  getSubAgentSpec,
} from '../task/delegate/delegate-tool';
import {
  isKnownSubagentType,
  listKnownSubagentDescriptions,
  resolveSubAgentConfig,
} from '../task/delegate/subagent-resolver';

describe('roy built-in subagent', () => {
  describe('prompts-index.ts', () => {
    it('should export "roy" built-in prompt', () => {
      expect(builtInPrompts['roy']).toBeDefined();
      expect(typeof builtInPrompts['roy']).toBe('string');
    });

    it('roy prompt should describe Roy as Jarvis-inspired assistant', () => {
      const prompt = builtInPrompts['roy'];
      expect(prompt).toContain('Roy');
      expect(prompt.toLowerCase()).toMatch(/jarvis/);
    });

    it('roy prompt should mention Roy Intelligent OS commands', () => {
      const prompt = builtInPrompts['roy'];
      expect(prompt).toContain('roy-bot');
      expect(prompt).toContain('roy-bot act');
      expect(prompt).toContain('roy-bot workflow');
    });

    it('roy prompt should describe identity (Name/Role/Personality)', () => {
      const prompt = builtInPrompts['roy'];
      expect(prompt).toContain('Name');
      expect(prompt).toContain('Role');
      expect(prompt).toContain('Personality');
    });

    it('should be accessible via getBuiltInPrompt("roy")', () => {
      const prompt = getBuiltInPrompt('roy');
      expect(prompt).toBeDefined();
      expect(prompt).toBe(builtInPrompts['roy']);
    });
  });

  describe('registerRoyAgent()', () => {
    it('should register "roy" agent with correct configuration', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerRoyAgent();

      const agent = registry.get('roy');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('roy');
      expect(agent?.type).toBe('sub');
      expect(agent?.systemPromptRef).toBe('roy');
    });

    it('should deny nested delegation (delegate_task/stop_task)', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerRoyAgent();

      const agent = registry.get('roy');
      expect(agent?.deniedTools).toEqual(
        expect.arrayContaining(['delegate_task', 'stop_task'])
      );
    });

    it('should NOT restrict allowedTools (roy is general-purpose)', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerRoyAgent();

      const agent = registry.get('roy');
      // roy 不应限制允许的工具 — 与 explore/json-extract 不同
      expect(agent?.allowedTools).toBeUndefined();
    });

    it('should be idempotent (no-op on double registration)', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerRoyAgent();
      registry.registerRoyAgent();

      const royAgents = registry.list().filter((a) => a.name === 'roy');
      expect(royAgents).toHaveLength(1);
    });
  });

  describe('builtInSubAgents (delegate-tool fallback)', () => {
    it('should include "roy" in builtInSubAgents', () => {
      const roySpec = getSubAgentSpec('roy');
      expect(roySpec).toBeDefined();
      expect(roySpec?.id).toBe('roy');
      expect(roySpec?.mode).toBe('subagent');
    });

    it('roy builtInSubAgents entry should use the "roy" built-in prompt as override', () => {
      const roySpec = builtInSubAgents.find((a) => a.id === 'roy');
      expect(roySpec).toBeDefined();
      expect(roySpec?.promptOverride).toBeDefined();
      expect(roySpec?.promptOverride).toBe(builtInPrompts['roy']);
    });

    it('roy builtInSubAgents entry should deny nested delegation', () => {
      const roySpec = builtInSubAgents.find((a) => a.id === 'roy');
      expect(roySpec?.deniedTools).toEqual(
        expect.arrayContaining(['delegate_task', 'stop_task'])
      );
    });
  });

  describe('subagent-resolver (no agent add required)', () => {
    it('isKnownSubagentType should accept "roy" without registry', () => {
      expect(isKnownSubagentType('roy')).toBe(true);
    });

    it('isKnownSubagentType should also accept "roy" with empty registry', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });
      expect(isKnownSubagentType('roy', registry)).toBe(true);
    });

    it('resolveSubAgentConfig should resolve "roy" via builtInSubAgents (fallback path)', async () => {
      const resolved = await resolveSubAgentConfig('roy');

      expect(resolved).toBeDefined();
      expect(resolved?.subagentType).toBe('roy');
      expect(resolved?.basePrompt).toContain('Roy');
      expect(resolved?.basePrompt).toBe(builtInPrompts['roy']);
      expect(resolved?.fromRegistry).toBe(false);
      expect(resolved?.deniedTools).toEqual(
        expect.arrayContaining(['delegate_task', 'stop_task'])
      );
    });

    it('listKnownSubagentDescriptions should include roy (no registry)', () => {
      const descriptions = listKnownSubagentDescriptions();
      expect(descriptions).toMatch(/^- roy:/m);
    });

    it('listKnownSubagentDescriptions should NOT duplicate roy when in registry', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });
      registry.registerRoyAgent();
      registry.register({
        name: 'roy',
        type: 'sub',
        description: 'Custom override should not duplicate built-in',
      });

      const descriptions = listKnownSubagentDescriptions(registry);
      const royMatches = descriptions.match(/^- roy:/gm) ?? [];
      expect(royMatches.length).toBeLessThanOrEqual(1);
    });
  });
});