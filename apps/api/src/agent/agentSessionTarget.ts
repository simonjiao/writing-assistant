import { ArticleArtifact, DialogueContextKind, ExternalStores, PiAgentSession, PiAgentSessionContextKind, newId, nowIso } from '@wa/core';

export type NonWorkflowContextKind = DialogueContextKind | 'article-comment' | 'dialogue-brief';

export interface AgentSessionTarget {
  userId: string;
  workspaceId?: string;
  articleId?: string;
  contextKind: NonWorkflowContextKind;
  targetId?: string;
}

export function articleSessionTarget(input: {
  article: ArticleArtifact;
  userId: string;
  contextKind: NonWorkflowContextKind;
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
    articleId: target.articleId,
    contextKind: target.contextKind as PiAgentSessionContextKind,
    targetId: target.targetId,
  });
  if (existing) {
    return {
      session: await stores.piAgentSessionStore.saveSession({
        ...existing,
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
    payload: { userId: target.userId, sessionId: session.id, articleId: target.articleId, contextKind: target.contextKind, targetId: target.targetId },
    createdAt: now,
  });
  return { session, created: true };
}
