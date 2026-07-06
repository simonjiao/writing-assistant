import { ArtifactStore, KnowledgeStore, MemoryStore, SessionStore, StateStore } from './stores';
import { ArticleArtifact, KnowledgeItem, Session, UserWritingProfile, WorkflowRun } from './types';

export interface ContextBuildInput {
  userId: string;
  sessionId?: string;
  runId?: string;
  skillId: string;
  input: unknown;
  articleId?: string;
  blockId?: string;
}

export interface AgentContext {
  userId: string;
  session?: Session;
  run?: WorkflowRun;
  memory: UserWritingProfile;
  article?: ArticleArtifact;
  selectedBlock?: ArticleArtifact['blocks'][number];
  knowledge: KnowledgeItem[];
  scope: 'article' | 'section' | 'paragraph';
  skillId: string;
  compactSummary: string;
}

export interface ContextBuilder {
  build(input: ContextBuildInput): Promise<AgentContext>;
}

export class DefaultContextBuilder implements ContextBuilder {
  constructor(
    private readonly deps: {
      sessionStore: SessionStore;
      stateStore: StateStore;
      memoryStore: MemoryStore;
      artifactStore: ArtifactStore;
      knowledgeStore: KnowledgeStore;
    },
  ) {}

  async build(input: ContextBuildInput): Promise<AgentContext> {
    const session = input.sessionId ? await this.deps.sessionStore.getSession(input.sessionId) : undefined;
    const run = input.runId ? await this.deps.stateStore.getRun(input.runId) : undefined;
    const memory = await this.deps.memoryStore.getUserProfile(input.userId);

    const objectInput = typeof input.input === 'object' && input.input ? (input.input as Record<string, unknown>) : {};
    const articleId =
      input.articleId ??
      (typeof objectInput.articleId === 'string' ? objectInput.articleId : undefined) ??
      (typeof run?.metadata.articleId === 'string' ? run.metadata.articleId : undefined) ??
      session?.currentArticleId;

    const article = articleId ? await this.deps.artifactStore.getArticle(articleId) : undefined;
    const blockId =
      input.blockId ??
      (typeof objectInput.blockId === 'string' ? objectInput.blockId : undefined) ??
      session?.currentBlockId;
    const selectedBlock = article?.blocks.find((block) => block.id === blockId);

    const skipKnowledge = objectInput.skipKnowledge === true;
    const queryParts = skipKnowledge ? [] : [
      article?.taskCard?.topic,
      article?.taskCard?.writingGoal,
      selectedBlock?.text,
      typeof objectInput.instruction === 'string' ? objectInput.instruction : undefined,
      typeof objectInput.rawRequirement === 'string' ? objectInput.rawRequirement : undefined,
    ].filter(Boolean);

    const knowledge = queryParts.length
      ? await this.deps.knowledgeStore.search(queryParts.join('\n'), {
          limit: 6,
          themeTags: selectedBlock?.themeTags,
        })
      : [];

    const scope = selectedBlock ? 'paragraph' : article ? 'article' : 'article';

    return {
      userId: input.userId,
      session,
      run,
      memory,
      article,
      selectedBlock,
      knowledge,
      scope,
      skillId: input.skillId,
      compactSummary: this.compactSummary({ article, selectedBlock, memory, knowledge }),
    };
  }

  private compactSummary(input: {
    article?: ArticleArtifact;
    selectedBlock?: ArticleArtifact['blocks'][number];
    memory: UserWritingProfile;
    knowledge: KnowledgeItem[];
  }): string {
    const articleSummary = input.article
      ? `Article: ${input.article.title}; outline=${input.article.outline.length}; blocks=${input.article.blocks.length}`
      : 'Article: none';
    const selected = input.selectedBlock ? `Selected block: ${input.selectedBlock.id}` : 'Selected block: none';
    const memory = `User preferences: ${[
      ...input.memory.stylePreferences,
      ...input.memory.structurePreferences,
      ...input.memory.editPreferences,
    ].join('；')}`;
    const knowledge = `Knowledge items: ${input.knowledge.map((item) => item.title).join('；')}`;
    return [articleSummary, selected, memory, knowledge].join('\n');
  }
}
