import { describe, expect, it } from 'vitest';
import type { ArticleArtifact, WorkflowRun } from '@wa/core';
import { AllowedActionPlanner, consistencyReviewSignature } from './allowed-actions';

const now = '2026-07-07T00:00:00.000Z';

function run(state: WorkflowRun['state'] = {}, input: WorkflowRun['input'] = {}): WorkflowRun {
  return {
    id: 'run_1',
    workflowId: 'writing-autopilot',
    status: 'running',
    input,
    state,
    metadata: { userId: 'u1', articleId: 'art_1', workspaceId: 'wsp_1' },
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
    const readyArticle = article({
      outline: [
        { id: 'sec_1', title: '第一节', goal: '写第一节', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' },
        { id: 'sec_2', title: '第二节', goal: '写第二节', order: 2, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' },
      ],
    });
    const actions = planner.plan({
      run: run({ consistencyReviewSignature: consistencyReviewSignature(readyArticle) }),
      article: readyArticle,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('write_next_section');
    expect(actions[0].sectionId).toBe('sec_1');
  });

  it('confirms draft outline before article writing', () => {
    const planner = new AllowedActionPlanner();
    const actions = planner.plan({
      run: run({}, { targetStage: 'article', message: '开始写作' }),
      article: article({
        outline: [
          { id: 'sec_1', title: '第一节', goal: '写第一节', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'draft' },
          { id: 'sec_2', title: '第二节', goal: '写第二节', order: 2, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' },
        ],
      }),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'confirm_outline_for_writing',
      articleId: 'art_1',
      baseRevision: 3,
    });
  });

  it('creates a revision proposal action before writing when a review suggestion is pending', () => {
    const planner = new AllowedActionPlanner();
    const reviewedArticle = article({
      outline: [
        { id: 'sec_1', title: '第一节', goal: '写第一节', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' },
      ],
    });
    const actions = planner.plan({
      run: run({
        consistencyReviewSignature: consistencyReviewSignature(reviewedArticle),
        consistencyBlockingRevision: 3,
        consistencyBlockingReviewId: 'review_1',
        pendingReviewProposal: {
          articleRevision: 3,
          reviewArtifactId: 'review_1',
          suggestionId: 'sug_1',
          targetKind: 'outline',
          summary: '大纲仍包含任务卡要求避免的表达',
        },
      }),
      article: reviewedArticle,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'create_revision_proposal',
      reviewArtifactId: 'review_1',
      suggestionId: 'sug_1',
      targetKind: 'outline',
      baseRevision: 3,
    });
  });

  it('routes explicit comment-processing intent to a comment workflow action only', () => {
    const planner = new AllowedActionPlanner();
    const withOpenComment = article({
      outline: [{ id: 'sec_1', title: '第一节', goal: '写第一节', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'written' }],
      blocks: [{ id: 'blk_1', type: 'paragraph', sectionId: 'sec_1', text: '这是一段正文。', sourceRefs: [], themeTags: [], status: 'draft', createdAt: now, updatedAt: now }],
      comments: [{ id: 'cmt_1', articleId: 'art_1', blockId: 'blk_1', selectedText: '正文', comment: '处理这条批注', status: 'open', createdAt: now, updatedAt: now }],
    });
    const actions = planner.plan({
      run: run({}, { targetStage: 'article', message: '处理正文批注', commentIds: ['cmt_1'] }),
      article: withOpenComment,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'process_article_comments', targetKind: 'article-comments', baseRevision: 3 });

    const completed = planner.plan({
      run: run({ commentProcessResult: { articleRevision: 4, processedCount: 1, revised: 1, explained: 0, questions: 0 } }, { targetStage: 'article', message: '处理正文批注', commentIds: ['cmt_1'] }),
      article: { ...withOpenComment, revision: 4, comments: [{ ...withOpenComment.comments![0], status: 'resolved' }] },
    });
    expect(completed).toEqual([]);
  });

  it('requires a human gate before replacing an existing outline', () => {
    const planner = new AllowedActionPlanner();
    const actions = planner.plan({
      run: run({}, { targetStage: 'outline', replaceExisting: true }),
      article: article({
        outline: [{ id: 'sec_1', title: '旧大纲', goal: '旧目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }],
      }),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('request_human_gate');
    expect(actions[0].requiresHumanGate).toBe(true);

    const approved = planner.plan({
      run: run({ outlineReplacementApprovedRevision: 3 }, { targetStage: 'outline', replaceExisting: true }),
      article: article({
        outline: [{ id: 'sec_1', title: '旧大纲', goal: '旧目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }],
      }),
    });
    expect(approved[0].type).toBe('plan_outline');
  });
});
