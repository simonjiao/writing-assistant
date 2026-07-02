import {
  AgentEvent,
  ArticleArtifact,
  ArticleVersion,
  KnowledgeItem,
  Session,
  TextPatch,
  UserWritingProfile,
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
  createArticle(input: { userId: string; title: string; taskCard?: ArticleArtifact['taskCard'] }): Promise<ArticleArtifact>;
  getArticle(articleId: string): Promise<ArticleArtifact | undefined>;
  listArticles(userId: string): Promise<ArticleArtifact[]>;
  updateArticle(article: ArticleArtifact): Promise<ArticleArtifact>;
  commitVersion(articleId: string, reason: string, author: ArticleVersion['author']): Promise<ArticleVersion>;
  applyPatch(patch: TextPatch): Promise<ArticleArtifact>;
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
  artifactStore: ArtifactStore;
  knowledgeStore: KnowledgeStore;
  eventTraceStore: EventTraceStore;
}
