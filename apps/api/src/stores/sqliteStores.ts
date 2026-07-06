import { join } from 'node:path';
import { AgentEvent, ArticleArtifact, ArticleVersion, ArtifactStore, DialogueBrief, DialogueBriefStore, DialogueBriefUpdateJob, DialogueBriefUpdateJobStore, DialogueMessage, DialogueMessageStore, EventTraceStore, KnowledgeItem, KnowledgeSearchOptions, KnowledgeStore, MemoryStore, newId, nowIso, RevisionProposal, RevisionProposalStore, Session, SessionStore, StateStore, TextPatch, UserWritingProfile, WorkspaceStore, WritingWorkspace, WorkflowRun } from '@wa/core';
import knowledgeSeedRules from '../rules/knowledge-seeds.json';
import { SqliteJsonDb } from './sqliteJsonDb';

function dbPath(dataDir: string) { return join(dataDir, 'writing-assistant.sqlite'); }

export class SqliteStateStore implements StateStore {
  private readonly db: SqliteJsonDb<WorkflowRun>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'runs'); }
  saveRun(run: WorkflowRun) { return this.db.upsert({ ...run, updatedAt: nowIso() }); }
  getRun(runId: string) { return this.db.get(runId); }
  updateRun(runId: string, patch: Partial<WorkflowRun>) { return this.db.update(runId, { ...patch, updatedAt: nowIso() }); }
  async listRuns(filter?: { userId?: string; workflowId?: string }) { const runs = await this.db.list(); return runs.filter((run) => (!filter?.userId || run.metadata.userId === filter.userId) && (!filter?.workflowId || run.workflowId === filter.workflowId)); }
  close() { this.db.close(); }
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: SqliteJsonDb<Session>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'sessions'); }
  async createSession(userId: string) { const now = nowIso(); return this.db.upsert({ id: newId('ses'), userId, panelScope: 'article', createdAt: now, updatedAt: now }); }
  getSession(sessionId: string) { return this.db.get(sessionId); }
  updateSession(sessionId: string, patch: Partial<Session>) { return this.db.update(sessionId, { ...patch, updatedAt: nowIso() }); }
  close() { this.db.close(); }
}

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: SqliteJsonDb<UserWritingProfile & { id: string }>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'memory'); }
  async getUserProfile(userId: string) { const existing = await this.db.get(userId); if (existing) return existing; const profile: UserWritingProfile = { userId, stylePreferences: ['表达清楚，避免空泛套话'], structurePreferences: ['先确认任务卡，再生成大纲和正文'], editPreferences: ['默认局部修改，不默认全文重写'], memoryNotes: [], updatedAt: nowIso() }; await this.db.upsert({ ...profile, id: userId }); return profile; }
  async updateUserProfile(userId: string, patch: Partial<UserWritingProfile>) { const current = await this.getUserProfile(userId); const updated = { ...current, ...patch, userId, updatedAt: nowIso() }; await this.db.upsert({ ...updated, id: userId }); return updated; }
  close() { this.db.close(); }
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly db: SqliteJsonDb<WritingWorkspace>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'workspaces'); }
  async createWorkspace(input: { id?: string; userId: string; name: string; isDefault?: boolean; memberUserIds?: string[] }) { const now = nowIso(); return this.db.upsert({ id: input.id ?? newId('wsp'), userId: input.userId, memberUserIds: [...new Set(input.memberUserIds ?? [])], name: input.name, isDefault: input.isDefault ?? false, createdAt: now, updatedAt: now }); }
  async getWorkspace(workspaceId: string) { const workspace = await this.db.get(workspaceId); return workspace?.deletedAt ? undefined : workspace; }
  async listWorkspaces(userId: string, options?: { includeDeleted?: boolean }) { return (await this.db.list()).filter((workspace) => (workspace.userId === userId || workspace.memberUserIds?.includes(userId)) && (options?.includeDeleted || !workspace.deletedAt)); }
  updateWorkspace(workspace: WritingWorkspace) { return this.db.upsert({ ...workspace, updatedAt: nowIso() }); }
  close() { this.db.close(); }
}

export class SqliteArtifactStore implements ArtifactStore {
  private readonly db: SqliteJsonDb<ArticleArtifact>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'artifacts'); }
  async createArticle(input: { userId: string; workspaceId: string; title: string; taskCard?: ArticleArtifact['taskCard'] }) { const now = nowIso(); const article: ArticleArtifact = { id: newId('art'), userId: input.userId, workspaceId: input.workspaceId, title: input.title, taskCard: input.taskCard, outline: [], blocks: [], citations: [], themeTags: [], comments: [], versions: [], createdAt: now, updatedAt: now }; await this.db.upsert(article); await this.commitVersion(article.id, '创建文章草稿', 'agent'); return (await this.getArticle(article.id)) as ArticleArtifact; }
  async getArticle(articleId: string) { const article = await this.db.get(articleId); if (!article || article.deletedAt) return undefined; return normalizeArticle(article); }
  async listArticles(workspaceId: string, options?: { includeDeleted?: boolean }) { return (await this.db.list()).filter((article) => article.workspaceId === workspaceId && (options?.includeDeleted || !article.deletedAt)).map(normalizeArticle); }
  updateArticle(article: ArticleArtifact) { return this.db.upsert({ ...normalizeArticle(article), updatedAt: nowIso() }); }
  async deleteArticle(articleId: string) { const article = await this.db.get(articleId); if (!article) throw new Error(`Article not found: ${articleId}`); const deleted = { ...article, deletedAt: article.deletedAt ?? nowIso(), updatedAt: nowIso() }; await this.db.upsert(deleted); return deleted; }
  async commitVersion(articleId: string, reason: string, author: ArticleVersion['author']) { const article = await this.getArticle(articleId); if (!article) throw new Error(`Article not found: ${articleId}`); const version: ArticleVersion = { id: newId('ver'), reason, author, snapshot: { taskCard: article.taskCard, outline: article.outline, blocks: article.blocks, citations: article.citations, themeTags: article.themeTags, comments: article.comments ?? [] }, createdAt: nowIso() }; article.versions = [...article.versions, version]; article.updatedAt = nowIso(); await this.db.upsert(article); return version; }
  async applyPatch(patch: TextPatch) { const article = await this.getArticle(patch.articleId); if (!article) throw new Error(`Article not found: ${patch.articleId}`); article.blocks = article.blocks.map((block) => block.id === patch.blockId ? { ...block, text: patch.after, updatedAt: nowIso(), status: 'draft' } : block); article.updatedAt = nowIso(); await this.db.upsert(article); await this.commitVersion(article.id, `应用局部修改：${patch.instruction}`, 'agent'); return (await this.getArticle(article.id)) as ArticleArtifact; }
  close() { this.db.close(); }
}

function normalizeArticle(article: ArticleArtifact): ArticleArtifact {
  return { ...article, comments: article.comments ?? [] };
}

export class SqliteRevisionProposalStore implements RevisionProposalStore {
  private readonly db: SqliteJsonDb<RevisionProposal>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'revision_proposals'); }
  createProposal(input: Omit<RevisionProposal, 'id' | 'status' | 'createdAt' | 'updatedAt'>) { const now = nowIso(); return this.db.upsert({ ...input, id: newId('prop'), status: 'pending', createdAt: now, updatedAt: now }); }
  getProposal(proposalId: string) { return this.db.get(proposalId); }
  async listPendingProposals(articleId: string, userId: string) { return (await this.db.list()).filter((proposal) => proposal.articleId === articleId && proposal.userId === userId && proposal.status === 'pending'); }
  updateProposal(proposal: RevisionProposal) { return this.db.upsert({ ...proposal, updatedAt: nowIso() }); }
  close() { this.db.close(); }
}

export class SqliteDialogueMessageStore implements DialogueMessageStore {
  private readonly db: SqliteJsonDb<DialogueMessage>;
  private lastCreatedAtMs = 0;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'dialogue_messages'); }
  createMessage(input: Omit<DialogueMessage, 'id' | 'createdAt'>) {
    const nowMs = Date.now();
    const createdAtMs = nowMs <= this.lastCreatedAtMs ? this.lastCreatedAtMs + 1 : nowMs;
    this.lastCreatedAtMs = createdAtMs;
    return this.db.upsert({ ...input, id: newId('msg'), createdAt: new Date(createdAtMs).toISOString() });
  }
  async listMessages(articleId: string, userId: string, options?: { limit?: number }) {
    const messages = (await this.db.list()).filter((message) => message.articleId === articleId && message.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return options?.limit ? messages.slice(-options.limit) : messages;
  }
  close() { this.db.close(); }
}

export class SqliteDialogueBriefStore implements DialogueBriefStore {
  private readonly db: SqliteJsonDb<DialogueBrief>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'dialogue_briefs'); }
  getBrief(articleId: string, userId: string) { return this.db.get(dialogueBriefId(articleId, userId)); }
  saveBrief(brief: DialogueBrief) { return this.db.upsert({ ...brief, id: dialogueBriefId(brief.articleId, brief.userId), updatedAt: nowIso() }); }
  close() { this.db.close(); }
}

export class SqliteDialogueBriefUpdateJobStore implements DialogueBriefUpdateJobStore {
  private readonly db: SqliteJsonDb<DialogueBriefUpdateJob>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'dialogue_brief_update_jobs'); }
  createJob(input: Omit<DialogueBriefUpdateJob, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>) {
    const now = nowIso();
    return this.db.upsert({ ...input, id: newId('brief_job'), status: 'pending', attempts: 0, createdAt: now, updatedAt: now });
  }
  getJob(jobId: string) { return this.db.get(jobId); }
  async listJobs(articleId: string, userId: string, options?: { statuses?: DialogueBriefUpdateJob['status'][]; limit?: number }) {
    const statuses = options?.statuses ? new Set(options.statuses) : undefined;
    const jobs = (await this.db.list())
      .filter((job) => job.articleId === articleId && job.userId === userId && (!statuses || statuses.has(job.status)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return options?.limit ? jobs.slice(-options.limit) : jobs;
  }
  updateJob(job: DialogueBriefUpdateJob) { return this.db.upsert({ ...job, updatedAt: nowIso() }); }
  close() { this.db.close(); }
}

export class SqliteKnowledgeStore implements KnowledgeStore {
  private readonly db: SqliteJsonDb<KnowledgeItem>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'knowledge'); }
  async search(query: string, options?: KnowledgeSearchOptions) { await this.seedIfEmpty(); const items = await this.db.list(); const q = query.toLowerCase(); const scored = items.map((item) => { const haystack = `${item.title}\n${item.content}\n${item.themeTags.join(' ')}`.toLowerCase(); const tagScore = options?.themeTags?.some((tag) => item.themeTags.includes(tag)) ? 2 : 0; const textScore = q.split(/\s+/).filter(Boolean).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0); return { item, score: tagScore + textScore }; }).sort((a, b) => b.score - a.score); return scored.slice(0, options?.limit ?? 6).map((entry) => entry.item); }
  async listByRefs(sourceRefs: string[]) { await this.seedIfEmpty(); const refs = new Set(sourceRefs); return (await this.db.list()).filter((item) => refs.has(item.sourceRef)); }
  private async seedIfEmpty() { if ((await this.db.list()).length > 0) return; const now = nowIso(); const seeds = knowledgeSeedRules as Array<Omit<KnowledgeItem, 'createdAt'>>; for (const seed of seeds) await this.db.upsert({ ...seed, createdAt: now }); }
  close() { this.db.close(); }
}

function dialogueBriefId(articleId: string, userId: string): string {
  return `brief_${articleId}_${userId}`;
}

export class SqliteEventTraceStore implements EventTraceStore {
  private readonly db: SqliteJsonDb<AgentEvent>;
  constructor(dataDir: string) { this.db = new SqliteJsonDb(dbPath(dataDir), 'events'); }
  append(event: AgentEvent) { return this.db.upsert(event).then(() => undefined); }
  async listByRun(runId: string) { return (await this.db.list()).filter((event) => event.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  close() { this.db.close(); }
}
