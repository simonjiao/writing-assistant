import {
  ArtifactStore,
  DefaultContextBuilder,
  DialogueBriefStore,
  DialogueBriefUpdateJobStore,
  DialogueMessageStore,
  EventBus,
  EventTraceStore,
  ExternalStores,
  HumanGateStore,
  InMemoryEventBus,
  KnowledgeStore,
  MemoryStore,
  LLMProvider,
  OpenAICompatibleProvider,
  PiAgentDecisionProvider,
  PublishingEventTraceStore,
  PiAgentSessionStore,
  ReviewArtifactStore,
  RevisionProposalStore,
  SessionStore,
  StateStore,
  WorkspaceStore,
  AgentOperationStore,
} from '@wa/core';
import { AgentToolExecutor, PiWorkflowRunner, ProductSkillRegistry, PromptProgramRegistry, ToolRegistry } from '@wa/runtime';
import { AllowedActionPlanner, registerWritingAssistantProductSkills, registerWritingAssistantPromptPrograms, registerWritingAssistantTools, WRITING_AUTOPILOT_POLICY, WritingAutopilotActionExecutor } from '@wa/writing-assistant';
import { AppConfig } from './config';
import { SqliteArtifactStore, SqliteDialogueBriefStore, SqliteDialogueBriefUpdateJobStore, SqliteDialogueMessageStore, SqliteEventTraceStore, SqliteHumanGateStore, SqliteKnowledgeStore, SqliteMemoryStore, SqlitePiAgentSessionStore, SqliteReviewArtifactStore, SqliteRevisionProposalStore, SqliteSessionStore, SqliteStateStore, SqliteAgentOperationStore, SqliteWorkspaceStore } from './stores/sqliteStores';
import { HttpRagKnowledgeStore } from './stores/httpRagKnowledgeStore';
import { TonglingyuRetrieverKnowledgeStore } from './stores/tonglingyuRetrieverKnowledgeStore';

export interface AppContainer {
  piRunner: PiWorkflowRunner;
  agentToolExecutor: AgentToolExecutor;
  stores: ExternalStores;
  productSkills: ProductSkillRegistry;
  promptPrograms: PromptProgramRegistry;
  tools: ToolRegistry;
  eventBus: EventBus;
  close(): Promise<void>;
}

interface StoreBundle {
  stateStore: StateStore;
  sessionStore: SessionStore;
  memoryStore: MemoryStore;
  workspaceStore: WorkspaceStore;
  artifactStore: ArtifactStore;
  piAgentSessionStore: PiAgentSessionStore;
  humanGateStore: HumanGateStore;
  agentOperationStore: AgentOperationStore;
  reviewArtifactStore: ReviewArtifactStore;
  revisionProposalStore: RevisionProposalStore;
  dialogueMessageStore: DialogueMessageStore;
  dialogueBriefStore: DialogueBriefStore;
  dialogueBriefUpdateJobStore: DialogueBriefUpdateJobStore;
  localKnowledgeStore: KnowledgeStore;
  eventTraceStore: EventTraceStore;
  close?: () => Promise<void>;
}

export function createContainer(config: AppConfig, overrides: { llm?: LLMProvider } = {}): AppContainer {
  const base = createStores(config);
  const eventBus: EventBus = new InMemoryEventBus();
  const eventTraceStore = new PublishingEventTraceStore(base.eventTraceStore, eventBus) as EventTraceStore;
  const knowledgeStore = createKnowledgeStore(config, base.localKnowledgeStore, eventTraceStore);
  const stores: ExternalStores = { stateStore: base.stateStore, sessionStore: base.sessionStore, memoryStore: base.memoryStore, workspaceStore: base.workspaceStore, artifactStore: base.artifactStore, piAgentSessionStore: base.piAgentSessionStore, humanGateStore: base.humanGateStore, agentOperationStore: base.agentOperationStore, reviewArtifactStore: base.reviewArtifactStore, revisionProposalStore: base.revisionProposalStore, dialogueMessageStore: base.dialogueMessageStore, dialogueBriefStore: base.dialogueBriefStore, dialogueBriefUpdateJobStore: base.dialogueBriefUpdateJobStore, knowledgeStore, eventTraceStore };

  const llm = overrides.llm ?? createLlmProvider(config);
  const productSkills = registerWritingAssistantProductSkills();
  const promptPrograms = registerWritingAssistantPromptPrograms();
  const tools = registerWritingAssistantTools(new ToolRegistry(), productSkills);
  const contextBuilder = new DefaultContextBuilder({ sessionStore: stores.sessionStore, stateStore: stores.stateStore, memoryStore: stores.memoryStore, artifactStore: stores.artifactStore, knowledgeStore: stores.knowledgeStore });
  const agentToolExecutor = new AgentToolExecutor({ stores, toolRegistry: tools, promptPrograms, contextBuilder, llm });
  const piRunner = new PiWorkflowRunner({ stores, planner: new AllowedActionPlanner(), actionExecutor: new WritingAutopilotActionExecutor({ stores, agentToolExecutor }), decisionProvider: new PiAgentDecisionProvider(llm), maxTurns: 20 }, WRITING_AUTOPILOT_POLICY);
  return { piRunner, agentToolExecutor, stores, productSkills, promptPrograms, tools, eventBus, async close() { await base.close?.(); await eventBus.close?.(); } };
}

function createLlmProvider(config: AppConfig): LLMProvider {
  if (!config.openaiApiKey.trim() || config.openaiApiKey.trim() === 'replace-me') {
    throw new Error('LLM_PROVIDER=openai-compatible requires OPENAI_API_KEY.');
  }
  if (!config.openaiModel.trim()) {
    throw new Error('LLM_PROVIDER=openai-compatible requires OPENAI_MODEL.');
  }
  return new OpenAICompatibleProvider({ baseURL: config.openaiBaseURL, apiKey: config.openaiApiKey, model: config.openaiModel });
}

function createStores(config: AppConfig): StoreBundle {
  const stateStore = new SqliteStateStore(config.dataDir);
  const sessionStore = new SqliteSessionStore(config.dataDir);
  const memoryStore = new SqliteMemoryStore(config.dataDir);
  const workspaceStore = new SqliteWorkspaceStore(config.dataDir);
  const artifactStore = new SqliteArtifactStore(config.dataDir);
  const piAgentSessionStore = new SqlitePiAgentSessionStore(config.dataDir);
  const humanGateStore = new SqliteHumanGateStore(config.dataDir);
  const agentOperationStore = new SqliteAgentOperationStore(config.dataDir);
  const reviewArtifactStore = new SqliteReviewArtifactStore(config.dataDir);
  const revisionProposalStore = new SqliteRevisionProposalStore(config.dataDir);
  const dialogueMessageStore = new SqliteDialogueMessageStore(config.dataDir);
  const dialogueBriefStore = new SqliteDialogueBriefStore(config.dataDir);
  const dialogueBriefUpdateJobStore = new SqliteDialogueBriefUpdateJobStore(config.dataDir);
  const localKnowledgeStore = new SqliteKnowledgeStore(config.dataDir);
  const eventTraceStore = new SqliteEventTraceStore(config.dataDir);
  return {
    stateStore,
    sessionStore,
    memoryStore,
    workspaceStore,
    artifactStore,
    piAgentSessionStore,
    humanGateStore,
    agentOperationStore,
    reviewArtifactStore,
    revisionProposalStore,
    dialogueMessageStore,
    dialogueBriefStore,
    dialogueBriefUpdateJobStore,
    localKnowledgeStore,
    eventTraceStore,
    async close() {
      stateStore.close();
      sessionStore.close();
      memoryStore.close();
      workspaceStore.close();
      artifactStore.close();
      piAgentSessionStore.close();
      humanGateStore.close();
      agentOperationStore.close();
      reviewArtifactStore.close();
      revisionProposalStore.close();
      dialogueMessageStore.close();
      dialogueBriefStore.close();
      dialogueBriefUpdateJobStore.close();
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
