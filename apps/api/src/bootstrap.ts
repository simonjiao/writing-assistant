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
  MockLLMProvider,
  OpenAICompatibleProvider,
  PiAgentDecisionProvider,
  PiWorkflowRunner,
  PublishingEventTraceStore,
  PiAgentSessionStore,
  ReviewArtifactStore,
  RevisionProposalStore,
  SessionStore,
  SkillExecutor,
  SkillRegistry,
  StateStore,
  WorkspaceStore,
  WorkflowOperationStore,
} from '@wa/core';
import { registerDefaultSkills } from '@wa/skills';
import { AppConfig } from './config';
import { SqliteArtifactStore, SqliteDialogueBriefStore, SqliteDialogueBriefUpdateJobStore, SqliteDialogueMessageStore, SqliteEventTraceStore, SqliteHumanGateStore, SqliteKnowledgeStore, SqliteMemoryStore, SqlitePiAgentSessionStore, SqliteReviewArtifactStore, SqliteRevisionProposalStore, SqliteSessionStore, SqliteStateStore, SqliteWorkflowOperationStore, SqliteWorkspaceStore } from './stores/sqliteStores';
import { HttpRagKnowledgeStore } from './stores/httpRagKnowledgeStore';
import { TonglingyuRetrieverKnowledgeStore } from './stores/tonglingyuRetrieverKnowledgeStore';
import { PiWorkflowActionExecutor } from './piWorkflowActionExecutor';
import { AgentToolExecutor } from './agent/agentToolExecutor';
import { NonWorkflowPiAgentRunner } from './agent/nonWorkflowPiAgentRunner';

export interface AppContainer {
  piRunner: PiWorkflowRunner;
  skillExecutor: SkillExecutor;
  agentToolExecutor: AgentToolExecutor;
  nonWorkflowPiAgentRunner: NonWorkflowPiAgentRunner;
  stores: ExternalStores;
  skills: SkillRegistry;
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
  workflowOperationStore: WorkflowOperationStore;
  reviewArtifactStore: ReviewArtifactStore;
  revisionProposalStore: RevisionProposalStore;
  dialogueMessageStore: DialogueMessageStore;
  dialogueBriefStore: DialogueBriefStore;
  dialogueBriefUpdateJobStore: DialogueBriefUpdateJobStore;
  localKnowledgeStore: KnowledgeStore;
  eventTraceStore: EventTraceStore;
  close?: () => Promise<void>;
}

export function createContainer(config: AppConfig): AppContainer {
  const base = createStores(config);
  const eventBus: EventBus = new InMemoryEventBus();
  const eventTraceStore = new PublishingEventTraceStore(base.eventTraceStore, eventBus) as EventTraceStore;
  const knowledgeStore = createKnowledgeStore(config, base.localKnowledgeStore, eventTraceStore);
  const stores: ExternalStores = { stateStore: base.stateStore, sessionStore: base.sessionStore, memoryStore: base.memoryStore, workspaceStore: base.workspaceStore, artifactStore: base.artifactStore, piAgentSessionStore: base.piAgentSessionStore, humanGateStore: base.humanGateStore, workflowOperationStore: base.workflowOperationStore, reviewArtifactStore: base.reviewArtifactStore, revisionProposalStore: base.revisionProposalStore, dialogueMessageStore: base.dialogueMessageStore, dialogueBriefStore: base.dialogueBriefStore, dialogueBriefUpdateJobStore: base.dialogueBriefUpdateJobStore, knowledgeStore, eventTraceStore };

  const llm = config.llmProvider === 'openai-compatible' ? new OpenAICompatibleProvider({ baseURL: config.openaiBaseURL, apiKey: config.openaiApiKey, model: config.openaiModel }) : new MockLLMProvider();
  const skills = registerDefaultSkills(new SkillRegistry());
  const contextBuilder = new DefaultContextBuilder({ sessionStore: stores.sessionStore, stateStore: stores.stateStore, memoryStore: stores.memoryStore, artifactStore: stores.artifactStore, knowledgeStore: stores.knowledgeStore });
  const skillExecutor = new SkillExecutor({ llm, skillRegistry: skills, contextBuilder, eventTraceStore });
  const agentToolExecutor = new AgentToolExecutor({ stores, skillExecutor });
  const nonWorkflowPiAgentRunner = new NonWorkflowPiAgentRunner({ stores, llm });
  const piRunner = new PiWorkflowRunner({ stores, actionExecutor: new PiWorkflowActionExecutor({ stores, skillExecutor, agentToolExecutor }), decisionProvider: new PiAgentDecisionProvider(llm), maxTurns: 20 });
  return { piRunner, skillExecutor, agentToolExecutor, nonWorkflowPiAgentRunner, stores, skills, eventBus, async close() { await base.close?.(); await eventBus.close?.(); } };
}

function createStores(config: AppConfig): StoreBundle {
  const stateStore = new SqliteStateStore(config.dataDir);
  const sessionStore = new SqliteSessionStore(config.dataDir);
  const memoryStore = new SqliteMemoryStore(config.dataDir);
  const workspaceStore = new SqliteWorkspaceStore(config.dataDir);
  const artifactStore = new SqliteArtifactStore(config.dataDir);
  const piAgentSessionStore = new SqlitePiAgentSessionStore(config.dataDir);
  const humanGateStore = new SqliteHumanGateStore(config.dataDir);
  const workflowOperationStore = new SqliteWorkflowOperationStore(config.dataDir);
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
    workflowOperationStore,
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
      workflowOperationStore.close();
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
