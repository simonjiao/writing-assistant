export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  raw?: unknown;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  json<T>(request: ChatRequest): Promise<T>;
  stream?(request: ChatRequest): AsyncIterable<ChatResponse>;
}

export type ArticleType = 'essay' | 'analysis' | 'commentary' | 'speech' | 'longform';

export interface TaskCardFollowUpPrompt {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
}

export interface WritingTaskCard {
  id: string;
  topic: string;
  writingGoal: string;
  audience: string;
  topRules?: { languageEra?: string; summary?: string; writingStandards: string[]; replacementHints?: Array<{ avoid: string; prefer: string }> };
  scope: { editions?: string[]; chapters?: string[]; characters?: string[]; themes?: string[] };
  structure: { articleType: ArticleType; expectedLength: string; outlinePreference?: string };
  style: { register: string; tone: string; classicalFlavor: boolean; characterVoice?: string };
  constraints: { mustInclude: string[]; mustAvoid: string[]; citationRequired: boolean; sourcePolicy: string };
  interactionMode: { askBeforeWriting: boolean; localEditFirst: boolean; followUpQuestions?: string[]; followUpPrompts?: TaskCardFollowUpPrompt[] };
  status: 'draft' | 'confirmed';
  createdAt: string;
  updatedAt: string;
}

export type OutlineRhetoricalRole = 'opening' | 'development' | 'turn' | 'conclusion';

export interface OutlineItem {
  id: string;
  title: string;
  goal: string;
  order: number;
  expectedBlocks: number;
  rhetoricalRole?: OutlineRhetoricalRole;
  keySection?: boolean;
  specialHandling?: string[];
  sourceHints: string[];
  themeTags: string[];
  status: 'draft' | 'confirmed' | 'written';
}

export type ArticleBlockType = 'title' | 'section' | 'paragraph' | 'quote' | 'note';

export interface ArticleBlock {
  id: string;
  type: ArticleBlockType;
  sectionId?: string;
  title?: string;
  text: string;
  sourceRefs: string[];
  themeTags: string[];
  status: 'draft' | 'reviewed' | 'needs_revision';
  createdAt: string;
  updatedAt: string;
}

export interface Citation { id: string; label: string; sourceRef: string; note?: string }
export interface ThemeTag { id: string; label: string; scope: 'article' | 'section' | 'paragraph'; targetId?: string }

export type ArticleCommentStatus = 'open' | 'resolved' | 'needs_input';
export type ArticleCommentResolutionKind = 'revision' | 'explanation' | 'question';

export interface ArticleCommentReply {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface ArticleComment {
  id: string;
  articleId: string;
  blockId: string;
  selectedText: string;
  comment: string;
  selectionStart?: number;
  selectionEnd?: number;
  status: ArticleCommentStatus;
  resolutionKind?: ArticleCommentResolutionKind;
  response?: string;
  replacementText?: string;
  replies?: ArticleCommentReply[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface ArticleVersion {
  id: string;
  reason: string;
  author: 'user' | 'agent' | 'system';
  snapshot: { taskCard?: WritingTaskCard; outline: OutlineItem[]; blocks: ArticleBlock[]; citations: Citation[]; themeTags: ThemeTag[]; comments?: ArticleComment[] };
  createdAt: string;
}

export interface ArticleArtifact {
  id: string;
  userId: string;
  workspaceId: string;
  revision: number;
  title: string;
  taskCard?: WritingTaskCard;
  outline: OutlineItem[];
  blocks: ArticleBlock[];
  citations: Citation[];
  themeTags: ThemeTag[];
  comments?: ArticleComment[];
  versions: ArticleVersion[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ArticleRevisionWrite {
  article: ArticleArtifact;
  baseRevision: number;
  operationId: string;
}

export interface WritingWorkspace {
  id: string;
  userId: string;
  memberUserIds: string[];
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TextPatch {
  id: string;
  articleId: string;
  blockId: string;
  before: string;
  after: string;
  instruction: string;
  affectedBlockIds: string[];
  requiresScopeExpansion: boolean;
  changeSummary: string[];
  createdAt: string;
}

export type DialogueContextKind = 'task-card' | 'outline' | 'outline-item' | 'block';
export type PiAgentSessionContextKind = DialogueContextKind | 'workflow' | 'article-review';

export type RevisionOperation =
  | { type: 'revise-task-card'; instruction: string }
  | { type: 'revise-outline'; instruction: string }
  | { type: 'revise-outline-item'; outlineItemId: string; instruction: string }
  | { type: 'patch-block'; blockId: string; instruction: string };

export interface RevisionProposal {
  id: string;
  articleId: string;
  userId: string;
  runId?: string;
  authorUserId?: string;
  baseRevision?: number;
  contextKind: DialogueContextKind;
  summary: string;
  message: string;
  operations: RevisionOperation[];
  warnings: string[];
  status: 'pending' | 'applied' | 'dismissed';
  createdAt: string;
  updatedAt: string;
}

export interface DialogueMessage {
  id: string;
  articleId: string;
  userId: string;
  contextKind: DialogueContextKind;
  role: 'user' | 'assistant';
  content: string;
  proposalId?: string;
  createdAt: string;
}

export type DialogueBriefItemKind = 'requirement' | 'avoidance' | 'source' | 'preference' | 'revision' | 'evidence' | 'intent';
export type DialogueBriefItemStatus = 'active' | 'superseded';

export interface DialogueBriefItem {
  id: string;
  kind: DialogueBriefItemKind;
  text: string;
  status: DialogueBriefItemStatus;
  contextKind?: DialogueContextKind;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DialogueBriefConflict {
  id: string;
  text: string;
  requirements: string[];
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DialogueBrief {
  id: string;
  articleId: string;
  userId: string;
  activeRequirements: DialogueBriefItem[];
  evidenceNotes: DialogueBriefItem[];
  recentUserIntents: DialogueBriefItem[];
  unresolvedConflicts: DialogueBriefConflict[];
  supersededRequirements: DialogueBriefItem[];
  createdAt: string;
  updatedAt: string;
}

export type DialogueBriefUpdateJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface DialogueBriefUpdateJob {
  id: string;
  articleId: string;
  userId: string;
  messageId: string;
  messageContent: string;
  contextKind: DialogueContextKind;
  contextTitle: string;
  status: DialogueBriefUpdateJobStatus;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Session {
  id: string;
  userId: string;
  currentArticleId?: string;
  currentBlockId?: string;
  currentRunId?: string;
  currentWorkspaceId?: string;
  panelScope: 'article' | 'section' | 'paragraph';
  createdAt: string;
  updatedAt: string;
}

export interface UserWritingProfile {
  userId: string;
  stylePreferences: string[];
  structurePreferences: string[];
  editPreferences: string[];
  memoryNotes: string[];
  updatedAt: string;
}

export interface KnowledgeItem {
  id: string;
  title: string;
  content: string;
  sourceType: 'note' | 'book' | 'web' | 'file' | 'manual' | 'retriever';
  sourceRef: string;
  themeTags: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PiAgentSession {
  id: string;
  runId?: string;
  userId: string;
  workspaceId?: string;
  articleId?: string;
  contextKind: PiAgentSessionContextKind;
  targetId?: string;
  messages: JsonValue[];
  compactSummary?: string;
  toolTraceSummary?: string;
  pendingHumanGateId?: string;
  baseArticleRevision?: number;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type HumanGateTargetKind = 'task-card' | 'outline' | 'outline-item' | 'block' | 'article';
export type HumanGateStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface HumanGateOption {
  id: string;
  label: string;
  payload?: JsonValue;
}

export interface HumanGate {
  id: string;
  runId: string;
  userId: string;
  articleId?: string;
  actionType: string;
  targetKind: HumanGateTargetKind;
  targetId?: string;
  proposalId?: string;
  question: string;
  options: HumanGateOption[];
  baseRevision?: number;
  status: HumanGateStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedByUserId?: string;
}

export type WorkflowOperationStatus = 'running' | 'completed' | 'failed';

export interface WorkflowOperation {
  operationId: string;
  runId: string;
  userId: string;
  articleId?: string;
  toolName: string;
  allowedActionId: string;
  argsHash: string;
  status: WorkflowOperationStatus;
  resultRef?: string;
  error?: string;
  articleRevisionBefore?: number;
  articleRevisionAfter?: number;
  createdAt: string;
  updatedAt: string;
}

export type ReviewArtifactType = 'consistency-review' | 'polish-report';
export type ReviewFindingSeverity = 'info' | 'warning' | 'blocking';

export interface ReviewFinding {
  severity: ReviewFindingSeverity;
  targetKind: string;
  targetId?: string;
  message: string;
}

export interface ReviewSuggestion {
  id: string;
  actionType: string;
  targetKind: string;
  targetId?: string;
  summary: string;
}

export interface ReviewArtifact {
  id: string;
  articleId: string;
  runId: string;
  type: ReviewArtifactType;
  baseRevision: number;
  findings: ReviewFinding[];
  suggestions: ReviewSuggestion[];
  createdAt: string;
  updatedAt: string;
}

export type AllowedActionType =
  | 'create_task_card_draft'
  | 'ask_followup'
  | 'plan_outline'
  | 'review_task_card_outline_consistency'
  | 'write_next_section'
  | 'write_section'
  | 'process_article_comments'
  | 'generate_polish_report'
  | 'create_revision_proposal'
  | 'request_human_gate';

export interface AllowedAction {
  id: string;
  operationId: string;
  type: AllowedActionType;
  articleId?: string;
  sectionId?: string;
  reviewArtifactId?: string;
  suggestionId?: string;
  targetKind?: string;
  targetId?: string;
  baseRevision?: number;
  requiresHumanGate: boolean;
  reason: string;
}

export interface AgentDecision {
  intent: string;
  selectedActionId?: string;
  rationale: string;
  requiresHumanGate: boolean;
  stopReason?: 'completed' | 'waiting' | 'blocked' | 'failed';
}

export interface WorkflowPolicy {
  id: string;
  goal: string;
  allowedActionPolicy: string;
  humanGatePolicy: string;
  completionPolicy: string;
}

export type WorkflowStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  input: unknown;
  state: Record<string, unknown>;
  metadata: { userId: string; sessionId?: string; articleId?: string; [key: string]: unknown };
  waitingFor?: { nodeId: string; reason: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentEventType =
  | 'workflow.started'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.waiting'
  | 'workflow.operation.started'
  | 'workflow.operation.completed'
  | 'workflow.operation.failed'
  | 'skill.started'
  | 'skill.completed'
  | 'artifact.updated'
  | 'pi.session.created'
  | 'pi.session.updated'
  | 'agent.decision'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'human_gate.created'
  | 'human_gate.resolved'
  | 'review_artifact.created'
  | 'revision_proposal.created'
  | 'revision_proposal.resolved'
  | 'dialogue.brief.updated'
  | 'dialogue.brief.failed'
  | 'realtime.client.connected'
  | 'realtime.client.disconnected'
  | 'rag.http.started'
  | 'rag.http.completed'
  | 'rag.http.failed';

export interface AgentEvent {
  id: string;
  runId?: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}
