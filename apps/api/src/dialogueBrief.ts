import { ArticleArtifact, DialogueBrief, DialogueBriefConflict, DialogueBriefItem, DialogueContextKind, DialogueMessage, KnowledgeItem, newId, nowIso } from '@wa/core';
import { DialogueBriefUpdaterInput, DialogueBriefUpdaterOutput } from '@wa/skills';
import type { AppContainer } from './bootstrap';

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
  const currentBrief = await getOrCreateDialogueBrief(input.container, input.article.id, input.userId);
  try {
    const patch = await input.container.runtime.invokeSkill<DialogueBriefUpdaterInput, DialogueBriefUpdaterOutput>(
      'dialogue-brief-updater',
      {
        message: input.message.content,
        context: input.context,
        currentBrief: compactDialogueBriefForPrompt(currentBrief),
        skipKnowledge: true,
      },
      { userId: input.userId, sessionId: input.sessionId, articleId: input.article.id },
    );
    const merged = mergeDialogueBrief(currentBrief, patch, input.context.kind, input.message.id);
    return input.container.stores.dialogueBriefStore.saveBrief(merged);
  } catch {
    const merged = mergeDialogueBrief(currentBrief, fallbackBriefPatch(input.message.content), input.context.kind, input.message.id);
    return input.container.stores.dialogueBriefStore.saveBrief(merged);
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

function fallbackBriefPatch(message: string): DialogueBriefUpdaterOutput {
  const item = fallbackBriefItem(message);
  return {
    activeRequirements: item ? [item] : [],
    evidenceNotes: [],
    recentUserIntents: message.trim() ? [message] : [],
    supersededRequirements: [],
    conflicts: [],
  };
}

function fallbackBriefItem(message: string): DialogueBriefUpdaterOutput['activeRequirements'][number] | undefined {
  if (!/(改|修改|调整|删|删除|加|添加|新增|重写|扩写|压缩|不要|避免|改成|改为|换成|补充|合并|拆分|包含|纳入|加入|写进|放进|体现|保留|漏掉|遗漏|参考|使用|采用|沿用|突出|强调|弱化|去掉|移除|需要|必须|重点|资料|引用|来源|脂批|批语)/.test(message)) return undefined;
  const kind = /(不要|避免|别|不写|去掉|移除)/.test(message) ? 'avoidance' : (/(资料|引用|来源|参考|脂批|批语)/.test(message) ? 'source' : 'requirement');
  return { kind, text: compactText(message) };
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
