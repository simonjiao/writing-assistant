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

    const sectionInput = readRecord(objectInput.section);
    const sectionThemeTags = stringArray(sectionInput?.themeTags);
    const sectionSourceHints = stringArray(sectionInput?.sourceHints);
    const sectionSpecialHandling = stringArray(sectionInput?.specialHandling);
    const sectionRole = typeof sectionInput?.rhetoricalRole === 'string' ? sectionInput.rhetoricalRole : undefined;
    const taskCharacters = article?.taskCard?.scope.characters ?? [];
    const taskThemes = article?.taskCard?.scope.themes ?? [];
    const keywordQueries = sectionSourceHints.length
      ? sectionSourceHints.map((hint) => uniqueStrings([...taskCharacters, hint]).join(' '))
      : undefined;
    const retrievalThemeTags = uniqueStrings([
      ...sectionThemeTags,
      ...taskCharacters,
      ...(selectedBlock?.themeTags ?? []),
    ]);
    const sectionQueryParts = [
      typeof sectionInput?.title === 'string' ? sectionInput.title : undefined,
      typeof sectionInput?.goal === 'string' ? sectionInput.goal : undefined,
      sectionRole,
      sectionInput?.keySection === true ? '关键段落' : undefined,
      ...sectionSpecialHandling,
      ...sectionSourceHints,
    ];

    const skipKnowledge = objectInput.skipKnowledge === true;
    const queryParts = skipKnowledge ? [] : [
      article?.taskCard?.topic,
      article?.taskCard?.writingGoal,
      ...taskCharacters,
      ...taskThemes,
      ...sectionQueryParts,
      selectedBlock?.text,
      typeof objectInput.instruction === 'string' ? objectInput.instruction : undefined,
      typeof objectInput.rawRequirement === 'string' ? objectInput.rawRequirement : undefined,
    ].filter(Boolean);

    const knowledge = queryParts.length
      ? await this.deps.knowledgeStore.search(queryParts.join('\n'), {
          limit: sectionInput ? 12 : 6,
          themeTags: retrievalThemeTags.length ? retrievalThemeTags : undefined,
          keywordQueries,
        })
      : [];

    const scope = selectedBlock ? 'paragraph' : sectionInput ? 'section' : article ? 'article' : 'article';

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
      compactSummary: this.compactSummary({ article, selectedBlock, section: sectionInput, memory, knowledge }),
    };
  }

  private compactSummary(input: {
    article?: ArticleArtifact;
    selectedBlock?: ArticleArtifact['blocks'][number];
    section?: Record<string, unknown>;
    memory: UserWritingProfile;
    knowledge: KnowledgeItem[];
  }): string {
    const articleSummary = input.article
      ? `Article: ${input.article.title}; outline=${input.article.outline.length}; blocks=${input.article.blocks.length}`
      : 'Article: none';
    const selected = input.selectedBlock ? `Selected block: ${input.selectedBlock.id}` : 'Selected block: none';
    const section = input.section ? `Current section: ${String(input.section.title ?? '')}; goal=${String(input.section.goal ?? '')}` : 'Current section: none';
    const memory = `User preferences: ${[
      ...input.memory.stylePreferences,
      ...input.memory.structurePreferences,
      ...input.memory.editPreferences,
    ].join('；')}`;
    const knowledge = `Knowledge items: ${input.knowledge.map((item) => item.title).join('；')}`;
    return [articleSummary, selected, section, memory, knowledge].join('\n');
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
