import {
  AgentRuntime,
  ArtifactStore,
  DefaultContextBuilder,
  DialogueMessageStore,
  END,
  EventBus,
  EventTraceStore,
  ExternalStores,
  InMemoryEventBus,
  KnowledgeStore,
  LocalWorkflowQueue,
  MemoryStore,
  MockLLMProvider,
  newId,
  nowIso,
  OpenAICompatibleProvider,
  PublishingEventTraceStore,
  RevisionProposalStore,
  SessionStore,
  SkillRegistry,
  StateStore,
  WorkspaceStore,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowQueue,
  WorkflowWorkerPool,
  WritingTaskCard,
  mergeDeep,
} from '@wa/core';
import { registerDefaultSkills } from '@wa/skills';
import { AppConfig } from './config';
import { SqliteArtifactStore, SqliteDialogueMessageStore, SqliteEventTraceStore, SqliteKnowledgeStore, SqliteMemoryStore, SqliteRevisionProposalStore, SqliteSessionStore, SqliteStateStore, SqliteWorkspaceStore } from './stores/sqliteStores';
import { HttpRagKnowledgeStore } from './stores/httpRagKnowledgeStore';
import { TonglingyuRetrieverKnowledgeStore } from './stores/tonglingyuRetrieverKnowledgeStore';
import { RedisWorkflowQueue } from './queue/redisWorkflowQueue';

export interface AppContainer {
  engine: WorkflowEngine;
  runtime: AgentRuntime;
  stores: ExternalStores;
  skills: SkillRegistry;
  eventBus: EventBus;
  queue?: WorkflowQueue;
  workerPool?: WorkflowWorkerPool;
  close(): Promise<void>;
}

interface StoreBundle {
  stateStore: StateStore;
  sessionStore: SessionStore;
  memoryStore: MemoryStore;
  workspaceStore: WorkspaceStore;
  artifactStore: ArtifactStore;
  revisionProposalStore: RevisionProposalStore;
  dialogueMessageStore: DialogueMessageStore;
  localKnowledgeStore: KnowledgeStore;
  eventTraceStore: EventTraceStore;
  close?: () => Promise<void>;
}

export function createContainer(config: AppConfig): AppContainer {
  const base = createStores(config);
  const eventBus: EventBus = new InMemoryEventBus();
  const eventTraceStore = new PublishingEventTraceStore(base.eventTraceStore, eventBus) as EventTraceStore;
  const knowledgeStore = createKnowledgeStore(config, base.localKnowledgeStore, eventTraceStore);
  const stores: ExternalStores = { stateStore: base.stateStore, sessionStore: base.sessionStore, memoryStore: base.memoryStore, workspaceStore: base.workspaceStore, artifactStore: base.artifactStore, revisionProposalStore: base.revisionProposalStore, dialogueMessageStore: base.dialogueMessageStore, knowledgeStore, eventTraceStore };

  const llm = config.llmProvider === 'openai-compatible' ? new OpenAICompatibleProvider({ baseURL: config.openaiBaseURL, apiKey: config.openaiApiKey, model: config.openaiModel }) : new MockLLMProvider();
  const skills = registerDefaultSkills(new SkillRegistry());
  const contextBuilder = new DefaultContextBuilder({ sessionStore: stores.sessionStore, stateStore: stores.stateStore, memoryStore: stores.memoryStore, artifactStore: stores.artifactStore, knowledgeStore: stores.knowledgeStore });
  const runtime = new AgentRuntime({ llm, skillRegistry: skills, contextBuilder, eventTraceStore });
  const queue = config.workflowExecutionMode === 'async' ? createQueue(config) : undefined;
  const engine = new WorkflowEngine({ stateStore: stores.stateStore, eventTraceStore, runtime, queue, executionMode: config.workflowExecutionMode });
  registerWorkflows(engine, { artifactStore: stores.artifactStore, sessionStore: stores.sessionStore, eventTraceStore });
  const workerPool = queue && config.enableWorkers ? new WorkflowWorkerPool({ queue, stateStore: stores.stateStore, eventTraceStore, runnerFactory: () => engine.createRunner() }, { concurrency: config.runnerConcurrency, reserveTimeoutMs: 1000 }) : undefined;
  workerPool?.start();
  return { engine, runtime, stores, skills, eventBus, queue, workerPool, async close() { await workerPool?.stop(); await queue?.close?.(); await base.close?.(); await eventBus.close?.(); } };
}

function createStores(config: AppConfig): StoreBundle {
  const stateStore = new SqliteStateStore(config.dataDir);
  const sessionStore = new SqliteSessionStore(config.dataDir);
  const memoryStore = new SqliteMemoryStore(config.dataDir);
  const workspaceStore = new SqliteWorkspaceStore(config.dataDir);
  const artifactStore = new SqliteArtifactStore(config.dataDir);
  const revisionProposalStore = new SqliteRevisionProposalStore(config.dataDir);
  const dialogueMessageStore = new SqliteDialogueMessageStore(config.dataDir);
  const localKnowledgeStore = new SqliteKnowledgeStore(config.dataDir);
  const eventTraceStore = new SqliteEventTraceStore(config.dataDir);
  return {
    stateStore,
    sessionStore,
    memoryStore,
    workspaceStore,
    artifactStore,
    revisionProposalStore,
    dialogueMessageStore,
    localKnowledgeStore,
    eventTraceStore,
    async close() {
      stateStore.close();
      sessionStore.close();
      memoryStore.close();
      workspaceStore.close();
      artifactStore.close();
      revisionProposalStore.close();
      dialogueMessageStore.close();
      localKnowledgeStore.close();
      eventTraceStore.close();
    },
  };
}

function createKnowledgeStore(config: AppConfig, localStore: KnowledgeStore, eventTraceStore: EventTraceStore): KnowledgeStore {
  if (config.ragProvider === 'tonglingyu') {
    if (!config.ragBaseURL) throw new Error('RAG_PROVIDER=tonglingyu requires RAG_BASE_URL.');
    return new TonglingyuRetrieverKnowledgeStore({ baseURL: config.ragBaseURL, apiKey: config.ragApiKey, retrievePath: config.ragSearchPath, timeoutMs: config.ragTimeoutMs, eventTraceStore });
  }
  if (config.ragProvider === 'http') {
    if (!config.ragBaseURL) throw new Error('RAG_PROVIDER=http requires RAG_BASE_URL.');
    return new HttpRagKnowledgeStore({ baseURL: config.ragBaseURL, apiKey: config.ragApiKey, searchPath: config.ragSearchPath, refsPath: config.ragRefsPath, timeoutMs: config.ragTimeoutMs, eventTraceStore });
  }
  return localStore;
}

function createQueue(config: AppConfig): WorkflowQueue {
  return config.workflowQueueDriver === 'redis' ? new RedisWorkflowQueue({ redisUrl: config.redisUrl }) : new LocalWorkflowQueue();
}

function registerWorkflows(engine: WorkflowEngine, deps: { artifactStore: ArtifactStore; sessionStore: SessionStore; eventTraceStore: EventTraceStore }): void {
  const taskCardWorkflow: WorkflowDefinition = {
    id: 'task-card-workflow', name: '任务卡生成流程', description: '从模糊需求生成任务卡，创建文章草稿，并等待用户确认。', startNodeId: 'build-task-card',
    nodes: [
      { id: 'build-task-card', label: '生成任务卡草稿', kind: 'skill', skillId: 'task-card-builder', input: ({ run }) => run.input, outputKey: 'taskCardResult', next: 'create-draft-article' },
      { id: 'create-draft-article', label: '创建文章草稿', kind: 'function', outputKey: 'draftArticle', handler: async ({ run }) => { const result = run.state.taskCardResult as { taskCard: { topic: string } }; const input = run.input as { workspaceId?: string }; if (!input.workspaceId) throw new Error('workspaceId is required to create an article.'); const article = await deps.artifactStore.createArticle({ userId: run.metadata.userId, workspaceId: input.workspaceId, title: result.taskCard.topic, taskCard: result.taskCard as never }); if (run.metadata.sessionId) await deps.sessionStore.updateSession(run.metadata.sessionId, { currentArticleId: article.id, currentWorkspaceId: input.workspaceId, currentRunId: run.id }); await deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, workspaceId: input.workspaceId, reason: 'task-card-draft-created', userId: run.metadata.userId }, createdAt: nowIso() }); return { articleId: article.id, workspaceId: input.workspaceId, taskCard: article.taskCard }; }, next: 'wait-task-card-confirm' },
      { id: 'wait-task-card-confirm', label: '等待用户确认任务卡', kind: 'wait', reason: '请确认或修改任务卡。', next: 'finalize-task-card' },
      { id: 'finalize-task-card', label: '确认任务卡', kind: 'function', outputKey: 'finalizedTaskCard', handler: async ({ run }) => { const draft = run.state.draftArticle as { articleId: string }; const response = (run.state['wait-task-card-confirmResponse'] ?? {}) as { taskCardPatch?: Record<string, unknown>; taskCard?: Record<string, unknown> }; const article = await deps.artifactStore.getArticle(draft.articleId); if (!article?.taskCard) throw new Error('Article task card not found.'); const patch = response.taskCard ?? response.taskCardPatch ?? {}; const mergedTaskCard = mergeDeep(article.taskCard as unknown as Record<string, unknown>, patch) as unknown as WritingTaskCard; mergedTaskCard.status = 'confirmed'; mergedTaskCard.updatedAt = nowIso(); article.taskCard = mergedTaskCard; await deps.artifactStore.updateArticle(article); await deps.artifactStore.commitVersion(article.id, '确认任务卡', 'user'); await deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'task-card-confirmed', userId: run.metadata.userId }, createdAt: nowIso() }); return { articleId: article.id, taskCard: article.taskCard }; }, next: END },
    ],
  };

  const outlineWorkflow: WorkflowDefinition = {
    id: 'outline-workflow', name: '大纲生成流程', description: '基于任务卡生成大纲，并等待用户开始写作。', startNodeId: 'plan-outline',
    nodes: [
      { id: 'plan-outline', label: '生成大纲', kind: 'skill', skillId: 'outline-planner', input: async ({ run }) => { const input = run.input as { articleId: string }; const article = await deps.artifactStore.getArticle(input.articleId); if (!article?.taskCard) throw new Error('Task card is required before outlining.'); if (article.taskCard.status !== 'confirmed') throw new Error('Task card must be confirmed before outlining.'); return { articleId: article.id, taskCard: article.taskCard }; }, outputKey: 'outlineResult', next: 'commit-outline-draft' },
      { id: 'commit-outline-draft', label: '保存大纲草稿', kind: 'function', outputKey: 'outlineDraft', handler: async ({ run }) => { const input = run.input as { articleId: string }; const result = run.state.outlineResult as { outline: [] }; const article = await deps.artifactStore.getArticle(input.articleId); if (!article) throw new Error('Article not found.'); article.outline = result.outline; article.blocks = []; await deps.artifactStore.updateArticle(article); await deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'outline-draft-created', userId: run.metadata.userId }, createdAt: nowIso() }); return { articleId: article.id, outline: article.outline }; }, next: 'wait-writing-start' },
      { id: 'wait-writing-start', label: '等待开始写作', kind: 'wait', reason: '请检查或调整大纲，准备好后开始写作。', next: 'start-writing' },
      { id: 'start-writing', label: '开始写作', kind: 'function', outputKey: 'writingStarted', handler: async ({ run }) => { const draft = run.state.outlineDraft as { articleId: string }; const response = (run.state['wait-writing-startResponse'] ?? {}) as { outline?: [] }; const article = await deps.artifactStore.getArticle(draft.articleId); if (!article) throw new Error('Article not found.'); if (response.outline) article.outline = response.outline; article.outline = article.outline.map((item) => ({ ...item, status: 'confirmed' as const })); await deps.artifactStore.updateArticle(article); await deps.artifactStore.commitVersion(article.id, '开始写作', 'user'); await deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'writing-started', userId: run.metadata.userId }, createdAt: nowIso() }); return { articleId: article.id, outline: article.outline }; }, next: END },
    ],
  };

  const sectionWorkflow: WorkflowDefinition = {
    id: 'section-writing-workflow', name: '章节写作流程', description: '根据某个大纲节点生成章节正文并提交到文章。', startNodeId: 'write-section',
    nodes: [
      { id: 'write-section', label: '生成章节正文', kind: 'skill', skillId: 'section-writer', input: async ({ run }) => { const input = run.input as { articleId: string; sectionId: string }; const article = await deps.artifactStore.getArticle(input.articleId); if (!article?.taskCard) throw new Error('Task card is required.'); if (article.taskCard.status !== 'confirmed') throw new Error('Task card must be confirmed before writing.'); const section = article.outline.find((item) => item.id === input.sectionId); if (!section) throw new Error('Section not found.'); if (section.status === 'draft') throw new Error('Outline must be ready before writing.'); return { articleId: article.id, section, taskCard: article.taskCard }; }, outputKey: 'sectionResult', next: 'commit-section' },
      { id: 'commit-section', label: '保存章节正文', kind: 'function', outputKey: 'committedSection', handler: async ({ run }) => { const input = run.input as { articleId: string; sectionId: string }; const result = run.state.sectionResult as { block?: { id: string; sectionId?: string }; blocks?: Array<{ id: string; sectionId?: string }> }; const blocks = Array.isArray(result.blocks) && result.blocks.length ? result.blocks : (result.block ? [result.block] : []); if (!blocks.length) throw new Error('Section writer returned no blocks to commit.'); const article = await deps.artifactStore.getArticle(input.articleId); if (!article) throw new Error('Article not found.'); const sectionTitle = article.outline.find((item) => item.id === input.sectionId)?.title ?? '章节正文'; article.blocks = article.blocks.filter((block) => block.sectionId !== input.sectionId).concat(blocks as never); article.outline = article.outline.map((item) => item.id === input.sectionId ? { ...item, status: 'written' as const } : item); await deps.artifactStore.updateArticle(article); await deps.artifactStore.commitVersion(article.id, `生成章节正文：${sectionTitle}`, 'agent'); await deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'section-written', sectionId: input.sectionId, blockIds: blocks.map((block) => block.id), userId: run.metadata.userId }, createdAt: nowIso() }); return { articleId: article.id, blockId: blocks[0].id, blockIds: blocks.map((block) => block.id) }; }, next: END },
    ],
  };

  const patchWorkflow: WorkflowDefinition = {
    id: 'patch-workflow', name: '局部修改流程', description: '对选中 block 生成 patch 预览，用户确认后应用。', startNodeId: 'generate-patch',
    nodes: [
      { id: 'generate-patch', label: '生成局部修改 patch', kind: 'skill', skillId: 'patch-editor', input: ({ run }) => run.input, outputKey: 'patchResult', next: 'wait-patch-confirm' },
      { id: 'wait-patch-confirm', label: '等待用户确认 patch', kind: 'wait', reason: '请确认是否应用局部修改。', next: 'apply-patch' },
      { id: 'apply-patch', label: '应用局部修改', kind: 'function', outputKey: 'appliedPatch', handler: async ({ run }) => { const patchResult = run.state.patchResult as { patch: never }; const response = (run.state['wait-patch-confirmResponse'] ?? {}) as { decision?: string }; if (response.decision === 'reject') return { applied: false, reason: 'user-rejected' }; const article = await deps.artifactStore.applyPatch(patchResult.patch); await deps.eventTraceStore.append({ id: newId('evt'), runId: run.id, type: 'artifact.updated', payload: { articleId: article.id, reason: 'patch-applied', blockId: (patchResult.patch as { blockId: string }).blockId, userId: run.metadata.userId }, createdAt: nowIso() }); return { applied: true, articleId: article.id, blockId: (patchResult.patch as { blockId: string }).blockId }; }, next: END },
    ],
  };
  engine.registerWorkflow(taskCardWorkflow); engine.registerWorkflow(outlineWorkflow); engine.registerWorkflow(sectionWorkflow); engine.registerWorkflow(patchWorkflow);
}
