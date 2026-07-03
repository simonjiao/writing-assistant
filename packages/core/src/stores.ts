import {
  AgentEvent,
  ArticleArtifact,
  ArticleVersion,
  KnowledgeItem,
  Session,
  TextPatch,
  UserWritingProfile,
  WritingWorkspace,
  WorkflowRun,
} from './types';

export interface StateStore {
  saveRun(run: WorkflowRun): Promise<WorkflowRun>;
  getRun(runId: string): Promise<WorkflowRun | undefined>;
  updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<WorkflowRun>;
  listRuns(filter?: { userId?: string; workflowId?: string }): Promise<WorkflowRun[]>;
}

export interface SessionStore {
  createSession(userId: string): Promise<Session>;
  getSession(sessionId: string): Promise<Session | undefined>;
  updateSession(sessionId: string, patch: Partial<Session>): Promise<Session>;
}

export interface MemoryStore {
  getUserProfile(userId: string): Promise<UserWritingProfile>;
  updateUserProfile(userId: string, patch: Partial<UserWritingProfile>): Promise<UserWritingProfile>;
}

export interface ArtifactStore {
  createArticle(input: { userId: string; workspaceId: string; title: string; taskCard?: ArticleArtifact['taskCard'] }): Promise<ArticleArtifact>;
  getArticle(articleId: string): Promise<ArticleArtifact | undefined>;
  listArticles(workspaceId: string, options?: { includeDeleted?: boolean }): Promise<ArticleArtifact[]>;
  updateArticle(article: ArticleArtifact): Promise<ArticleArtifact>;
  deleteArticle(articleId: string): Promise<ArticleArtifact>;
  commitVersion(articleId: string, reason: string, author: ArticleVersion['author']): Promise<ArticleVersion>;
  applyPatch(patch: TextPatch): Promise<ArticleArtifact>;
}

export interface WorkspaceStore {
  createWorkspace(input: { id?: string; userId: string; name: string; isDefault?: boolean; memberUserIds?: string[] }): Promise<WritingWorkspace>;
  getWorkspace(workspaceId: string): Promise<WritingWorkspace | undefined>;
  listWorkspaces(userId: string, options?: { includeDeleted?: boolean }): Promise<WritingWorkspace[]>;
  updateWorkspace(workspace: WritingWorkspace): Promise<WritingWorkspace>;
}

export interface KnowledgeStore {
  search(query: string, options?: { limit?: number; themeTags?: string[] }): Promise<KnowledgeItem[]>;
  listByRefs(sourceRefs: string[]): Promise<KnowledgeItem[]>;
}

export interface EventTraceStore {
  append(event: AgentEvent): Promise<void>;
  listByRun(runId: string): Promise<AgentEvent[]>;
}

export interface ExternalStores {
  stateStore: StateStore;
  sessionStore: SessionStore;
  memoryStore: MemoryStore;
  workspaceStore: WorkspaceStore;
  artifactStore: ArtifactStore;
  knowledgeStore: KnowledgeStore;
  eventTraceStore: EventTraceStore;
}
