import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArticleArtifact, WritingTaskCard, nowIso } from '@wa/core';
import { createApp } from './app';
import { createContainer } from './bootstrap';
import { AppConfig } from './config';

let dataDir: string | undefined;
let fixtureWriteCounter = 0;

afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  dataDir = join(tmpdir(), `wa-autopilot-acceptance-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webOrigin: 'http://localhost:5173',
    llmProvider: 'mock',
    openaiBaseURL: 'https://api.openai.com/v1',
    openaiApiKey: '',
    openaiModel: 'mock',
    ragProvider: 'local',
    ragBaseURL: '',
    ragApiKey: '',
    ragSearchPath: '/search',
    ragRefsPath: '/refs',
    ragTimeoutMs: 1000,
    ...overrides,
  };
}

async function saveArticleFixture(container: ReturnType<typeof createContainer>, article: ArticleArtifact): Promise<ArticleArtifact> {
  fixtureWriteCounter += 1;
  return container.stores.artifactStore.updateArticleWithRevision({
    article,
    baseRevision: article.revision,
    operationId: `acceptance_fixture_${article.id}_${fixtureWriteCounter}`,
  });
}

function confirmedTaskCard(id: string, topic: string, patch: Partial<WritingTaskCard> = {}): WritingTaskCard {
  const now = nowIso();
  return {
    id,
    topic,
    writingGoal: `围绕「${topic}」写一篇结构清楚的文章。`,
    audience: '普通读者',
    scope: { editions: [], chapters: [], characters: [], themes: [topic] },
    structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '先提出问题，再分层展开。' },
    style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
    constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
    interactionMode: { askBeforeWriting: true, localEditFirst: true },
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

describe('writing-autopilot acceptance', () => {
  it('creates a task, confirms generated outline, and writes sections through pi workflow actions', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);

    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'acceptance-user', message: '写一篇关于司棋的文章，不要太学术。', targetStage: 'task-card' },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json();
    expect(createdBody.run.workflowId).toBe('writing-autopilot');
    expect(createdBody.run.status).toBe('waiting');
    expect(createdBody.article.taskCard.status).toBe('draft');
    expect(createdBody.humanGates).toEqual(expect.arrayContaining([expect.objectContaining({ targetKind: 'task-card', status: 'pending' })]));

    const gate = createdBody.humanGates.find((item: { status: string; targetKind: string }) => item.status === 'pending' && item.targetKind === 'task-card');
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/workflows/${createdBody.run.id}/human-gates/${gate.id}/resolve`,
      payload: { userId: 'acceptance-user', decision: 'accept' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().article.taskCard.status).toBe('confirmed');

    const outlined = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'acceptance-user', articleId: createdBody.article.id, targetStage: 'outline', message: '生成大纲' },
    });
    expect(outlined.statusCode).toBe(200);
    const outlinedBody = outlined.json();
    expect(outlinedBody.article.outline).toHaveLength(4);
    expect(outlinedBody.article.outline.every((item: { status: string }) => item.status === 'draft')).toBe(true);

    const written = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'acceptance-user', articleId: createdBody.article.id, targetStage: 'article', message: '开始写作' },
    });
    expect(written.statusCode).toBe(200);
    const writtenBody = written.json();
    expect(writtenBody.run.status).toBe('completed');
    expect(writtenBody.revisionProposals).toHaveLength(0);
    expect(writtenBody.article.outline.every((item: { status: string }) => item.status === 'written')).toBe(true);
    expect(writtenBody.article.blocks).toHaveLength(writtenBody.article.outline.length);
    const chronologicalWorkflowTools = [...writtenBody.operations]
      .reverse()
      .filter((operation: { agentSessionId?: string }) => !operation.agentSessionId)
      .map((operation: { toolName: string }) => operation.toolName);
    expect(chronologicalWorkflowTools).toEqual([
      'confirm_outline_for_writing',
      'review_task_card_outline_consistency',
      'write_next_section',
      'write_next_section',
      'write_next_section',
      'write_next_section',
      'generate_polish_report',
    ]);
    const skillTools = writtenBody.operations.filter((operation: { agentSessionId?: string }) => operation.agentSessionId).map((operation: { toolName: string }) => operation.toolName);
    expect(skillTools.sort()).toEqual(['write_section', 'write_section', 'write_section', 'write_section']);
    expect(writtenBody.reviewArtifacts.map((artifact: { type: string }) => artifact.type)).toEqual(expect.arrayContaining(['consistency-review', 'polish-report']));
    await app.close();
  });

  it('processes article comments as an isolated writing-autopilot action', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'comment-acceptance-user', name: '批注验收工作台' });
    const article = await container.stores.artifactStore.createArticle({
      userId: 'comment-acceptance-user',
      workspaceId: workspace.id,
      title: '批注处理验收',
      taskCard: confirmedTaskCard('task-comment-acceptance', '批注处理验收', {
        constraints: { mustInclude: [], mustAvoid: ['不得引用《红楼梦》后40回（程高本续书）的情节或任何文本'], citationRequired: false, sourcePolicy: '以前80回和脂批为依据。' },
      }),
    });
    const now = nowIso();
    article.outline = [{ id: 'sec-comment-acceptance', title: '司棋段落', goal: '分析司棋。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'written' }];
    article.blocks = [{
      id: 'blk-comment-acceptance',
      type: 'paragraph',
      sectionId: 'sec-comment-acceptance',
      title: '司棋段落',
      text: '迎春的判词与《喜冤家》曲文，预示她终被中山狼所噬；司棋亦不免触柱而亡。',
      sourceRefs: [],
      themeTags: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }];
    const prepared = await saveArticleFixture(container, article);
    const selectedText = prepared.blocks[0].text;
    const comment = await app.inject({
      method: 'POST',
      url: `/api/articles/${prepared.id}/comments`,
      payload: { userId: 'comment-acceptance-user', blockId: 'blk-comment-acceptance', selectedText, comment: '这里似乎是后40回内容，不要引用程高本续书。', baseRevision: prepared.revision },
    });
    expect(comment.statusCode).toBe(200);
    const commentId = comment.json().comments[0].id;

    const processed = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'comment-acceptance-user', articleId: prepared.id, targetStage: 'article', message: '处理正文批注', commentIds: [commentId] },
    });
    expect(processed.statusCode).toBe(200);
    const processedBody = processed.json();
    expect(processedBody.run.status).toBe('completed');
    expect(processedBody.run.state.commentProcessResult).toMatchObject({ processedCount: 1, revised: 1 });
    expect(processedBody.article.comments[0]).toMatchObject({ status: 'resolved', resolutionKind: 'revision' });
    expect(processedBody.article.blocks[0].text).not.toContain('触柱而亡');
    expect(processedBody.operations.map((operation: { toolName: string }) => operation.toolName).sort()).toEqual(['process_article_comments', 'resolve_article_comment']);
    expect(processedBody.operations.find((operation: { toolName: string }) => operation.toolName === 'resolve_article_comment')?.agentSessionId).toBeTruthy();
    await app.close();
  });

  it('turns polish findings into a pending proposal without mutating article text', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'polish-acceptance-user', name: '统稿验收工作台' });
    const article = await container.stores.artifactStore.createArticle({
      userId: 'polish-acceptance-user',
      workspaceId: workspace.id,
      title: '统稿验收',
      taskCard: confirmedTaskCard('task-polish-acceptance', '统稿验收'),
    });
    const now = nowIso();
    article.outline = [{ id: 'sec-polish-acceptance', title: '已有正文', goal: '已有正文但需要统稿。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'written' }];
    article.blocks = [{
      id: 'blk-polish-acceptance',
      type: 'paragraph',
      sectionId: 'sec-polish-acceptance',
      title: '已有正文',
      text: '这是一段已经生成但需要统稿修订的正文。',
      sourceRefs: [],
      themeTags: [],
      status: 'needs_revision',
      createdAt: now,
      updatedAt: now,
    }];
    const prepared = await saveArticleFixture(container, article);

    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'polish-acceptance-user', articleId: prepared.id, targetStage: 'article', message: '开始写作' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.run.waitingFor.nodeId).toBe('revision-proposal');
    expect(body.revisionProposals).toHaveLength(1);
    expect(body.revisionProposals[0].operations[0]).toMatchObject({ type: 'patch-block', blockId: 'blk-polish-acceptance' });
    expect(body.article.blocks[0].text).toBe(prepared.blocks[0].text);
    expect(body.operations.map((operation: { toolName: string }) => operation.toolName).sort()).toEqual(['create_revision_proposal', 'generate_polish_report', 'review_task_card_outline_consistency']);
    await app.close();
  });
});
