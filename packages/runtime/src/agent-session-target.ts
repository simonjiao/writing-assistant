import { ArticleArtifact, ExternalStores, PiAgentSession, PiAgentSessionContextKind, newId, nowIso } from '@wa/core';

export type AgentSessionContextKind = PiAgentSessionContextKind;

export interface AgentSessionTarget {
  userId: string;
  runId?: string;
  workspaceId?: string;
  articleId?: string;
  contextKind: AgentSessionContextKind;
  targetId?: string;
}

export function articleSessionTarget(input: {
  article: ArticleArtifact;
  userId: string;
  contextKind: AgentSessionContextKind;
  targetId?: string;
}): AgentSessionTarget {
  return {
    userId: input.userId,
    workspaceId: input.article.workspaceId,
    articleId: input.article.id,
    contextKind: input.contextKind,
    targetId: input.targetId,
  };
}

export async function getOrCreateAgentSession(stores: ExternalStores, target: AgentSessionTarget): Promise<{ session: PiAgentSession; created: boolean }> {
  const existing = await stores.piAgentSessionStore.findSession({
    userId: target.userId,
    articleId: target.runId ? undefined : target.articleId,
    contextKind: target.contextKind as PiAgentSessionContextKind,
    targetId: target.targetId,
    runId: target.runId,
  });
  if (existing) {
    return {
      session: await stores.piAgentSessionStore.saveSession({
        ...existing,
        runId: existing.runId ?? target.runId,
        workspaceId: existing.workspaceId ?? target.workspaceId,
        articleId: existing.articleId ?? target.articleId,
        targetId: existing.targetId ?? target.targetId,
      }),
      created: false,
    };
  }
  const now = nowIso();
  const session: PiAgentSession = {
    id: newId('pi_ses'),
    runId: target.runId,
    userId: target.userId,
    workspaceId: target.workspaceId,
    articleId: target.articleId,
    contextKind: target.contextKind as PiAgentSessionContextKind,
    targetId: target.targetId,
    messages: [],
    lockVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
  await stores.piAgentSessionStore.saveSession(session);
  await stores.eventTraceStore.append({
    id: newId('evt'),
    type: 'pi.session.created',
    payload: { userId: target.userId, sessionId: session.id, runId: target.runId, articleId: target.articleId, contextKind: target.contextKind, targetId: target.targetId },
    createdAt: now,
  });
  return { session, created: true };
}
