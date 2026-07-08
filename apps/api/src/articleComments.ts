import { ArticleArtifact, ArticleBlock, ArticleComment, ExternalStores, newId, nowIso } from '@wa/core';
import type { ArticleCommentResolverInput, ArticleCommentResolverOutput } from '@wa/skills';
import { AgentToolExecutor } from './agent/agentToolExecutor';
import { agentOperationId } from './agent/agentOperationIds';
import { AgentSessionTarget, getOrCreateAgentSession } from './agent/agentSessionTarget';

export type ArticleCommentProcessResult = {
  commentId: string;
  blockId: string;
  action: ArticleCommentResolverOutput['action'];
  status: ArticleComment['status'];
  message: string;
  changed: boolean;
};

export async function processArticleComments(
  deps: { stores: ExternalStores; agentToolExecutor: AgentToolExecutor },
  article: ArticleArtifact,
  userId: string,
  options: { sessionId?: string; commentIds?: string[]; runId?: string; baseRevision?: number; operationId?: string } = {},
): Promise<{ article: ArticleArtifact; results: ArticleCommentProcessResult[] }> {
  const targetIds = new Set((options.commentIds ?? []).map((id) => id.trim()).filter(Boolean));
  const comments = article.comments ?? [];
  const targets = comments.filter((comment) => (targetIds.size ? targetIds.has(comment.id) : comment.status === 'open'));
  if (!targets.length) return { article, results: [] };
  let revisedCount = 0;
  const results: ArticleCommentProcessResult[] = [];
  for (const comment of targets) {
    const block = article.blocks.find((item) => item.id === comment.blockId);
    if (!block) {
      updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '这条批注关联的段落已经不存在，需要重新选择正文后再批注。' });
      results.push({ commentId: comment.id, blockId: comment.blockId, action: 'ask', status: comment.status, message: comment.response ?? '', changed: false });
      continue;
    }
    try {
      const target: AgentSessionTarget = { userId, workspaceId: article.workspaceId, articleId: article.id, contextKind: 'article-comment', targetId: comment.id };
      const { session } = await getOrCreateAgentSession(deps.stores, target);
      const skillInput: ArticleCommentResolverInput = {
        articleId: article.id,
        comment,
        block,
        taskCard: article.taskCard,
        adjacentBlocks: adjacentBlocksForArticle(article.blocks, block.id),
      };
      const output = await deps.agentToolExecutor.executeSkillTool<ArticleCommentResolverInput, ArticleCommentResolverOutput>({
        agentSession: session,
        allowedTools: ['resolve_article_comment'],
        toolName: 'resolve_article_comment',
        skillId: 'article-comment-resolver',
        input: skillInput,
        operationId: agentOperationId('article_comment_resolve', target, {
          commentId: comment.id,
          selectedText: comment.selectedText,
          comment: comment.comment,
          replies: comment.replies ?? [],
          blockText: block.text,
        }),
        sessionId: options.sessionId,
        runId: options.runId,
        articleId: article.id,
        blockId: block.id,
      });
      const applied = applyArticleCommentResolution(article, comment, output);
      if (applied.changed) revisedCount += 1;
      results.push({ commentId: comment.id, blockId: comment.blockId, action: output.action, status: comment.status, message: comment.response ?? output.response, changed: applied.changed });
    } catch (error) {
      updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: `这条批注没有处理成功，需要人工确认：${error instanceof Error ? error.message : String(error)}` });
      results.push({ commentId: comment.id, blockId: comment.blockId, action: 'ask', status: comment.status, message: comment.response ?? '', changed: false });
    }
  }
  if (typeof options.baseRevision !== 'number' || !options.operationId) {
    throw new Error('Article comment processing requires baseRevision and operationId.');
  }
  const updated = await deps.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: options.baseRevision, operationId: options.operationId });
  if (revisedCount) {
    await deps.stores.artifactStore.commitVersion(article.id, `处理正文批注：${revisedCount} 处修订`, 'agent');
  }
  await deps.stores.eventTraceStore.append({
    id: newId('evt'),
    runId: options.runId,
    type: 'artifact.updated',
    payload: { articleId: article.id, reason: 'article-comments-processed', processedCount: results.length, revisedCount, userId },
    createdAt: nowIso(),
  });
  return { article: (await deps.stores.artifactStore.getArticle(updated.id)) ?? updated, results };
}

export function updateComment(comment: ArticleComment, patch: Partial<ArticleComment>): void {
  const now = nowIso();
  Object.assign(comment, {
    ...patch,
    updatedAt: now,
    resolvedAt: patch.status === 'resolved' ? now : comment.resolvedAt,
  });
  if (typeof patch.response === 'string' && patch.response.trim()) appendCommentReply(comment, 'assistant', patch.response, now);
}

export function appendCommentReply(comment: ArticleComment, role: 'user' | 'assistant' | 'system', content: string, createdAt = nowIso()): void {
  const text = content.trim();
  if (!text) return;
  const replies = comment.replies ?? [];
  const last = replies[replies.length - 1];
  comment.replies = last?.role === role && last.content === text ? replies : [...replies, { id: newId('crp'), role, content: text, createdAt }];
  comment.updatedAt = createdAt;
}

export function canDeleteUnprocessedComment(comment: ArticleComment): boolean {
  return comment.status === 'open'
    && !(comment.replies ?? []).length
    && !comment.response?.trim()
    && !comment.replacementText?.trim()
    && !comment.resolvedAt;
}

export function canDeleteUnprocessedReply(comment: ArticleComment, reply: NonNullable<ArticleComment['replies']>[number]): boolean {
  if (comment.status !== 'open' || reply.role !== 'user') return false;
  const replies = comment.replies ?? [];
  const replyIndex = replies.findIndex((item) => item.id === reply.id);
  if (replyIndex < 0) return false;
  return replies.slice(replyIndex + 1).every((item) => item.role === 'user');
}

export function reconcileCommentAfterReplyDeletion(comment: ArticleComment): void {
  const now = nowIso();
  const replies = comment.replies ?? [];
  const latestReply = replies[replies.length - 1];
  if (latestReply?.role === 'user') {
    comment.status = 'open';
    comment.resolutionKind = undefined;
    comment.updatedAt = now;
    return;
  }
  if (comment.response?.trim()) {
    if (comment.replacementText?.trim() || comment.resolvedAt) {
      comment.status = 'resolved';
      comment.resolutionKind = comment.replacementText?.trim() ? 'revision' : 'explanation';
      comment.resolvedAt = comment.resolvedAt ?? now;
    } else {
      comment.status = 'needs_input';
      comment.resolutionKind = 'question';
    }
    comment.updatedAt = now;
    return;
  }
  if (comment.replacementText?.trim()) {
    comment.status = 'resolved';
    comment.resolutionKind = 'revision';
    comment.resolvedAt = comment.resolvedAt ?? now;
  } else {
    comment.status = 'open';
    comment.resolutionKind = undefined;
    comment.resolvedAt = undefined;
  }
  comment.updatedAt = now;
}

function applyArticleCommentResolution(article: ArticleArtifact, comment: ArticleComment, output: ArticleCommentResolverOutput): { changed: boolean } {
  if (output.action === 'explain') {
    updateComment(comment, { status: 'resolved', resolutionKind: 'explanation', response: output.response });
    return { changed: false };
  }
  if (output.action === 'ask') {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: output.response });
    return { changed: false };
  }
  const replacementText = output.replacementText?.trim();
  if (!replacementText) {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '处理器没有给出可替换文本，需要人工确认。' });
    return { changed: false };
  }
  const block = article.blocks.find((item) => item.id === comment.blockId);
  if (!block) {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '这条批注关联的段落已经不存在，需要重新选择正文后再批注。' });
    return { changed: false };
  }
  const range = locateCommentSelection(block.text, comment);
  if (!range) {
    updateComment(comment, { status: 'needs_input', resolutionKind: 'question', response: '选中文本已经变化，无法自动替换；请重新选择最新正文添加批注。' });
    return { changed: false };
  }
  const text = `${block.text.slice(0, range.start)}${replacementText}${block.text.slice(range.end)}`;
  article.blocks = article.blocks.map((item) => item.id === block.id ? { ...item, text, status: 'draft', updatedAt: nowIso() } : item);
  updateComment(comment, { status: 'resolved', resolutionKind: 'revision', response: output.response, replacementText });
  return { changed: true };
}

function locateCommentSelection(text: string, comment: ArticleComment): { start: number; end: number } | undefined {
  const directIndex = text.indexOf(comment.selectedText);
  if (directIndex >= 0) return { start: directIndex, end: directIndex + comment.selectedText.length };
  if (typeof comment.selectionStart === 'number' && typeof comment.selectionEnd === 'number' && text.slice(comment.selectionStart, comment.selectionEnd) === comment.selectedText) {
    return { start: comment.selectionStart, end: comment.selectionEnd };
  }
  return undefined;
}

function adjacentBlocksForArticle(blocks: ArticleBlock[], blockId: string): Array<Pick<ArticleBlock, 'id' | 'title' | 'text'>> {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return [];
  return blocks.slice(Math.max(0, index - 1), index + 2).filter((block) => block.id !== blockId).map((block) => ({ id: block.id, title: block.title, text: block.text.slice(0, 600) }));
}
