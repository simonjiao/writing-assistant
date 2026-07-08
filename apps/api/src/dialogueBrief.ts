import { ArticleArtifact, DialogueBrief, DialogueBriefConflict, DialogueBriefItem, DialogueBriefUpdateJob, DialogueContextKind, DialogueMessage, KnowledgeItem, newId, nowIso } from '@wa/core';
import { AgentSessionTarget, agentOperationId, DialogueBriefUpdaterInput, DialogueBriefUpdaterOutput, getOrCreateAgentSession } from '@wa/workflows';
import type { AppContainer } from './bootstrap';

const maxBriefUpdateAttempts = 3;
const maxBriefJobRunningMs = 60_000;

export async function getOrCreateDialogueBrief(container: AppContainer, articleId: string, userId: string): Promise<DialogueBrief> {
  const existing = await container.stores.dialogueBriefStore.getBrief(articleId, userId);
  if (existing) return normalizeBrief(existing);
  const now = nowIso();
  return container.stores.dialogueBriefStore.saveBrief({
    id: `brief_${articleId}_${userId}`,
    articleId,
    userId,
    activeRequirements: [],
    evidenceNotes: [],
    recentUserIntents: [],
    unresolvedConflicts: [],
    supersededRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateDialogueBriefForUserMessage(input: {
  container: AppContainer;
  article: ArticleArtifact;
  userId: string;
  sessionId?: string;
  message: DialogueMessage;
  context: { kind: DialogueContextKind; title: string };
}): Promise<DialogueBrief> {
  const job = await input.container.stores.dialogueBriefUpdateJobStore.createJob({
    articleId: input.article.id,
    userId: input.userId,
    messageId: input.message.id,
    messageContent: input.message.content,
    contextKind: input.context.kind,
    contextTitle: input.context.title,
  });
  const processed = await processDialogueBriefUpdateJob(input.container, job.id, input.sessionId);
  if (processed?.status === 'failed') throw new Error(processed.error ?? 'Dialogue brief update failed.');
  return getOrCreateDialogueBrief(input.container, input.article.id, input.userId);
}

export async function enqueueDialogueBriefUpdate(input: {
  container: AppContainer;
  article: ArticleArtifact;
  userId: string;
  sessionId?: string;
  message: DialogueMessage;
  context: { kind: DialogueContextKind; title: string };
}): Promise<DialogueBriefUpdateJob> {
  const job = await input.container.stores.dialogueBriefUpdateJobStore.createJob({
    articleId: input.article.id,
    userId: input.userId,
    messageId: input.message.id,
    messageContent: input.message.content,
    contextKind: input.context.kind,
    contextTitle: input.context.title,
  });
  void processDialogueBriefUpdateJob(input.container, job.id, input.sessionId).catch(() => undefined);
  return job;
}

export async function ensureDialogueBriefSettled(container: AppContainer, articleId: string, userId: string): Promise<void> {
  const maxWaitMs = 15000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const failed = await container.stores.dialogueBriefUpdateJobStore.listJobs(articleId, userId, { statuses: ['failed'] });
    const exhausted = failed.find((job) => job.attempts >= maxBriefUpdateAttempts);
    if (exhausted) throw new Error(`Dialogue brief update failed: ${exhausted.error ?? exhausted.id}`);
    if (failed.length) {
      for (const job of failed) await processDialogueBriefUpdateJob(container, job.id);
      continue;
    }

    const pending = await container.stores.dialogueBriefUpdateJobStore.listJobs(articleId, userId, { statuses: ['pending'] });
    if (pending.length) {
      for (const job of pending) await processDialogueBriefUpdateJob(container, job.id);
      continue;
    }

    const running = await container.stores.dialogueBriefUpdateJobStore.listJobs(articleId, userId, { statuses: ['running'] });
    const staleRunning = running.filter(isStaleRunningJob);
    if (staleRunning.length) {
      for (const job of staleRunning) {
        const message = 'Dialogue brief update was interrupted before completion.';
        await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'dialogue.brief.failed', payload: { articleId: job.articleId, userId: job.userId, messageId: job.messageId, jobId: job.id, error: message, stale: true }, createdAt: nowIso() });
        await container.stores.dialogueBriefUpdateJobStore.updateJob({ ...job, status: 'failed', error: message, completedAt: nowIso() });
      }
      continue;
    }
    if (!running.length) return;
    await sleep(25);
  }
  throw new Error('Dialogue brief update timed out.');
}

export async function getDialogueBriefStatus(container: AppContainer, articleId: string, userId: string): Promise<{
  brief?: DialogueBrief;
  jobs: DialogueBriefUpdateJob[];
  status: 'idle' | 'updating' | 'failed';
  message?: string;
}> {
  const [brief, jobs] = await Promise.all([
    container.stores.dialogueBriefStore.getBrief(articleId, userId),
    container.stores.dialogueBriefUpdateJobStore.listJobs(articleId, userId, { limit: 8 }),
  ]);
  const latestJob = jobs[jobs.length - 1];
  if (latestJob?.status === 'failed') return { brief: brief ? normalizeBrief(brief) : undefined, jobs, status: 'failed', message: latestJob.error };
  if (jobs.some((job) => job.status === 'pending' || job.status === 'running')) return { brief: brief ? normalizeBrief(brief) : undefined, jobs, status: 'updating' };
  return { brief: brief ? normalizeBrief(brief) : undefined, jobs, status: 'idle' };
}

async function processDialogueBriefUpdateJob(container: AppContainer, jobId: string, sessionId?: string): Promise<DialogueBriefUpdateJob | undefined> {
  const job = await container.stores.dialogueBriefUpdateJobStore.getJob(jobId);
  if (!job || (job.status !== 'pending' && !(job.status === 'failed' && job.attempts < maxBriefUpdateAttempts))) return job;
  const running = await container.stores.dialogueBriefUpdateJobStore.updateJob({
    ...job,
    status: 'running',
    attempts: job.attempts + 1,
    error: undefined,
    startedAt: nowIso(),
  });
  try {
    const currentBrief = await getOrCreateDialogueBrief(container, running.articleId, running.userId);
    const target: AgentSessionTarget = { userId: running.userId, articleId: running.articleId, contextKind: 'dialogue-brief', targetId: running.messageId };
    const { session } = await getOrCreateAgentSession(container.stores, target);
    const programInput: DialogueBriefUpdaterInput = {
      message: running.messageContent,
      context: { kind: running.contextKind, title: running.contextTitle },
      currentBrief: compactDialogueBriefForPrompt(currentBrief),
      skipKnowledge: true,
    };
    const patch = await container.agentToolExecutor.executeTool<DialogueBriefUpdaterInput, DialogueBriefUpdaterOutput>({
      agentSession: session,
      allowedTools: ['update_dialogue_brief'],
      toolName: 'update_dialogue_brief',
      input: programInput,
      operationId: agentOperationId('dialogue_brief_update', target, { messageId: running.messageId, messageContent: running.messageContent, contextKind: running.contextKind }),
      sessionId,
      articleId: running.articleId,
    });
    const merged = mergeDialogueBrief(currentBrief, patch, running.contextKind, running.messageId);
    await container.stores.dialogueBriefStore.saveBrief(merged);
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'dialogue.brief.updated', payload: { articleId: running.articleId, userId: running.userId, messageId: running.messageId, jobId: running.id }, createdAt: nowIso() });
    return container.stores.dialogueBriefUpdateJobStore.updateJob({ ...running, status: 'succeeded', completedAt: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await container.stores.eventTraceStore.append({ id: newId('evt'), type: 'dialogue.brief.failed', payload: { articleId: running.articleId, userId: running.userId, messageId: running.messageId, jobId: running.id, error: message }, createdAt: nowIso() });
    return container.stores.dialogueBriefUpdateJobStore.updateJob({ ...running, status: 'failed', error: message, completedAt: nowIso() });
  }
}

export async function addKnowledgeEvidenceToBrief(input: {
  container: AppContainer;
  articleId: string;
  userId: string;
  query: string;
  items: KnowledgeItem[];
}): Promise<DialogueBrief> {
  const currentBrief = await getOrCreateDialogueBrief(input.container, input.articleId, input.userId);
  const evidenceNotes = input.items.map((item) => compactText(`${item.title}${item.sourceRef ? `（${item.sourceRef}）` : ''}`));
  const patch: DialogueBriefUpdaterOutput = {
    activeRequirements: [],
    evidenceNotes: evidenceNotes.length ? [`检索「${compactText(input.query)}」命中：${evidenceNotes.join('；')}`] : [],
    recentUserIntents: [],
    supersededRequirements: [],
    conflicts: [],
  };
  return input.container.stores.dialogueBriefStore.saveBrief(mergeDialogueBrief(currentBrief, patch, 'task-card'));
}

export function buildCompactDialogueConversation(messages: DialogueMessage[]): Array<{ role: 'user' | 'assistant'; content: string; proposalId?: string; createdAt: string }> {
  return messages
    .filter((message) => message.role === 'user')
    .slice(-5)
    .map((message) => ({
      role: message.role,
      content: compactText(message.content, 180),
      proposalId: message.proposalId,
      createdAt: message.createdAt,
    }));
}

export function compactDialogueBriefForPrompt(brief: DialogueBrief): DialogueBrief {
  const itemLimit = 8;
  return {
    ...brief,
    activeRequirements: brief.activeRequirements.filter((item) => item.status === 'active').slice(-itemLimit).map(compactBriefItem),
    evidenceNotes: brief.evidenceNotes.slice(-6).map(compactBriefItem),
    recentUserIntents: brief.recentUserIntents.slice(-6).map(compactBriefItem),
    unresolvedConflicts: brief.unresolvedConflicts.slice(-4).map((item) => ({
      ...item,
      text: compactText(item.text),
      requirements: item.requirements.map((text) => compactText(text, 120)).slice(0, 4),
      sourceMessageIds: item.sourceMessageIds.slice(-4),
    })),
    supersededRequirements: brief.supersededRequirements.slice(-8).map(compactBriefItem),
  };
}

export function mergeDialogueBrief(current: DialogueBrief, patch: DialogueBriefUpdaterOutput, contextKind: DialogueContextKind, sourceMessageId?: string): DialogueBrief {
  const now = nowIso();
  let activeRequirements: DialogueBriefItem[] = normalizeItems(current.activeRequirements).filter((item) => item.status === 'active');
  let supersededRequirements: DialogueBriefItem[] = normalizeItems([...current.supersededRequirements, ...current.activeRequirements.filter((item) => item.status === 'superseded')]).map((item) => ({ ...item, status: 'superseded' as const }));
  let unresolvedConflicts = normalizeConflicts(current.unresolvedConflicts);

  const supersededTexts = new Set((patch.supersededRequirements ?? []).map(normalizeText).filter(Boolean));
  if (supersededTexts.size) {
    const moved = activeRequirements.filter((item) => supersededTexts.has(normalizeText(item.text))).map((item) => ({ ...item, status: 'superseded' as const, updatedAt: now }));
    supersededRequirements = dedupeItems([...supersededRequirements, ...moved]).slice(-24);
    activeRequirements = activeRequirements.filter((item) => !supersededTexts.has(normalizeText(item.text)));
  }

  for (const item of patch.activeRequirements ?? []) {
    const text = compactText(item.text);
    if (!text) continue;
    const conflicting = activeRequirements.filter((existing) => requirementsConflict(existing.text, text));
    if (conflicting.length) {
      supersededRequirements = dedupeItems([...supersededRequirements, ...conflicting.map((entry) => ({ ...entry, status: 'superseded' as const, updatedAt: now }))]).slice(-24);
      activeRequirements = activeRequirements.filter((entry) => !conflicting.some((conflict) => conflict.id === entry.id));
      unresolvedConflicts = removeConflictsForRequirements(unresolvedConflicts, conflicting.map((entry) => entry.text));
    }
    activeRequirements = upsertItem(activeRequirements, {
      id: newId('brief_item'),
      kind: item.kind,
      text,
      status: 'active',
      contextKind,
      sourceMessageId,
      createdAt: now,
      updatedAt: now,
    }).slice(-24);
  }

  for (const conflict of patch.conflicts ?? []) {
    unresolvedConflicts = addConflict(unresolvedConflicts, conflict.text, conflict.requirements, sourceMessageId, now);
  }

  const evidenceNotes = dedupeItems([
    ...normalizeItems(current.evidenceNotes),
    ...(patch.evidenceNotes ?? []).map((text) => createBriefItem('evidence', text, 'task-card', sourceMessageId, now)),
  ]).slice(-12);

  const recentUserIntents = dedupeItems([
    ...normalizeItems(current.recentUserIntents),
    ...(patch.recentUserIntents ?? []).map((text) => createBriefItem('intent', text, contextKind, sourceMessageId, now)),
  ]).slice(-8);

  return normalizeBrief({
    ...current,
    activeRequirements: dedupeItems(activeRequirements).slice(-24),
    evidenceNotes,
    recentUserIntents,
    unresolvedConflicts: unresolvedConflicts.slice(-8),
    supersededRequirements: dedupeItems(supersededRequirements).slice(-24),
    updatedAt: now,
  });
}

function createBriefItem(kind: DialogueBriefItem['kind'], text: string, contextKind: DialogueContextKind, sourceMessageId: string | undefined, now: string): DialogueBriefItem {
  return {
    id: newId('brief_item'),
    kind,
    text: compactText(text),
    status: 'active',
    contextKind,
    sourceMessageId,
    createdAt: now,
    updatedAt: now,
  };
}

function upsertItem(items: DialogueBriefItem[], next: DialogueBriefItem): DialogueBriefItem[] {
  const normalized = normalizeText(next.text);
  const existing = items.find((item) => normalizeText(item.text) === normalized);
  if (!existing) return [...items, next];
  return items.map((item) => item.id === existing.id ? { ...item, ...next, id: item.id, createdAt: item.createdAt } : item);
}

function addConflict(items: DialogueBriefConflict[], text: string, requirements: string[], sourceMessageId: string | undefined, now: string): DialogueBriefConflict[] {
  const compactRequirements = [...new Set(requirements.map((item) => compactText(item, 120)).filter(Boolean))];
  if (compactRequirements.length < 2) return items;
  const normalized = normalizeText(compactRequirements.join('|'));
  if (items.some((item) => normalizeText(item.requirements.join('|')) === normalized)) return items;
  return [...items, {
    id: newId('brief_conflict'),
    text: compactText(text),
    requirements: compactRequirements,
    sourceMessageIds: sourceMessageId ? [sourceMessageId] : [],
    createdAt: now,
    updatedAt: now,
  }];
}

function removeConflictsForRequirements(items: DialogueBriefConflict[], requirements: string[]): DialogueBriefConflict[] {
  const resolved = new Set(requirements.map(normalizeText).filter(Boolean));
  if (!resolved.size) return items;
  return items.filter((item) => !item.requirements.some((requirement) => resolved.has(normalizeText(requirement))));
}

function normalizeBrief(brief: DialogueBrief): DialogueBrief {
  return {
    ...brief,
    activeRequirements: normalizeItems(brief.activeRequirements).filter((item) => item.status === 'active'),
    evidenceNotes: normalizeItems(brief.evidenceNotes),
    recentUserIntents: normalizeItems(brief.recentUserIntents),
    unresolvedConflicts: normalizeConflicts(brief.unresolvedConflicts),
    supersededRequirements: normalizeItems(brief.supersededRequirements).map((item): DialogueBriefItem => ({ ...item, status: 'superseded' })),
  };
}

function normalizeItems(items: DialogueBriefItem[] | undefined): DialogueBriefItem[] {
  return dedupeItems((items ?? []).map((item): DialogueBriefItem => ({
    ...item,
    text: compactText(item.text),
    status: item.status === 'superseded' ? 'superseded' : 'active',
  })).filter((item) => item.text));
}

function normalizeConflicts(items: DialogueBriefConflict[] | undefined): DialogueBriefConflict[] {
  return (items ?? []).map((item) => ({
    ...item,
    text: compactText(item.text),
    requirements: item.requirements.map((entry) => compactText(entry, 120)).filter(Boolean),
    sourceMessageIds: item.sourceMessageIds ?? [],
  })).filter((item) => item.text && item.requirements.length >= 2);
}

function dedupeItems(items: DialogueBriefItem[]): DialogueBriefItem[] {
  const seen = new Set<string>();
  const result: DialogueBriefItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${normalizeText(item.text)}:${item.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function compactBriefItem(item: DialogueBriefItem): DialogueBriefItem {
  return { ...item, text: compactText(item.text), sourceMessageId: item.sourceMessageId };
}

function requirementsConflict(left: string, right: string): boolean {
  if (polarity(left) === polarity(right)) return false;
  const leftTerms = requirementTerms(left);
  const rightTerms = requirementTerms(right);
  return leftTerms.some((term) => rightTerms.includes(term));
}

function polarity(text: string): 'negative' | 'positive' {
  return /(不要|避免|别|不写|去掉|移除|不得|禁止)/.test(text) ? 'negative' : 'positive';
}

function requirementTerms(text: string): string[] {
  return [...new Set(text
    .replace(/不要|避免|别|不写|去掉|移除|不得|禁止|需要|必须|重点|包含|加入|补充|写入|纳入|关于|可以|但是|然后|以及|还有|故事情节|要求|内容/g, ' ')
    .split(/[\s，,。.!！?？、；;：:《》“”"']+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 12))];
}

function normalizeText(value: string): string {
  return compactText(value).replace(/\s+/g, '').toLowerCase();
}

function compactText(value: string, limit = 160): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isStaleRunningJob(job: DialogueBriefUpdateJob): boolean {
  const startedAt = Date.parse(job.startedAt ?? job.updatedAt ?? job.createdAt);
  return !Number.isFinite(startedAt) || Date.now() - startedAt > maxBriefJobRunningMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
