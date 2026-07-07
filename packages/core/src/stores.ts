import {
  AgentEvent,
  ArticleArtifact,
  ArticleVersion,
  DialogueBrief,
  DialogueBriefUpdateJob,
  DialogueBriefUpdateJobStatus,
  DialogueMessage,
  HumanGate,
  HumanGateStatus,
  KnowledgeItem,
  PiAgentSession,
  PiAgentSessionContextKind,
  ReviewArtifact,
  RevisionProposal,
  Session,
  TextPatch,
  UserWritingProfile,
  WritingWorkspace,
  WorkflowOperation,
  WorkflowOperationStatus,
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

export interface PiAgentSessionStore {
  saveSession(session: PiAgentSession): Promise<PiAgentSession>;
  getSession(sessionId: string): Promise<PiAgentSession | undefined>;
  getWorkflowSession(runId: string): Promise<PiAgentSession | undefined>;
  findSession(filter: { userId: string; articleId?: string; contextKind: PiAgentSessionContextKind; targetId?: string; runId?: string }): Promise<PiAgentSession | undefined>;
  listSessions(filter?: { userId?: string; articleId?: string; contextKind?: PiAgentSessionContextKind; runId?: string }): Promise<PiAgentSession[]>;
  updateSession(sessionId: string, patch: Partial<PiAgentSession>): Promise<PiAgentSession>;
}

export interface HumanGateStore {
  createGate(input: Omit<HumanGate, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { id?: string; status?: HumanGateStatus }): Promise<HumanGate>;
  getGate(gateId: string): Promise<HumanGate | undefined>;
  listGates(filter?: { runId?: string; articleId?: string; userId?: string; statuses?: HumanGateStatus[] }): Promise<HumanGate[]>;
  updateGate(gate: HumanGate): Promise<HumanGate>;
}

export interface WorkflowOperationStore {
  startOperation(input: Omit<WorkflowOperation, 'status' | 'createdAt' | 'updatedAt'>): Promise<WorkflowOperation>;
  getOperation(operationId: string): Promise<WorkflowOperation | undefined>;
  listOperations(filter?: { runId?: string; articleId?: string; userId?: string; statuses?: WorkflowOperationStatus[] }): Promise<WorkflowOperation[]>;
  updateOperation(operation: WorkflowOperation): Promise<WorkflowOperation>;
}

export interface ReviewArtifactStore {
  createReviewArtifact(input: Omit<ReviewArtifact, 'id' | 'createdAt' | 'updatedAt'>): Promise<ReviewArtifact>;
  getReviewArtifact(reviewArtifactId: string): Promise<ReviewArtifact | undefined>;
  listReviewArtifacts(filter?: { runId?: string; articleId?: string; type?: ReviewArtifact['type'] }): Promise<ReviewArtifact[]>;
  updateReviewArtifact(reviewArtifact: ReviewArtifact): Promise<ReviewArtifact>;
}

export interface RevisionProposalStore {
  createProposal(input: Omit<RevisionProposal, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Promise<RevisionProposal>;
  getProposal(proposalId: string): Promise<RevisionProposal | undefined>;
  listPendingProposals(articleId: string, userId: string): Promise<RevisionProposal[]>;
  updateProposal(proposal: RevisionProposal): Promise<RevisionProposal>;
}

export interface DialogueMessageStore {
  createMessage(input: Omit<DialogueMessage, 'id' | 'createdAt'>): Promise<DialogueMessage>;
  listMessages(articleId: string, userId: string, options?: { limit?: number }): Promise<DialogueMessage[]>;
}

export interface DialogueBriefStore {
  getBrief(articleId: string, userId: string): Promise<DialogueBrief | undefined>;
  saveBrief(brief: DialogueBrief): Promise<DialogueBrief>;
}

export interface DialogueBriefUpdateJobStore {
  createJob(input: Omit<DialogueBriefUpdateJob, 'id' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>): Promise<DialogueBriefUpdateJob>;
  getJob(jobId: string): Promise<DialogueBriefUpdateJob | undefined>;
  listJobs(articleId: string, userId: string, options?: { statuses?: DialogueBriefUpdateJobStatus[]; limit?: number }): Promise<DialogueBriefUpdateJob[]>;
  updateJob(job: DialogueBriefUpdateJob): Promise<DialogueBriefUpdateJob>;
}

export interface WorkspaceStore {
  createWorkspace(input: { id?: string; userId: string; name: string; isDefault?: boolean; memberUserIds?: string[] }): Promise<WritingWorkspace>;
  getWorkspace(workspaceId: string): Promise<WritingWorkspace | undefined>;
  listWorkspaces(userId: string, options?: { includeDeleted?: boolean }): Promise<WritingWorkspace[]>;
  updateWorkspace(workspace: WritingWorkspace): Promise<WritingWorkspace>;
}

export interface KnowledgeSearchOptions {
  limit?: number;
  themeTags?: string[];
  structuredTerms?: string[];
  requiredEvidenceTypes?: string[];
  routes?: string[];
  keywordQueries?: string[];
  semanticQueries?: string[];
  rerank?: boolean;
}

export interface KnowledgeStore {
  search(query: string, options?: KnowledgeSearchOptions): Promise<KnowledgeItem[]>;
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
  piAgentSessionStore: PiAgentSessionStore;
  humanGateStore: HumanGateStore;
  workflowOperationStore: WorkflowOperationStore;
  reviewArtifactStore: ReviewArtifactStore;
  revisionProposalStore: RevisionProposalStore;
  dialogueMessageStore: DialogueMessageStore;
  dialogueBriefStore: DialogueBriefStore;
  dialogueBriefUpdateJobStore: DialogueBriefUpdateJobStore;
  knowledgeStore: KnowledgeStore;
  eventTraceStore: EventTraceStore;
}
