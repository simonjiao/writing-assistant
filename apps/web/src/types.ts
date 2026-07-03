export interface WritingTaskCard { id: string; topic: string; writingGoal: string; audience: string; scope: { editions?: string[]; chapters?: string[]; characters?: string[]; themes?: string[] }; structure: { articleType: string; expectedLength: string; outlinePreference?: string }; style: { register: string; tone: string; classicalFlavor: boolean; characterVoice?: string }; constraints: { mustInclude: string[]; mustAvoid: string[]; citationRequired: boolean; sourcePolicy: string }; interactionMode: { askBeforeWriting: boolean; localEditFirst: boolean }; status: 'draft' | 'confirmed' }
export interface OutlineItem { id: string; title: string; goal: string; order: number; expectedBlocks: number; sourceHints: string[]; themeTags: string[]; status: 'draft' | 'confirmed' | 'written' }
export interface ArticleBlock { id: string; type: string; sectionId?: string; title?: string; text: string; sourceRefs: string[]; themeTags: string[]; status: string }
export interface ArticleArtifact { id: string; userId: string; workspaceId: string; title: string; taskCard?: WritingTaskCard; outline: OutlineItem[]; blocks: ArticleBlock[]; versions: Array<{ id: string; reason: string; author: string; createdAt: string }> }
export interface ArticleSummary { id: string; workspaceId: string; title: string; taskStatus?: 'draft' | 'confirmed'; outlineCount: number; blockCount: number; updatedAt: string; deletedAt?: string }
export interface WritingWorkspace { id: string; userId: string; memberUserIds: string[]; name: string; isDefault: boolean; createdAt: string; updatedAt: string; deletedAt?: string }
export interface DomainProfileOption { id: string; label: string; description?: string; defaultSelected?: boolean }
export interface DomainProfileGroup { id: string; label: string; type: 'single' | 'multi'; options: DomainProfileOption[] }
export interface DomainProfileSummary { id: string; label: string; description: string; groups: DomainProfileGroup[] }
export interface DomainProfileRecommendation { id: string; label: string; description: string; score: number }
export interface DomainProfileSelection { id: string; selections: Record<string, string | string[]> }
export interface WorkflowRun { id: string; workflowId: string; status: 'idle' | 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'; currentNodeId?: string; waitingFor?: { nodeId: string; reason: string }; state: Record<string, unknown>; error?: string }
export interface AgentEvent { id: string; runId?: string; type: string; payload: Record<string, unknown>; createdAt: string }
export interface RunResponse { run: WorkflowRun; article?: ArticleArtifact; events: AgentEvent[] }
