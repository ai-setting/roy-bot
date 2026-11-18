import type { SessionMessage } from '../../session/types';
import type { 
  WorkflowNodeStartMetadata, 
  WorkflowNodeInterruptMetadata,
} from '../types/workflow-message';

/**
 * 查找最后一个 workflow.node.interrupt 消息
 */
export function findLastInterruptMessage(
  messages: SessionMessage[]
): SessionMessage | null {
  const interrupts = messages.filter(
    m => (m.metadata as any)?.type === 'workflow.node.interrupt'
  );
  return interrupts[interrupts.length - 1] || null;
}

/**
 * 解析节点输出
 * 
 * 通过匹配 workflow.node.start 和 workflow.node.end 消息对来提取节点输出
 */
export function parseNodeOutputs(
  messages: SessionMessage[]
): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  let lastStartNodeId: string | null = null;
  
  for (const msg of messages) {
    if ((msg.metadata as any)?.type === 'workflow.node.start') {
      const metadata = msg.metadata as unknown as WorkflowNodeStartMetadata;
      lastStartNodeId = metadata.workflowNodeId;
    } else if ((msg.metadata as any)?.type === 'workflow.node.end' && lastStartNodeId) {
      // 从 part 中提取 output（更可靠）
      const part = (msg as any).parts?.find((p: any) => p.type === 'workflow-node-end');
      if (part?.output !== undefined) {
        outputs.set(lastStartNodeId, part.output);
      } else {
        // Fallback: 尝试从 content 解析
        try {
          outputs.set(lastStartNodeId, JSON.parse(msg.content));
        } catch {
          outputs.set(lastStartNodeId, msg.content);
        }
      }
      lastStartNodeId = null;
    }
  }
  
  return outputs;
}

/**
 * 获取下一个待执行的节点
 */
export function getNextPendingNode(
  messages: SessionMessage[]
): string | null {
  const outputs = parseNodeOutputs(messages);
  const completedNodes = new Set(outputs.keys());
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if ((msg.metadata as any)?.type === 'workflow.node.start') {
      const metadata = msg.metadata as unknown as WorkflowNodeStartMetadata;
      const nodeId = metadata.workflowNodeId;
      if (!completedNodes.has(nodeId)) {
        return nodeId;
      }
    }
  }
  
  return null;
}

/**
 * 从 interrupt 消息获取 agentSessionId
 */
export function getAgentSessionIdFromInterrupt(
  interruptMessage: SessionMessage
): string | undefined {
  if ((interruptMessage.metadata as any)?.type === 'workflow.node.interrupt') {
    const metadata = interruptMessage.metadata as unknown as WorkflowNodeInterruptMetadata;
    return metadata.agentSessionId;
  }
  return undefined;
}

/**
 * 检查 session 是否在等待用户
 */
export function isWaitingForUser(messages: SessionMessage[]): boolean {
  const lastInterrupt = findLastInterruptMessage(messages);
  if (!lastInterrupt) return false;
  
  const interruptIndex = messages.indexOf(lastInterrupt);
  const afterInterrupt = messages.slice(interruptIndex + 1);
  
  return !afterInterrupt.some(m => (m.metadata as any)?.type === 'workflow.node.resume');
}
