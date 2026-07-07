import { describe, expect, it } from 'vitest';
import { AllowedActionPlanner, type ArticleArtifact, type WorkflowRun } from './index';

const now = '2026-07-07T00:00:00.000Z';

function run(state: WorkflowRun['state'] = {}): WorkflowRun {
  return {
    id: 'run_1',
    workflowId: 'writing-autopilot',
    status: 'running',
    input: {},
    state,
    metadata: { userId: 'u1', articleId: 'art_1', workspaceId: 'wsp_1' },
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

function article(patch: Partial<ArticleArtifact> = {}): ArticleArtifact {
  return {
    id: 'art_1',
    userId: 'u1',
    workspaceId: 'wsp_1',
    revision: 3,
    title: '测试文章',
    taskCard: {
      id: 'card_1',
      topic: '测试文章',
      writingGoal: '测试',
      audience: '读者',
      scope: {},
      structure: { articleType: 'essay', expectedLength: '短篇' },
      style: { register: '自然', tone: '克制', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '不强制引用' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    },
    outline: [],
    blocks: [],
    citations: [],
    themeTags: [],
    comments: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

describe('AllowedActionPlanner', () => {
  it('generates stable operation ids for the same run and revision', () => {
    const planner = new AllowedActionPlanner();
    const first = planner.plan({ run: run(), article: article() });
    const second = planner.plan({ run: run(), article: article() });
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual(second[0]);
    expect(first[0].type).toBe('plan_outline');
    expect(first[0].baseRevision).toBe(3);
  });

  it('does not expose actions while a human gate is pending', () => {
    const planner = new AllowedActionPlanner();
    expect(planner.plan({ run: run(), article: article(), pendingHumanGate: true })).toEqual([]);
  });

  it('exposes only one next-section writing action', () => {
    const planner = new AllowedActionPlanner();
    const actions = planner.plan({
      run: run({ consistencyReviewRevision: 3 }),
      article: article({
        outline: [
          { id: 'sec_1', title: '第一节', goal: '写第一节', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' },
          { id: 'sec_2', title: '第二节', goal: '写第二节', order: 2, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' },
        ],
      }),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('write_next_section');
    expect(actions[0].sectionId).toBe('sec_1');
  });
});
