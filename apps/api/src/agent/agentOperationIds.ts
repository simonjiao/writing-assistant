import { hashOperationArgs } from '@wa/core';
import { AgentSessionTarget } from './agentSessionTarget';

export function agentOperationId(prefix: string, target: AgentSessionTarget, input: unknown): string {
  return `op_agent_${prefix}_${hashOperationArgs({
    userId: target.userId,
    workspaceId: target.workspaceId,
    articleId: target.articleId,
    contextKind: target.contextKind,
    targetId: target.targetId,
    input,
  }).slice(0, 24)}`;
}

export function agentToolArgsHash(input: unknown): string {
  return hashOperationArgs(input);
}
