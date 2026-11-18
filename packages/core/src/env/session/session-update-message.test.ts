import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemorySessionStore } from './storage/memory';

describe('SessionStore.updateMessage', () => {
  let store: MemorySessionStore;

  beforeEach(async () => {
    store = new MemorySessionStore();
    await store.create({ id: 'session_1', title: 'test' });
    await store.addMessage('session_1', {
      role: 'workflow.node.start',
      content: '[agent] agent-confirm started',
      metadata: { type: 'workflow.node.start', nodeId: 'agent-confirm' },
      parts: [{ type: 'workflow-node-start', nodeId: 'agent-confirm' }],
    });
  });

  afterEach(async () => {
    await store.close();
  });

  it('should update message metadata and parts by message id', async () => {
    const messages = await store.getMessages('session_1');
    const messageId = messages[0].id;

    const updated = await store.updateMessage('session_1', messageId, {
      metadata: { ...messages[0].metadata, agentSessionId: 'agent_sub_1' },
      parts: [{ type: 'workflow-node-start', nodeId: 'agent-confirm', agentSessionId: 'agent_sub_1' }],
    });

    expect(updated).toBe(true);

    const after = await store.getMessages('session_1');
    expect(after[0].metadata?.agentSessionId).toBe('agent_sub_1');
    expect((after[0].parts?.[0] as any)?.agentSessionId).toBe('agent_sub_1');
  });

  it('should return false for unknown message id', async () => {
    const updated = await store.updateMessage('session_1', 'missing', { metadata: {} });
    expect(updated).toBe(false);
  });
});
