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

export interface OutlineItem {
  id: string;
  title: string;
  goal: string;
  order: number;
  expectedBlocks: number;
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

export interface ArticleVersion {
  id: string;
  reason: string;
  author: 'user' | 'agent' | 'system';
  snapshot: { taskCard?: WritingTaskCard; outline: OutlineItem[]; blocks: ArticleBlock[]; citations: Citation[]; themeTags: ThemeTag[] };
  createdAt: string;
}

export interface ArticleArtifact {
  id: string;
  userId: string;
  workspaceId: string;
  title: string;
  taskCard?: WritingTaskCard;
  outline: OutlineItem[];
  blocks: ArticleBlock[];
  citations: Citation[];
  themeTags: ThemeTag[];
  versions: ArticleVersion[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
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

export type RevisionOperation =
  | { type: 'revise-task-card'; instruction: string }
  | { type: 'revise-outline'; instruction: string }
  | { type: 'revise-outline-item'; outlineItemId: string; instruction: string }
  | { type: 'patch-block'; blockId: string; instruction: string };

export interface RevisionProposal {
  id: string;
  articleId: string;
  userId: string;
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

export type WorkflowStatus = 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type WorkflowRunHistoryStatus = 'completed' | 'waiting' | 'failed';

export interface WorkflowRunHistoryItem {
  nodeId: string;
  status: WorkflowRunHistoryStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  currentNodeId?: string;
  input: unknown;
  state: Record<string, unknown>;
  metadata: { userId: string; sessionId?: string; articleId?: string; [key: string]: unknown };
  waitingFor?: { nodeId: string; reason: string };
  resumeInput?: unknown;
  history: WorkflowRunHistoryItem[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentEventType =
  | 'workflow.started'
  | 'workflow.queued'
  | 'workflow.resumed'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.waiting'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'skill.started'
  | 'skill.completed'
  | 'artifact.updated'
  | 'review.required'
  | 'queue.enqueued'
  | 'queue.dequeued'
  | 'queue.completed'
  | 'queue.failed'
  | 'runner.started'
  | 'runner.stopped'
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
