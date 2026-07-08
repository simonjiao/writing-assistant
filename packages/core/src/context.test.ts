import { describe, expect, it } from 'vitest';
import { DefaultContextBuilder } from './context';
import { ArticleArtifact, KnowledgeItem, UserWritingProfile } from './types';

const memory: UserWritingProfile = {
  userId: 'u1',
  stylePreferences: [],
  structurePreferences: [],
  editPreferences: [],
  memoryNotes: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const article: ArticleArtifact = {
  id: 'art_1',
  userId: 'u1',
  workspaceId: 'wsp_1',
  title: '司棋人物文章',
  taskCard: {
    id: 'task_1',
    topic: '司棋人物文章',
    writingGoal: '分析司棋的性格、人物关系和文学作用。',
    audience: '普通读者',
    scope: { editions: ['脂评本'], chapters: [], characters: ['司棋'], themes: ['人物分析'] },
    structure: { articleType: 'analysis', expectedLength: '1500字', outlinePreference: '分层展开。' },
    style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
    constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '以前80回和脂批为依据。' },
    interactionMode: { askBeforeWriting: true, localEditFirst: true },
    status: 'confirmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  outline: [],
  blocks: [],
  citations: [],
  themeTags: [],
  versions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('DefaultContextBuilder', () => {
  it('uses the current section to build retrieval queries for section writing', async () => {
    const calls: Array<{ query: string; options: { limit?: number; themeTags?: string[]; keywordQueries?: string[] } | undefined }> = [];
    const knowledge: KnowledgeItem[] = [];
    const builder = new DefaultContextBuilder({
      sessionStore: { async getSession() { return undefined; } } as never,
      stateStore: { async getRun() { return undefined; } } as never,
      memoryStore: { async getUserProfile() { return memory; } } as never,
      artifactStore: { async getArticle() { return article; } } as never,
      knowledgeStore: {
        async search(query, options) {
          calls.push({ query, options });
          return knowledge;
        },
        async listByRefs() { return []; },
      },
    });

    const context = await builder.build({
      userId: 'u1',
      promptProgramId: 'section-writer',
      articleId: article.id,
      input: {
        articleId: article.id,
        section: {
          id: 'sec_1',
          title: '花荫下的私情',
          goal: '说明司棋与潘又安一事不能只作浅薄理解。',
          rhetoricalRole: 'turn',
          keySection: true,
          specialHandling: ['这是全文关键转折，先纠正误解再展开判断。'],
          sourceHints: ['第71回鸳鸯撞见司棋与潘又安私会'],
          themeTags: ['司棋', '潘又安'],
        },
      },
    });

    expect(context.scope).toBe('section');
    expect(calls[0].query).toContain('花荫下的私情');
    expect(calls[0].query).toContain('说明司棋与潘又安');
    expect(calls[0].query).toContain('turn');
    expect(calls[0].query).toContain('关键段落');
    expect(calls[0].query).toContain('这是全文关键转折');
    expect(calls[0].query).toContain('第71回鸳鸯撞见');
    expect(calls[0].options).toMatchObject({
      limit: 12,
      themeTags: ['司棋', '潘又安'],
      keywordQueries: ['司棋 第71回鸳鸯撞见司棋与潘又安私会'],
    });
    expect(context.compactSummary).toContain('Current section: 花荫下的私情');
  });

  it('keeps task characters in retrieval tags when section tags are abstract', async () => {
    const calls: Array<{ query: string; options: { limit?: number; themeTags?: string[]; keywordQueries?: string[] } | undefined }> = [];
    const builder = new DefaultContextBuilder({
      sessionStore: { async getSession() { return undefined; } } as never,
      stateStore: { async getRun() { return undefined; } } as never,
      memoryStore: { async getUserProfile() { return memory; } } as never,
      artifactStore: { async getArticle() { return article; } } as never,
      knowledgeStore: {
        async search(query, options) {
          calls.push({ query, options });
          return [];
        },
        async listByRefs() { return []; },
      },
    });

    await builder.build({
      userId: 'u1',
      promptProgramId: 'section-writer',
      articleId: article.id,
      input: {
        articleId: article.id,
        section: {
          id: 'sec_1',
          title: '司棋的刚烈性情',
          goal: '分析司棋不肯受慢待的性情。',
          sourceHints: ['第61回司棋索要鸡蛋'],
          themeTags: ['性格', '刚烈'],
        },
      },
    });

    expect(calls[0].query).toContain('司棋');
    expect(calls[0].options?.themeTags).toEqual(['性格', '刚烈', '司棋']);
    expect(calls[0].options?.keywordQueries).toEqual(['司棋 第61回司棋索要鸡蛋']);
  });

  it('skips knowledge retrieval when a prompt program input opts out', async () => {
    let searchCount = 0;
    const builder = new DefaultContextBuilder({
      sessionStore: { async getSession() { return undefined; } } as never,
      stateStore: { async getRun() { return undefined; } } as never,
      memoryStore: { async getUserProfile() { return memory; } } as never,
      artifactStore: { async getArticle() { return undefined; } } as never,
      knowledgeStore: {
        async search() {
          searchCount += 1;
          return [];
        },
        async listByRefs() { return []; },
      },
    });

    const context = await builder.build({
      userId: 'u1',
      promptProgramId: 'task-card-builder',
      input: {
        rawRequirement: '整体介绍司棋，只使用前80回和脂批。',
        skipKnowledge: true,
      },
    });

    expect(searchCount).toBe(0);
    expect(context.knowledge).toEqual([]);
  });
});
