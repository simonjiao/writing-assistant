export interface TaskCardFollowUpPrompt { id: string; question: string; options: string[]; allowCustom: boolean }
export interface WritingTaskCard { id: string; topic: string; writingGoal: string; audience: string; topRules?: { languageEra?: string; summary?: string; writingStandards: string[]; replacementHints?: Array<{ avoid: string; prefer: string }> }; scope: { editions?: string[]; chapters?: string[]; characters?: string[]; themes?: string[] }; structure: { articleType: string; expectedLength: string; outlinePreference?: string }; style: { register: string; tone: string; classicalFlavor: boolean; characterVoice?: string }; constraints: { mustInclude: string[]; mustAvoid: string[]; citationRequired: boolean; sourcePolicy: string }; interactionMode: { askBeforeWriting: boolean; localEditFirst: boolean; followUpQuestions?: string[]; followUpPrompts?: TaskCardFollowUpPrompt[] }; status: 'draft' | 'confirmed' }
export type OutlineRhetoricalRole = 'opening' | 'development' | 'turn' | 'conclusion';
export interface OutlineItem { id: string; title: string; goal: string; order: number; expectedBlocks: number; rhetoricalRole?: OutlineRhetoricalRole; keySection?: boolean; specialHandling?: string[]; sourceHints: string[]; themeTags: string[]; status: 'draft' | 'confirmed' | 'written' }
export interface ArticleBlock { id: string; type: string; sectionId?: string; title?: string; text: string; sourceRefs: string[]; themeTags: string[]; status: string }
export type ArticleCommentStatus = 'open' | 'resolved' | 'needs_input';
export type ArticleCommentResolutionKind = 'revision' | 'explanation' | 'question';
export interface ArticleCommentReply { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }
export interface ArticleComment { id: string; articleId: string; blockId: string; selectedText: string; comment: string; selectionStart?: number; selectionEnd?: number; status: ArticleCommentStatus; resolutionKind?: ArticleCommentResolutionKind; response?: string; replacementText?: string; replies?: ArticleCommentReply[]; createdAt: string; updatedAt: string; resolvedAt?: string }
export interface ArticleArtifact { id: string; userId: string; workspaceId: string; revision: number; title: string; taskCard?: WritingTaskCard; outline: OutlineItem[]; blocks: ArticleBlock[]; comments?: ArticleComment[]; versions: Array<{ id: string; reason: string; author: string; createdAt: string }> }
export interface ArticleSummary { id: string; workspaceId: string; title: string; taskStatus?: 'draft' | 'confirmed'; outlineCount: number; blockCount: number; updatedAt: string; deletedAt?: string }
export type DialogueContextKind = 'task-card' | 'outline' | 'outline-item' | 'block';
export type RevisionOperation =
  | { type: 'revise-task-card'; instruction: string }
  | { type: 'revise-outline'; instruction: string }
  | { type: 'revise-outline-item'; outlineItemId: string; instruction: string }
  | { type: 'patch-block'; blockId: string; instruction: string };
export interface RevisionProposal { id: string; articleId: string; userId: string; contextKind: DialogueContextKind; summary: string; message: string; operations: RevisionOperation[]; warnings: string[]; status: 'pending' | 'applied' | 'dismissed'; createdAt: string; updatedAt: string }
export interface DialogueMessage { id: string; articleId: string; userId: string; contextKind: DialogueContextKind; role: 'user' | 'assistant'; content: string; proposalId?: string; createdAt: string }
export interface DialogueResponse { mode: 'answer' | 'clarify' | 'discuss' | 'proposal' | 'applied'; message: string; proposal?: RevisionProposal; article?: ArticleArtifact; run?: WorkflowRun; events?: AgentEvent[]; messages?: DialogueMessage[] }
export type DialogueBriefItemKind = 'requirement' | 'avoidance' | 'source' | 'preference' | 'revision' | 'evidence' | 'intent';
export type DialogueBriefItemStatus = 'active' | 'superseded';
export interface DialogueBriefItem { id: string; kind: DialogueBriefItemKind; text: string; status: DialogueBriefItemStatus; contextKind?: DialogueContextKind; sourceMessageId?: string; createdAt: string; updatedAt: string }
export interface DialogueBriefConflict { id: string; text: string; requirements: string[]; sourceMessageIds: string[]; createdAt: string; updatedAt: string }
export interface DialogueBrief { id: string; articleId: string; userId: string; activeRequirements: DialogueBriefItem[]; evidenceNotes: DialogueBriefItem[]; recentUserIntents: DialogueBriefItem[]; unresolvedConflicts: DialogueBriefConflict[]; supersededRequirements: DialogueBriefItem[]; createdAt: string; updatedAt: string }
export interface DialogueBriefUpdateJob { id: string; articleId: string; userId: string; messageId: string; messageContent: string; contextKind: DialogueContextKind; contextTitle: string; status: 'pending' | 'running' | 'succeeded' | 'failed'; attempts: number; error?: string; createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string }
export interface DialogueBriefStatus { brief?: DialogueBrief; jobs: DialogueBriefUpdateJob[]; status: 'idle' | 'updating' | 'failed'; message?: string }
export interface WritingWorkspace { id: string; userId: string; memberUserIds: string[]; name: string; isDefault: boolean; createdAt: string; updatedAt: string; deletedAt?: string }
export interface DomainProfileOption { id: string; label: string; description?: string; defaultSelected?: boolean }
export interface DomainProfileGroup { id: string; label: string; type: 'single' | 'multi'; options: DomainProfileOption[] }
export interface DomainProfileSummary { id: string; label: string; description: string; groups: DomainProfileGroup[] }
export interface DomainProfileRecommendation { id: string; label: string; description: string; score: number }
export interface DomainProfileSelection { id: string; selections: Record<string, string | string[]> }
export interface WritingStandardOptionSummary { id: string; label: string; description: string }
export interface WritingStandardSummary { id: string; label: string; defaultOptionId: string; options: WritingStandardOptionSummary[] }
export interface WritingStandardSelection { languageEra: string; extraForbiddenTerms: string[] }
export interface WorkflowRun { id: string; workflowId: string; status: 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'; currentNodeId?: string; waitingFor?: { nodeId: string; reason: string }; state: Record<string, unknown>; error?: string }
export interface AgentEvent { id: string; runId?: string; type: string; payload: Record<string, unknown>; createdAt: string }
export interface HumanGate { id: string; runId: string; userId: string; articleId?: string; actionType: string; targetKind: 'task-card' | 'outline' | 'outline-item' | 'block' | 'article'; targetId?: string; proposalId?: string; question: string; options: Array<{ id: string; label: string; payload?: unknown }>; baseRevision?: number; status: 'pending' | 'accepted' | 'rejected' | 'superseded'; createdAt: string; updatedAt: string; resolvedAt?: string; resolvedByUserId?: string }
export interface WorkflowOperation { operationId: string; runId: string; userId: string; articleId?: string; toolName: string; allowedActionId: string; argsHash: string; status: 'running' | 'completed' | 'failed'; resultRef?: string; error?: string; articleRevisionBefore?: number; articleRevisionAfter?: number; createdAt: string; updatedAt: string }
export interface ReviewArtifact { id: string; articleId: string; runId: string; type: 'consistency-review' | 'polish-report'; baseRevision: number; findings: Array<{ severity: 'info' | 'warning' | 'blocking'; targetKind: string; targetId?: string; message: string }>; suggestions: Array<{ id: string; actionType: string; targetKind: string; targetId?: string; summary: string }>; createdAt: string; updatedAt: string }
export interface RunResponse { run: WorkflowRun; article?: ArticleArtifact; events: AgentEvent[]; humanGates?: HumanGate[]; operations?: WorkflowOperation[]; reviewArtifacts?: ReviewArtifact[] }
