import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AllowedAction, ArticleArtifact, DialogueBrief, WorkflowRun, WritingTaskCard, nowIso } from '@wa/core';
import { createApp } from './app';
import { createContainer } from './bootstrap';
import { AppConfig } from './config';
import { mergeDialogueBrief } from './dialogueBrief';
import { PiWorkflowActionExecutor } from './piWorkflowActionExecutor';

let dataDir: string | undefined;
afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); dataDir = undefined; });

let fixtureWriteCounter = 0;

async function saveArticleFixture(container: ReturnType<typeof createContainer>, article: ArticleArtifact): Promise<ArticleArtifact> {
  const operationId = `test_fixture_${article.id}_${fixtureWriteCounter += 1}`;
  return container.stores.artifactStore.updateArticleWithRevision({ article, baseRevision: article.revision, operationId });
}

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  dataDir = join(tmpdir(), `wa-api-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return { host: '127.0.0.1', port: 0, dataDir, webOrigin: 'http://localhost:5173', llmProvider: 'mock', openaiBaseURL: 'https://api.openai.com/v1', openaiApiKey: '', openaiModel: 'mock', ragProvider: 'local', ragBaseURL: '', ragApiKey: '', ragSearchPath: '/search', ragRefsPath: '/refs', ragTimeoutMs: 1000, ...overrides };
}

async function startRagServer(): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/search') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as { query?: string };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: 'rag-item-1', title: 'HTTP RAG 命中', content: `检索词：${body.query}`, sourceType: 'external', sourceRef: 'http-rag-1', themeTags: ['rag'], createdAt: new Date().toISOString() }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start RAG test server.');
  return { baseURL: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

async function startTonglingyuRetrieverServer(): Promise<{ baseURL: string; lastRequest: () => Record<string, unknown> | undefined; close: () => Promise<void> }> {
  let lastRequest: Record<string, unknown> | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/retrieve') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    lastRequest = JSON.parse(raw || '{}') as Record<string, unknown>;
    if (Array.isArray(lastRequest.required_evidence_types) && lastRequest.required_evidence_types.includes('commentary')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        evidence_pack: {
          docs: [
            {
              doc_id: 'doc-noise-base-text',
              route: 'bm25',
              content: '司棋正文事件，但不是批语。',
              score: 200,
              metadata: { chunk_kind: 'event', evidence_projection: 'answer_basis', evidence_types: ['base_text'], basis_status: 'required_evidence_type_mismatch' },
              refs: {},
              display: { title: '司棋正文事件' },
            },
            {
              doc_id: 'doc-siqi-commentary',
              route: 'bm25',
              content: '第七十四回批语：余为司棋心动。',
              score: 120,
              source: { citation_hint: '第七十四回批语' },
              metadata: { chunk_kind: 'commentary', evidence_projection: 'answer_basis', evidence_types: ['commentary', 'version_note'], basis_status: 'accepted' },
              refs: { commentary_ids: ['commentary-74-siqi'] },
              display: { title: '第074回｜批语' },
            },
          ],
          sufficiency: { sufficient: true },
        },
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      evidence_pack: {
        docs: [{
          doc_id: 'doc-bd-1',
          route: 'vector',
          content: '宝黛关系的精神相通证据。',
          score: 0.91,
          source: { citation_hint: '第三十二回' },
          metadata: { chunk_kind: 'passage_segment', evidence_projection: 'answer_basis', evidence_types: ['base_text'] },
          refs: { segment_ids: ['seg-32-1'] },
          display: { title: '第三十二回：诉肺腑' },
          source_scope: { chapter_no: 32 },
          usage_policy: { cite_allowed: true },
        }],
        sufficiency: { sufficient: true },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start Tonglingyu retriever test server.');
  return { baseURL: `http://127.0.0.1:${address.port}`, lastRequest: () => lastRequest, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

describe('api app', () => {
  it('responds to health and creates task-card run inline', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/writing/start', payload: { userId: 'test-user', message: '写一篇关于宝黛关系的长文，半文半白', targetStage: 'task-card' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.article.taskCard.topic).toContain('宝黛');
    expect(body.article.workspaceId).toBe('wsp_default_test-user');
    await app.close();
  });

  it('starts writing-autopilot through pi session, operation log, and human gate', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/writing/start', payload: { userId: 'pi-user', message: '写一篇关于宝黛关系的文章。', targetStage: 'task-card' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.workflowId).toBe('writing-autopilot');
    expect(body.run.status).toBe('waiting');
    expect(body.article.taskCard.status).toBe('draft');

    const sessions = await container.stores.piAgentSessionStore.listSessions({ runId: body.run.id });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].articleId).toBe(body.article.id);
    expect(sessions[0].messages.length).toBeGreaterThan(0);

    const operations = await container.stores.workflowOperationStore.listOperations({ runId: body.run.id });
    expect(operations.map((operation) => operation.toolName).sort()).toEqual(['ask_followup', 'build_task_card_draft', 'create_task_card_draft']);
    expect(operations.every((operation) => operation.status === 'completed')).toBe(true);
    expect(operations.find((operation) => operation.toolName === 'build_task_card_draft')?.agentSessionId).toBe(sessions[0].id);

    const gates = await container.stores.humanGateStore.listGates({ runId: body.run.id, statuses: ['pending'] });
    expect(gates).toHaveLength(1);
    expect(gates[0].targetKind).toBe('task-card');

    const resolved = await app.inject({ method: 'POST', url: `/api/workflows/${body.run.id}/human-gates/${gates[0].id}/resolve`, payload: { userId: 'pi-user', decision: 'accept' } });
    expect(resolved.statusCode).toBe(200);
    const resolvedBody = resolved.json();
    expect(resolvedBody.run.status).toBe('completed');
    expect(resolvedBody.article.taskCard.status).toBe('confirmed');
    expect(resolvedBody.humanGates.find((gate: { id: string }) => gate.id === gates[0].id).status).toBe('accepted');
    expect(resolvedBody.operations).toHaveLength(operations.length + 1);
    expect(resolvedBody.operations).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'human_gate_accept', status: 'completed', articleId: body.article.id })]));
    await app.close();
  });

  it('accepts workflow messages only after pending human gates are resolved', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/writing/start', payload: { userId: 'message-user', message: '写一篇关于司棋的文章。', targetStage: 'task-card' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const gateId = body.humanGates[0].id;

    const blocked = await app.inject({ method: 'POST', url: `/api/workflows/${body.run.id}/message`, payload: { userId: 'message-user', message: '补充：不要引用后四十回。' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().gateId).toBe(gateId);

    const rejected = await app.inject({ method: 'POST', url: `/api/workflows/${body.run.id}/human-gates/${gateId}/resolve`, payload: { userId: 'message-user', decision: 'reject' } });
    expect(rejected.statusCode).toBe(200);
    const resumed = await app.inject({ method: 'POST', url: `/api/workflows/${body.run.id}/message`, payload: { userId: 'message-user', message: '补充：不要引用后四十回。', targetStage: 'task-card' } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().run.status).toBe('waiting');
    const session = await container.stores.piAgentSessionStore.getWorkflowSession(body.run.id);
    expect(JSON.stringify(session?.messages)).toContain('补充：不要引用后四十回。');
    await app.close();
  });

  it('requires the workflow owner when cancelling a run', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/writing/start', payload: { userId: 'cancel-user', message: '写一篇关于司棋的文章。', targetStage: 'task-card' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const runId = body.run.id;
    const gateId = body.humanGates[0].id;

    const missingUser = await app.inject({ method: 'POST', url: `/api/workflows/${runId}/cancel`, payload: {} });
    expect(missingUser.statusCode).toBe(400);

    const otherUser = await app.inject({ method: 'POST', url: `/api/workflows/${runId}/cancel`, payload: { userId: 'other-user' } });
    expect(otherUser.statusCode).toBe(403);

    const cancelled = await app.inject({ method: 'POST', url: `/api/workflows/${runId}/cancel`, payload: { userId: 'cancel-user' } });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe('cancelled');
    expect(cancelled.json().humanGates[0].status).toBe('superseded');
    expect((await container.stores.humanGateStore.getGate(gateId))?.status).toBe('superseded');

    const repeated = await app.inject({ method: 'POST', url: `/api/workflows/${runId}/cancel`, payload: { userId: 'cancel-user' } });
    expect(repeated.statusCode).toBe(400);
    await app.close();
  });

  it('rejects workflow tool calls that are not in current allowed actions', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const allowedAction: AllowedAction = {
      id: 'act_allowed',
      operationId: 'op_allowed',
      type: 'create_task_card_draft',
      requiresHumanGate: false,
      reason: 'allowed',
    };
    const forgedAction: AllowedAction = {
      ...allowedAction,
      id: 'act_forged',
      operationId: 'op_forged',
    };
    const run: WorkflowRun = {
      id: 'run_guard',
      workflowId: 'writing-autopilot',
      status: 'running',
      input: { message: '写一篇文章' },
      state: { allowedActions: [allowedAction] },
      metadata: { userId: 'guard-user', workspaceId: 'wsp_guard' },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const executor = new PiWorkflowActionExecutor({ stores: container.stores, agentToolExecutor: container.agentToolExecutor });
    await expect(executor.execute({ policy: { id: 'writing-autopilot', goal: '', allowedActionPolicy: '', humanGatePolicy: '', completionPolicy: '' }, run, action: forgedAction })).rejects.toThrow('Unauthorized workflow action');
    expect(await container.stores.workflowOperationStore.listOperations({ runId: run.id })).toEqual([]);
    await container.close();
  });

  it('creates a revision proposal and blocks writing when the current consistency review has blocking findings', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = nowIso();
    const taskCard: WritingTaskCard = {
      id: 'task-consistency-blocking',
      topic: '一致性阻断测试',
      writingGoal: '测试 blocking review 不会继续生成正文。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['一致性'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: ['后40回'], citationRequired: false, sourcePolicy: '仅以前80回和脂批为依据。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'consistency-block-user', name: '一致性阻断工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'consistency-block-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{
      id: 'sec-consistency-blocking',
      title: '误引后40回的段落',
      goal: '这里故意包含后40回，触发一致性阻断。',
      order: 1,
      expectedBlocks: 1,
      sourceHints: ['后40回'],
      themeTags: ['一致性'],
      status: 'confirmed',
    }];
    await saveArticleFixture(container, article);

    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'consistency-block-user', articleId: article.id, targetStage: 'article' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.run.waitingFor.nodeId).toBe('revision-proposal');
    expect(body.article.blocks).toHaveLength(0);
    expect(body.reviewArtifacts[0].findings.some((finding: { severity: string }) => finding.severity === 'blocking')).toBe(true);
    const proposals = await container.stores.revisionProposalStore.listPendingProposals(article.id, 'consistency-block-user');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].runId).toBe(body.run.id);
    expect(proposals[0].operations[0]).toMatchObject({ type: 'revise-outline' });
    expect(body.revisionProposals).toHaveLength(1);
    expect(body.revisionProposals[0].id).toBe(proposals[0].id);

    const duplicateStart = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'consistency-block-user', articleId: article.id, targetStage: 'article', message: '开始写作' },
    });

    expect(duplicateStart.statusCode).toBe(200);
    const duplicateStartBody = duplicateStart.json();
    expect(duplicateStartBody.run.id).toBe(body.run.id);
    expect(duplicateStartBody.run.status).toBe('waiting');
    expect(duplicateStartBody.run.waitingFor.nodeId).toBe('revision-proposal');
    expect(duplicateStartBody.revisionProposals).toHaveLength(1);
    expect(duplicateStartBody.revisionProposals[0].id).toBe(proposals[0].id);
    expect(duplicateStartBody.messages.at(-1).content).toContain('待确认修改方案');
    expect(await container.stores.revisionProposalStore.listPendingProposals(article.id, 'consistency-block-user')).toHaveLength(1);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/workflows/${body.run.id}/message`,
      payload: { userId: 'consistency-block-user', message: '继续写正文。', targetStage: 'article' },
    });

    expect(resumed.statusCode).toBe(200);
    const resumedBody = resumed.json();
    expect(resumedBody.run.status).toBe('waiting');
    expect(resumedBody.run.waitingFor.nodeId).toBe('revision-proposal');
    expect(resumedBody.article.blocks).toHaveLength(0);
    expect(resumedBody.messages.map((message: { role: string }) => message.role).slice(-2)).toEqual(['user', 'assistant']);
    expect(resumedBody.messages.at(-1).content).toContain('不会继续写入正文');
    const operations = await container.stores.workflowOperationStore.listOperations({ runId: body.run.id });
    expect(operations.map((operation) => operation.toolName).sort()).toEqual(['create_revision_proposal', 'review_task_card_outline_consistency']);
    expect(operations.some((operation) => operation.toolName === 'write_next_section' || operation.toolName === 'write_section')).toBe(false);

    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/workflows/${body.run.id}/message`,
      payload: { userId: 'consistency-block-user', message: '必须只依据前80回，不要沿用后40回。', targetStage: 'article' },
    });

    expect(refreshed.statusCode).toBe(200);
    const refreshedBody = refreshed.json();
    expect(refreshedBody.run.status).toBe('waiting');
    expect(refreshedBody.run.waitingFor.nodeId).toBe('revision-proposal');
    expect(refreshedBody.revisionProposals).toHaveLength(1);
    expect(refreshedBody.revisionProposals[0].id).not.toBe(proposals[0].id);
    expect(refreshedBody.revisionProposals[0].operations[0].instruction).toContain('必须只依据前80回');
    expect(refreshedBody.messages.at(-1).proposalId).toBe(refreshedBody.revisionProposals[0].id);
    expect((await container.stores.revisionProposalStore.getProposal(proposals[0].id))?.status).toBe('dismissed');
    expect((await container.stores.stateStore.getRun(body.run.id))?.state.pendingRevisionProposalId).toBe(refreshedBody.revisionProposals[0].id);

    const dismissed = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue/${refreshedBody.revisionProposals[0].id}/dismiss`,
      payload: { userId: 'consistency-block-user' },
    });

    expect(dismissed.statusCode).toBe(200);
    const dismissedBody = dismissed.json();
    expect(dismissedBody.proposal.status).toBe('dismissed');
    expect(dismissedBody.run.status).toBe('waiting');
    expect(dismissedBody.run.waitingFor.nodeId).toBe('consistency-review');
    expect(dismissedBody.revisionProposals).toHaveLength(0);
    const dismissedRun = await container.stores.stateStore.getRun(body.run.id);
    expect(dismissedRun?.state.pendingRevisionProposalId).toBeUndefined();
    expect(dismissedRun?.state.consistencyBlockingReviewId).toBeTypeOf('string');
    await app.close();
  });

  it('keeps the original workflow proposal when proposal refresh fails', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-coordinator') throw new Error('Dialogue coordinator did not return valid JSON: {"mode":"proposal"');
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const now = nowIso();
    const taskCard: WritingTaskCard = {
      id: 'task-workflow-refresh-failure',
      topic: 'Workflow 方案刷新失败测试',
      writingGoal: '测试 workflow proposal 刷新失败时不丢失原方案。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['一致性'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: ['后40回'], citationRequired: false, sourcePolicy: '仅以前80回和脂批为依据。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'workflow-refresh-fail-user', name: 'Workflow 刷新失败工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'workflow-refresh-fail-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{
      id: 'sec-workflow-refresh-fail',
      title: '误引后40回的段落',
      goal: '这里故意包含后40回，触发一致性阻断。',
      order: 1,
      expectedBlocks: 1,
      sourceHints: ['后40回'],
      themeTags: ['一致性'],
      status: 'confirmed',
    }];
    await saveArticleFixture(container, article);

    const started = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'workflow-refresh-fail-user', articleId: article.id, targetStage: 'article' },
    });
    expect(started.statusCode).toBe(200);
    const startedBody = started.json();
    const originalProposalId = startedBody.revisionProposals[0].id;

    const refreshed = await app.inject({
      method: 'POST',
      url: `/api/workflows/${startedBody.run.id}/message`,
      payload: { userId: 'workflow-refresh-fail-user', message: '必须只依据前80回，不要沿用后40回。', targetStage: 'article' },
    });

    expect(refreshed.statusCode).toBe(200);
    const refreshedBody = refreshed.json();
    expect(refreshedBody.run.status).toBe('waiting');
    expect(refreshedBody.run.waitingFor.nodeId).toBe('revision-proposal');
    expect(refreshedBody.revisionProposals).toHaveLength(1);
    expect(refreshedBody.revisionProposals[0].id).toBe(originalProposalId);
    expect(refreshedBody.messages.at(-1).content).toContain('原方案仍保留');
    expect((await container.stores.revisionProposalStore.getProposal(originalProposalId))?.status).toBe('pending');
    await app.close();
  });

  it('turns polish report warnings into workflow revision proposals without applying them', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = nowIso();
    const taskCard: WritingTaskCard = {
      id: 'task-polish-proposal',
      topic: '统稿建议测试',
      writingGoal: '测试统稿报告会生成待确认修改方案。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['统稿'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'polish-proposal-user', name: '统稿建议工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'polish-proposal-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{
      id: 'sec-polish-1',
      title: '已有正文的大纲项',
      goal: '已有正文，但段落需要修订。',
      order: 1,
      expectedBlocks: 1,
      sourceHints: [],
      themeTags: ['统稿'],
      status: 'written',
    }];
    article.blocks = [{
      id: 'blk-polish-1',
      type: 'paragraph',
      sectionId: 'sec-polish-1',
      title: '已有正文的大纲项',
      text: '这是一段已经生成但需要统稿修订的正文。',
      sourceRefs: [],
      themeTags: ['统稿'],
      status: 'needs_revision',
      createdAt: now,
      updatedAt: now,
    }];
    await saveArticleFixture(container, article);

    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'polish-proposal-user', articleId: article.id, targetStage: 'article' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.run.waitingFor.nodeId).toBe('revision-proposal');
    const polishReport = body.reviewArtifacts.find((artifact: { type: string }) => artifact.type === 'polish-report');
    expect(polishReport.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', targetKind: 'block', targetId: 'blk-polish-1' })]));
    expect(polishReport.suggestions).toHaveLength(1);
    expect(body.revisionProposals).toHaveLength(1);
    expect(body.revisionProposals[0]).toMatchObject({ runId: body.run.id, contextKind: 'block' });
    expect(body.revisionProposals[0].operations[0]).toMatchObject({ type: 'patch-block', blockId: 'blk-polish-1' });
    expect(body.article.blocks[0].text).toBe('这是一段已经生成但需要统稿修订的正文。');
    const operations = await container.stores.workflowOperationStore.listOperations({ runId: body.run.id });
    expect(operations.map((operation) => operation.toolName).sort()).toEqual(['create_revision_proposal', 'generate_polish_report', 'review_task_card_outline_consistency']);
    await app.close();
  });

  it('creates article comments on selected text', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'comment-user', name: '批注工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'comment-user', workspaceId: workspace.id, title: '司棋人物文章' });
    article.blocks = [{
      id: 'blk-comment-1',
      type: 'paragraph',
      sectionId: 'outline-1',
      title: '同侪人物文章',
      text: '迎春的判词与《喜冤家》曲文，预示她终被中山狼所噬；司棋虽有批书人为之心动，亦不免触柱而亡。',
      sourceRefs: [],
      themeTags: [],
      status: 'draft',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }];
    const prepared = await saveArticleFixture(container, article);

    const selectedText = article.blocks[0].text;
    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'comment-user', blockId: 'blk-comment-1', selectedText, comment: '这里似乎是后40回内容，不要引用程高本续书。', baseRevision: prepared.revision },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.comments[0]).toMatchObject({
      articleId: article.id,
      blockId: 'blk-comment-1',
      selectedText,
      comment: '这里似乎是后40回内容，不要引用程高本续书。',
      status: 'open',
    });
    expect(body.blocks[0].text).toBe(article.blocks[0].text);
    const operations = await container.stores.workflowOperationStore.listOperations({ articleId: article.id, userId: 'comment-user' });
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({
      toolName: 'create_article_comment',
      status: 'completed',
      articleRevisionBefore: prepared.revision,
      articleRevisionAfter: body.revision,
    })]));
    await app.close();
  });

  it('processes article comments through writing-autopilot operation logs', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = nowIso();
    const taskCard: WritingTaskCard = {
      id: 'task-comment-workflow',
      topic: '司棋人物文章',
      writingGoal: '依据前80回分析司棋。',
      audience: '普通读者',
      scope: { chapters: ['前80回'], characters: ['司棋'], themes: ['人物'] },
      structure: { articleType: 'analysis', expectedLength: '短文' },
      style: { register: '自然中文', tone: '清楚', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: ['不得引用《红楼梦》后40回（程高本续书）的情节或任何文本'], citationRequired: false, sourcePolicy: '以前80回和脂批为依据。' },
      interactionMode: { askBeforeWriting: false, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'workflow-comment-user', name: 'Workflow 批注工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'workflow-comment-user', workspaceId: workspace.id, title: '司棋人物文章', taskCard });
    article.outline = [{ id: 'sec-comment-workflow', title: '司棋与前80回', goal: '分析司棋人物。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'written' }];
    article.blocks = [{
      id: 'blk-comment-workflow',
      type: 'paragraph',
      sectionId: 'sec-comment-workflow',
      title: '同侪人物文章',
      text: '迎春的判词与《喜冤家》曲文，预示她终被中山狼所噬；司棋虽有批书人为之心动，亦不免触柱而亡。',
      sourceRefs: [],
      themeTags: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    }];
    const prepared = await saveArticleFixture(container, article);

    const selectedText = article.blocks[0].text;
    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'workflow-comment-user', blockId: 'blk-comment-workflow', selectedText, comment: '这里似乎是后40回内容，不要引用程高本续书。', baseRevision: prepared.revision },
    });
    expect(created.statusCode).toBe(200);
    const commentId = created.json().comments[0].id;

    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'workflow-comment-user', articleId: article.id, targetStage: 'article', message: '处理正文批注', commentIds: [commentId] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('completed');
    expect(body.run.state.commentProcessResult).toMatchObject({ processedCount: 1, revised: 1 });
    expect(body.article.comments[0]).toMatchObject({ status: 'resolved', resolutionKind: 'revision' });
    expect(body.article.blocks[0].text).not.toContain('触柱而亡');
    const operations = await container.stores.workflowOperationStore.listOperations({ runId: body.run.id });
    expect(operations.map((operation) => operation.toolName).sort()).toEqual(['process_article_comments', 'resolve_article_comment']);
    expect(operations.find((operation) => operation.toolName === 'process_article_comments')?.articleRevisionBefore).toBe(created.json().revision);
    const commentSessions = await container.stores.piAgentSessionStore.listSessions({ userId: 'workflow-comment-user', articleId: article.id, contextKind: 'article-comment' });
    expect(commentSessions).toHaveLength(1);
    expect(commentSessions[0].targetId).toBe(commentId);
    expect(operations.find((operation) => operation.toolName === 'resolve_article_comment')?.agentSessionId).toBe(commentSessions[0].id);
    await app.close();
  });

  it('adds user replies to article comments and reopens them for processing', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'reply-user', name: '批注回复工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'reply-user', workspaceId: workspace.id, title: '回复测试' });
    article.blocks = [{
      id: 'blk-reply-1',
      type: 'paragraph',
      sectionId: 'outline-1',
      title: '正文',
      text: '这一段需要继续讨论。',
      sourceRefs: [],
      themeTags: [],
      status: 'draft',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }];
    const prepared = await saveArticleFixture(container, article);
    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'reply-user', blockId: 'blk-reply-1', selectedText: '这一段需要继续讨论。', comment: '先解释一下。', baseRevision: prepared.revision },
    });
    const commentId = created.json().comments[0].id;
    const replied = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments/${commentId}/replies`,
      payload: { userId: 'reply-user', content: '补充：这里其实是想改得更清楚。', baseRevision: created.json().revision },
    });
    expect(replied.statusCode).toBe(200);
    expect(replied.json().comments[0].status).toBe('open');
    expect(replied.json().comments[0].replies).toMatchObject([{ role: 'user', content: '补充：这里其实是想改得更清楚。' }]);
    await app.close();
  });

  it('deletes a single article comment reply and restores prior handled state', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'delete-reply-user', name: '删除回复工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'delete-reply-user', workspaceId: workspace.id, title: '删除回复测试' });
    article.blocks = [{
      id: 'blk-delete-reply-1',
      type: 'paragraph',
      sectionId: 'outline-1',
      title: '正文',
      text: '这一段需要保留批注，但删除其中一条回复。',
      sourceRefs: [],
      themeTags: [],
      status: 'draft',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }];
    const prepared = await saveArticleFixture(container, article);
    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'delete-reply-user', blockId: 'blk-delete-reply-1', selectedText: '删除其中一条回复', comment: '这条批注先解释。', baseRevision: prepared.revision },
    });
    const commentId = created.json().comments[0].id;
    const stored = await container.stores.artifactStore.getArticle(article.id);
    const comment = stored?.comments?.[0];
    expect(comment).toBeDefined();
    const handledAt = nowIso();
    Object.assign(comment!, {
      status: 'resolved',
      resolutionKind: 'explanation',
      response: '已经解释过这条批注。',
      replies: [{ id: 'crp-existing-answer', role: 'assistant', content: '已经解释过这条批注。', createdAt: handledAt }],
      resolvedAt: handledAt,
      updatedAt: handledAt,
    });
    const handled = await saveArticleFixture(container, stored!);
    const replied = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments/${commentId}/replies`,
      payload: { userId: 'delete-reply-user', content: '这条新回复还没处理，想删掉。', baseRevision: handled.revision },
    });
    expect(replied.statusCode).toBe(200);
    const replyId = replied.json().comments[0].replies.at(-1).id;
    expect(replied.json().comments[0].status).toBe('open');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}/replies/${replyId}`,
      payload: { userId: 'delete-reply-user', baseRevision: replied.json().revision },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().comments[0].status).toBe('resolved');
    expect(deleted.json().comments[0].resolutionKind).toBe('explanation');
    expect(deleted.json().comments[0].response).toBe('已经解释过这条批注。');
    expect(deleted.json().comments[0].replies).toEqual([{ id: 'crp-existing-answer', role: 'assistant', content: '已经解释过这条批注。', createdAt: handledAt }]);
    expect(deleted.json().blocks[0].text).toBe('这一段需要保留批注，但删除其中一条回复。');
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}/replies/${replyId}`,
      payload: { userId: 'delete-reply-user', baseRevision: replied.json().revision },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().comments[0].replies).toEqual([{ id: 'crp-existing-answer', role: 'assistant', content: '已经解释过这条批注。', createdAt: handledAt }]);
    const protectedReply = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}/replies/crp-existing-answer`,
      payload: { userId: 'delete-reply-user', baseRevision: deleted.json().revision },
    });
    expect(protectedReply.statusCode).toBe(409);
    expect(protectedReply.json().error).toContain('Only unprocessed user replies');
    await app.close();
  });

  it('deletes only unprocessed article comments', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'delete-comment-user', name: '删除批注工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'delete-comment-user', workspaceId: workspace.id, title: '删除批注测试' });
    article.blocks = [{
      id: 'blk-delete-comment-1',
      type: 'paragraph',
      sectionId: 'outline-1',
      title: '正文',
      text: '这一段需要添加和删除批注。',
      sourceRefs: [],
      themeTags: [],
      status: 'draft',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }];
    const prepared = await saveArticleFixture(container, article);

    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'delete-comment-user', blockId: 'blk-delete-comment-1', selectedText: '添加和删除批注', comment: '这条批注还没处理，可以删除。', baseRevision: prepared.revision },
    });
    expect(created.statusCode).toBe(200);
    const commentId = created.json().comments[0].id;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}`,
      payload: { userId: 'delete-comment-user', baseRevision: created.json().revision },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().comments).toEqual([]);
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}`,
      payload: { userId: 'delete-comment-user', baseRevision: created.json().revision },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().comments).toEqual([]);

    const protectedCreated = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'delete-comment-user', blockId: 'blk-delete-comment-1', selectedText: '添加和删除批注', comment: '这条批注已经处理。', baseRevision: deleted.json().revision },
    });
    expect(protectedCreated.statusCode).toBe(200);
    const protectedCommentId = protectedCreated.json().comments[0].id;
    const stored = await container.stores.artifactStore.getArticle(article.id);
    const protectedComment = stored?.comments?.[0];
    expect(protectedComment).toBeDefined();
    const handledAt = nowIso();
    Object.assign(protectedComment!, {
      status: 'resolved',
      resolutionKind: 'explanation',
      response: '已经处理，不能通过删除批注撤销。',
      replies: [{ id: 'crp-protected-answer', role: 'assistant', content: '已经处理，不能通过删除批注撤销。', createdAt: handledAt }],
      resolvedAt: handledAt,
      updatedAt: handledAt,
    });
    const handled = await saveArticleFixture(container, stored!);
    const protectedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${protectedCommentId}`,
      payload: { userId: 'delete-comment-user', baseRevision: handled.revision },
    });
    expect(protectedDelete.statusCode).toBe(409);
    expect(protectedDelete.json().error).toContain('Only unprocessed comments');
    await app.close();
  });

  it('exposes writing-autopilot run state through the workflow API', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/writing/start', payload: { userId: 'test-user', message: '写一篇关于宝黛关系的长文，半文半白', targetStage: 'task-card' } });
    const body = response.json();
    expect(body.run.workflowId).toBe('writing-autopilot');
    const run = await container.stores.stateStore.getRun(body.run.id);
    expect(run?.status).toBe('waiting');
    const runResponse = await app.inject({ method: 'GET', url: `/api/workflows/${body.run.id}` });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json().article.taskCard.status).toBe('draft');
    const listResponse = await app.inject({ method: 'GET', url: '/api/articles?userId=test-user&workspaceId=wsp_default_test-user&view=summary' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject([{ taskStatus: 'draft', outlineCount: 0, blockCount: 0 }]);
    await app.close();
  });

  it('rejects starting a second writing workflow while an article run is active', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = nowIso();
    const taskCard: WritingTaskCard = {
      id: 'task-active-run',
      topic: '并发写作保护',
      writingGoal: '验证同一文章不能并发写作。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['并发'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'active-run-owner', name: '共享写作', memberUserIds: ['active-run-member'] });
    const article = await container.stores.artifactStore.createArticle({ userId: 'active-run-owner', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-active-run', title: '待写章节', goal: '用于验证 active run guard。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'draft' }];
    const prepared = await saveArticleFixture(container, article);
    const activeRun: WorkflowRun = {
      id: 'run-active-article',
      workflowId: 'writing-autopilot',
      status: 'running',
      input: { articleId: prepared.id, targetStage: 'article' },
      state: {},
      metadata: { userId: 'active-run-owner', articleId: prepared.id, workspaceId: workspace.id },
      createdAt: now,
      updatedAt: now,
    };
    await container.stores.stateStore.saveRun(activeRun);

    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'active-run-member', articleId: prepared.id, targetStage: 'article', message: '开始写作' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('当前文章已有写作流程正在执行');
    const articleRuns = (await container.stores.stateStore.listRuns({ workflowId: 'writing-autopilot' })).filter((run) => run.metadata.articleId === prepared.id);
    expect(articleRuns).toHaveLength(1);
    await app.close();
  });

  it('uses sqlite as the persistent store', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { userId: 'persistent-user' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().userId).toBe('persistent-user');
    expect(response.json().currentWorkspaceId).toBe('wsp_default_persistent-user');
    await app.close();
  });

  it('creates a default workspace and shares workspace articles with members', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const defaultResponse = await app.inject({ method: 'GET', url: '/api/workspaces?userId=owner-user' });
    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.json()[0]).toMatchObject({ id: 'wsp_default_owner-user', isDefault: true });
    const workspaceResponse = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { userId: 'owner-user', name: '共享写作', memberUserIds: ['member-user'] } });
    expect(workspaceResponse.statusCode).toBe(201);
    const workspace = workspaceResponse.json();
    const article = await container.stores.artifactStore.createArticle({ userId: 'owner-user', workspaceId: workspace.id, title: '共享任务' });
    const memberListResponse = await app.inject({ method: 'GET', url: `/api/articles?userId=member-user&workspaceId=${workspace.id}&view=summary` });
    expect(memberListResponse.statusCode).toBe(200);
    expect(memberListResponse.json()).toMatchObject([{ id: article.id, title: '共享任务', workspaceId: workspace.id }]);
    const outsiderResponse = await app.inject({ method: 'GET', url: `/api/articles?userId=other-user&workspaceId=${workspace.id}&view=summary` });
    expect(outsiderResponse.statusCode).toBe(403);
    await app.close();
  });

  it('soft deletes custom workspaces by owner only', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const defaultResponse = await app.inject({ method: 'GET', url: '/api/workspaces?userId=workspace-owner' });
    const defaultWorkspace = defaultResponse.json()[0];
    const workspaceResponse = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { userId: 'workspace-owner', name: '可删除工作台', memberUserIds: ['workspace-member'] } });
    const workspace = workspaceResponse.json();
    const memberDelete = await app.inject({ method: 'DELETE', url: `/api/workspaces/${workspace.id}`, payload: { userId: 'workspace-member' } });
    expect(memberDelete.statusCode).toBe(403);
    const defaultDelete = await app.inject({ method: 'DELETE', url: `/api/workspaces/${defaultWorkspace.id}`, payload: { userId: 'workspace-owner' } });
    expect(defaultDelete.statusCode).toBe(400);
    const ownerDelete = await app.inject({ method: 'DELETE', url: `/api/workspaces/${workspace.id}`, payload: { userId: 'workspace-owner' } });
    expect(ownerDelete.statusCode).toBe(200);
    expect(ownerDelete.json().deletedAt).toBeTruthy();
    const listResponse = await app.inject({ method: 'GET', url: '/api/workspaces?userId=workspace-owner' });
    expect(listResponse.json().map((item: { id: string }) => item.id)).not.toContain(workspace.id);
    await app.close();
  });

  it('lists article summaries without full article payloads', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'summary-user', name: '摘要工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'summary-user', workspaceId: workspace.id, title: '摘要测试' });
    article.outline = [{ id: 'sec-1', title: '标题', goal: '目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'draft' }];
    await saveArticleFixture(container, article);
    const response = await app.inject({ method: 'GET', url: `/api/articles?userId=summary-user&workspaceId=${workspace.id}&view=summary` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: article.id, title: '摘要测试', outlineCount: 1, blockCount: 0 });
    expect(body[0].taskCard).toBeUndefined();
    expect(body[0].outline).toBeUndefined();
    await app.close();
  });

  it('soft deletes articles and hides them from normal lists', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'delete-user', name: '删除工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'delete-user', workspaceId: workspace.id, title: '待删除任务' });
    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/articles/${article.id}`, payload: { userId: 'delete-user', baseRevision: article.revision } });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().deletedAt).toBeTruthy();
    const operations = await container.stores.workflowOperationStore.listOperations({ articleId: article.id, userId: 'delete-user' });
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({
      toolName: 'delete_article',
      status: 'completed',
      articleRevisionBefore: article.revision,
      articleRevisionAfter: deleteResponse.json().revision,
    })]));
    const repeatedDeleteResponse = await app.inject({ method: 'DELETE', url: `/api/articles/${article.id}`, payload: { userId: 'delete-user', baseRevision: article.revision } });
    expect(repeatedDeleteResponse.statusCode).toBe(200);
    expect(repeatedDeleteResponse.json().deletedAt).toBeTruthy();
    const hiddenResponse = await app.inject({ method: 'GET', url: `/api/articles/${article.id}?userId=delete-user` });
    expect(hiddenResponse.statusCode).toBe(404);
    const summaryResponse = await app.inject({ method: 'GET', url: `/api/articles?userId=delete-user&workspaceId=${workspace.id}&view=summary` });
    expect(summaryResponse.json()).toHaveLength(0);
    const deletedSummaryResponse = await app.inject({ method: 'GET', url: `/api/articles?userId=delete-user&workspaceId=${workspace.id}&view=summary&includeDeleted=true` });
    expect(deletedSummaryResponse.json()[0].deletedAt).toBeTruthy();
    await app.close();
  });

  it('exposes only public domain profile metadata', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'GET', url: '/api/domain-profiles' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0].id).toBe('hongloumeng-baodai');
    expect(body[0].groups[0].options[0]).toMatchObject({ id: 'unspecified-edition', label: '不限定版本', defaultSelected: true });
    expect(body[0].groups[0].options[1]).toMatchObject({ id: 'zhiyanzhai', label: '脂评本' });
    expect(JSON.stringify(body)).not.toContain('黛玉从不要求宝玉');
    await app.close();
  });

  it('exposes only public writing standard metadata', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'GET', url: '/api/writing-standards' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ id: 'language-era', label: '语言时代感', defaultOptionId: 'natural-traditional' });
    expect(body.options.map((item: { id: string }) => item.id)).toEqual(['natural-traditional', 'modern-analysis', 'academic-commentary']);
    expect(JSON.stringify(body)).not.toContain('mustAvoid');
    expect(JSON.stringify(body)).not.toContain('replacementHints');
    expect(JSON.stringify(body)).not.toContain('sourcePolicies');
    await app.close();
  });

  it('recommends matching domain profiles from a writing requirement', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/domain-profiles/recommend', payload: { rawRequirement: '写一篇关于《红楼梦》中宝黛关系的长文，重点写精神相通。' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ id: 'hongloumeng-baodai', label: '红楼梦：宝黛关系' });
    const triangleResponse = await app.inject({ method: 'POST', url: '/api/domain-profiles/recommend', payload: { rawRequirement: '写一篇关于宝黛钗关系的文章。' } });
    expect(triangleResponse.json()).toEqual([]);
    await app.close();
  });

  it('resolves selected domain profile ids into task card constraints', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: {
        userId: 'profile-user',
        message: '写一篇关于宝黛精神相通的文章。',
        targetStage: 'task-card',
        domainProfile: {
          id: 'hongloumeng-baodai',
          selections: {
            edition: 'zhiyanzhai',
            themes: ['career-economy-boundary'],
            guardrails: ['avoid-absolute-daiyu'],
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.article.taskCard.scope.editions).toContain('脂评本');
    expect(body.article.taskCard.scope.themes).toContain('仕途经济边界');
    expect(body.article.taskCard.constraints.mustInclude.join('\n')).toContain('有规劝');
    expect(body.article.taskCard.constraints.mustAvoid).toContain('黛玉从不要求宝玉');
    await app.close();
  });

  it('resolves language era writing standards into top task rules', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: {
        userId: 'standard-user',
        message: '写一篇关于宝黛关系的文章。',
        targetStage: 'task-card',
        writingStandard: { languageEra: 'natural-traditional', extraForbiddenTerms: ['俗套词'] },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.article.taskCard.topRules.languageEra).toBe('自然传统');
    expect(body.article.taskCard.topRules.summary).toBe('自然、有传统中文文章气息，避免突兀的现代抽象词和学术评论腔。');
    expect(body.article.taskCard.topRules.writingStandards.join('\n')).toContain('语言时代感选择“自然传统”');
    expect(body.article.taskCard.topRules.replacementHints[0]).toMatchObject({ avoid: '价值观' });
    expect(body.article.taskCard.constraints.mustAvoid.join('\n')).toContain('价值观');
    expect(body.article.taskCard.constraints.mustAvoid).toContain('俗套词');
    await app.close();
  });

  it('updates an outline section through the article API', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'outline-user', name: '大纲工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'outline-user', workspaceId: workspace.id, title: '测试文章' });
    article.outline = [{ id: 'sec-1', title: '旧标题', goal: '旧目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }];
    const prepared = await saveArticleFixture(container, article);
    const response = await app.inject({ method: 'PATCH', url: `/api/articles/${article.id}/outline/sec-1`, payload: { title: '新标题', goal: '新目标', userId: 'outline-user', baseRevision: prepared.revision } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outline[0].title).toBe('新标题');
    expect(body.outline[0].goal).toBe('新目标');
    expect(body.versions[body.versions.length - 1].reason).toBe('编辑大纲章节：新标题');
    const operations = await container.stores.workflowOperationStore.listOperations({ articleId: article.id, userId: 'outline-user' });
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({
      toolName: 'manual_edit_outline_item',
      status: 'completed',
      articleRevisionBefore: prepared.revision,
      articleRevisionAfter: body.revision,
    })]));
    await app.close();
  });

  it('clears generated section text when an outline item is edited', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'outline-consistency-user', name: '大纲一致性工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'outline-consistency-user', workspaceId: workspace.id, title: '大纲一致性' });
    article.outline = [
      { id: 'sec-1', title: '旧标题', goal: '旧目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'written' },
      { id: 'sec-2', title: '保留标题', goal: '保留目标', order: 2, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'written' },
    ];
    article.blocks = [
      { id: 'block-1', type: 'paragraph', sectionId: 'sec-1', title: '旧正文', text: '旧大纲项下的正文。', sourceRefs: [], themeTags: [], status: 'draft', createdAt: now, updatedAt: now },
      { id: 'block-2', type: 'paragraph', sectionId: 'sec-2', title: '保留正文', text: '另一节正文。', sourceRefs: [], themeTags: [], status: 'draft', createdAt: now, updatedAt: now },
    ];
    const prepared = await saveArticleFixture(container, article);
    const response = await app.inject({ method: 'PATCH', url: `/api/articles/${article.id}/outline/sec-1`, payload: { title: '新标题', goal: '新目标', userId: 'outline-consistency-user', baseRevision: prepared.revision } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outline.find((item: { id: string }) => item.id === 'sec-1')?.status).toBe('confirmed');
    expect(body.blocks.map((block: { id: string }) => block.id)).not.toContain('block-1');
    expect(body.blocks.map((block: { id: string }) => block.id)).toContain('block-2');
    expect(body.versions[body.versions.length - 1].reason).toContain('清空本节正文');
    await app.close();
  });

  it('clears outline and generated text when applying a task-card revision proposal', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-consistency',
      topic: '旧主题',
      writingGoal: '写一篇分析文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['旧主题'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'consistency-user', name: '一致性工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'consistency-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-old', title: '旧大纲', goal: '旧目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: ['旧主题'], status: 'written' }];
    article.blocks = [{ id: 'block-old', type: 'paragraph', sectionId: 'sec-old', title: '旧正文', text: '旧任务卡下生成的正文。', sourceRefs: [], themeTags: ['旧主题'], status: 'draft', createdAt: now, updatedAt: now }];
    article.citations = [{ id: 'cite-old', label: '旧引用', sourceRef: 'old-ref' }];
    article.themeTags = [{ id: 'tag-old', label: '旧主题', scope: 'article' }];
    await saveArticleFixture(container, article);
    const proposal = await container.stores.revisionProposalStore.createProposal({
      articleId: article.id,
      userId: 'consistency-user',
      contextKind: 'task-card',
      summary: '修订任务卡',
      message: '应用后会更新任务卡并清空下游内容。',
      operations: [{ type: 'revise-task-card', instruction: '主题改为新主题，目标更偏论证。' }],
      warnings: [],
    });
    const response = await app.inject({ method: 'POST', url: `/api/articles/${article.id}/dialogue/${proposal.id}/apply`, payload: { userId: 'consistency-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.article.taskCard.topic).toBe('新主题');
    expect(body.article.outline).toHaveLength(0);
    expect(body.article.blocks).toHaveLength(0);
    expect(body.article.citations).toHaveLength(0);
    expect(body.article.themeTags).toHaveLength(0);
    expect(body.article.versions[body.article.versions.length - 1].reason).toContain('清空下游内容');
    expect(body.proposal.status).toBe('applied');
    const operations = await container.stores.workflowOperationStore.listOperations({ articleId: article.id, userId: 'consistency-user' });
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({
      toolName: 'apply_revise-task-card',
      status: 'completed',
      articleRevisionBefore: body.article.revision - 1,
      articleRevisionAfter: body.article.revision,
    }), expect.objectContaining({
      toolName: 'revise_task_card',
      status: 'completed',
    })]));
    const taskCardAgentSessions = await container.stores.piAgentSessionStore.listSessions({ userId: 'consistency-user', articleId: article.id, contextKind: 'task-card' });
    expect(taskCardAgentSessions).toHaveLength(1);
    expect(operations.find((operation) => operation.toolName === 'revise_task_card')?.agentSessionId).toBe(taskCardAgentSessions[0].id);
    await app.close();
  });

  it('returns conflict instead of server error when applying a stale revision proposal', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-stale-proposal',
      topic: '过期方案',
      writingGoal: '测试过期修改方案。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['过期方案'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'stale-proposal-user', name: '过期方案工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'stale-proposal-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-stale-proposal', title: '旧大纲', goal: '旧目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }];
    const prepared = await saveArticleFixture(container, article);
    const proposal = await container.stores.revisionProposalStore.createProposal({
      articleId: prepared.id,
      userId: 'stale-proposal-user',
      baseRevision: prepared.revision,
      contextKind: 'outline',
      summary: '修订大纲',
      message: '应用后会更新大纲。',
      operations: [{ type: 'revise-outline', instruction: '改成新的大纲安排。' }],
      warnings: [],
    });
    prepared.outline[0].goal = '外部已经改过目标。';
    await saveArticleFixture(container, prepared);

    const response = await app.inject({ method: 'POST', url: `/api/articles/${prepared.id}/dialogue/${proposal.id}/apply`, payload: { userId: 'stale-proposal-user' } });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('Revision proposal is stale');
    expect((await container.stores.revisionProposalStore.getProposal(proposal.id))?.status).toBe('pending');
    await app.close();
  });

  it('confirms a draft task card through workflow HumanGate', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-confirm',
      topic: '待确认主题',
      writingGoal: '写一篇待确认文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['待确认主题'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'confirm-user', name: '确认工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'confirm-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    const started = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'confirm-user', articleId: article.id, targetStage: 'task-card', message: '确认任务卡' },
    });
    expect(started.statusCode).toBe(200);
    const startedBody = started.json();
    expect(startedBody.run.status).toBe('waiting');
    expect(startedBody.humanGates[0]).toMatchObject({ articleId: article.id, targetKind: 'task-card', status: 'pending' });
    const repeatedStart = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'confirm-user', articleId: article.id, targetStage: 'task-card', message: '确认任务卡' },
    });
    expect(repeatedStart.statusCode).toBe(200);
    expect(repeatedStart.json().run.id).toBe(startedBody.run.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/workflows/${startedBody.run.id}/human-gates/${startedBody.humanGates[0].id}/resolve`,
      payload: { userId: 'confirm-user', decision: 'accept' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('completed');
    expect(body.article.taskCard.status).toBe('confirmed');
    expect(body.article.versions.at(-1).reason).toBe('HumanGate 确认任务卡');
    const operations = await container.stores.workflowOperationStore.listOperations({ runId: startedBody.run.id });
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({
      toolName: 'human_gate_accept',
      status: 'completed',
      articleRevisionBefore: article.revision,
      articleRevisionAfter: body.article.revision,
    })]));
    await app.close();
  });

  it('supersedes a stale HumanGate instead of confirming with an old revision', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-stale-gate',
      topic: '过期确认主题',
      writingGoal: '写一篇待确认文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['过期确认主题'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'stale-gate-user', name: '过期确认工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'stale-gate-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    const started = await app.inject({
      method: 'POST',
      url: '/api/workflows/writing/start',
      payload: { userId: 'stale-gate-user', articleId: article.id, targetStage: 'task-card', message: '确认任务卡' },
    });
    expect(started.statusCode).toBe(200);
    const startedBody = started.json();
    const gateId = startedBody.humanGates[0].id;
    article.taskCard!.writingGoal = '文章已经被外部修改过。';
    await saveArticleFixture(container, article);

    const response = await app.inject({
      method: 'POST',
      url: `/api/workflows/${startedBody.run.id}/human-gates/${gateId}/resolve`,
      payload: { userId: 'stale-gate-user', decision: 'accept' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.run.waitingFor.reason).toContain('确认项已过期');
    expect(body.humanGates.find((gate: { id: string }) => gate.id === gateId).status).toBe('superseded');
    expect(body.article.taskCard.status).toBe('draft');
    expect(body.article.taskCard.writingGoal).toBe('文章已经被外部修改过。');
    const operations = await container.stores.workflowOperationStore.listOperations({ runId: startedBody.run.id });
    expect(operations.map((operation) => operation.toolName)).not.toContain('human_gate_accept');
    const events = await container.stores.eventTraceStore.listByRun(startedBody.run.id);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'human_gate.resolved',
      payload: expect.objectContaining({ gateId, decision: 'superseded', stale: true }),
    })]));
    await app.close();
  });

  it('regenerates an outline when an article already has one', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-regen',
      topic: '更新后的主题',
      writingGoal: '按更新后的任务卡重新规划文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['更新后的主题'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'outline-user', name: '重建大纲工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'outline-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'old-sec', title: '旧大纲', goal: '旧目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: ['旧主题'], status: 'confirmed' }];
    article.blocks = [{ id: 'old-block', type: 'paragraph', sectionId: 'old-sec', title: '旧正文', text: '旧大纲下生成过的正文。', sourceRefs: [], themeTags: ['旧主题'], status: 'draft', createdAt: now, updatedAt: now }];
    await saveArticleFixture(container, article);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/writing/start', payload: { articleId: article.id, userId: 'outline-user', targetStage: 'outline', replaceExisting: true, message: '重新生成大纲' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.humanGates[0]).toMatchObject({ targetKind: 'outline', status: 'pending' });
    const resolved = await app.inject({ method: 'POST', url: `/api/workflows/${body.run.id}/human-gates/${body.humanGates[0].id}/resolve`, payload: { userId: 'outline-user', decision: 'accept' } });
    expect(resolved.statusCode).toBe(200);
    const resolvedBody = resolved.json();
    expect(resolvedBody.run.status).toBe('completed');
    expect(resolvedBody.article.outline.map((item: { id: string }) => item.id)).not.toContain('old-sec');
    expect(resolvedBody.article.outline[0].goal).toContain('更新后的主题');
    expect(resolvedBody.article.blocks).toHaveLength(0);
    await app.close();
  });

  it('answers dialogue questions without mutating article artifacts', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    const invokedSkills: string[] = [];
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      invokedSkills.push(skillId);
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-answer',
      topic: '对话解释测试',
      writingGoal: '测试解释不落库。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['对话解释'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-answer-user', name: '对话解释工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-answer-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-dialogue-answer', title: '解释项', goal: '解释项目标。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }];
    await saveArticleFixture(container, article);
    const before = await container.stores.artifactStore.getArticle(article.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-answer-user', message: '为什么这里要这样写？', context: { kind: 'outline-item', outlineItemId: 'sec-dialogue-answer' } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mode).toBe('answer');
    expect(response.json().proposal).toBeUndefined();
    expect(response.json().messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
    const after = await container.stores.artifactStore.getArticle(article.id);
    expect(after?.outline[0].title).toBe(before?.outline[0].title);
    expect(after?.versions).toHaveLength(before?.versions.length ?? 0);
    expect(await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-answer-user')).toHaveLength(0);
    const messagesResponse = await app.inject({ method: 'GET', url: `/api/articles/${article.id}/dialogue/messages?userId=dialogue-answer-user` });
    expect(messagesResponse.statusCode).toBe(200);
    expect(messagesResponse.json()).toHaveLength(2);
    expect(invokedSkills).toEqual([]);
    expect(await container.stores.dialogueBriefStore.getBrief(article.id, 'dialogue-answer-user')).toBeUndefined();
    const piSessions = await container.stores.piAgentSessionStore.listSessions({ userId: 'dialogue-answer-user', articleId: article.id, contextKind: 'outline-item' });
    expect(piSessions).toHaveLength(1);
    expect(piSessions[0].runId).toBeUndefined();
    expect(piSessions[0].targetId).toBe('sec-dialogue-answer');
    expect(piSessions[0].messages.map((message) => (message as { role: string }).role)).toEqual(['user', 'assistant']);
    await app.close();
  });

  it('explains task card citation rules from current structured fields', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    const invokedSkills: string[] = [];
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      invokedSkills.push(skillId);
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-citation-answer',
      topic: '司棋人物文章',
      writingGoal: '介绍司棋。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['司棋'], themes: ['司棋'] },
      structure: { articleType: 'analysis', expectedLength: '1500字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '允许引用原文和脂批，正文以原创分析为主。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-citation-user', name: '引用解释工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-citation-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    const before = await container.stores.artifactStore.getArticle(article.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-citation-user', message: '解释不强制引用', context: { kind: 'task-card' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe('answer');
    expect(body.message).toContain('不强制引用');
    expect(body.message).toContain('不是禁止引用');
    expect(body.message).toContain('允许引用原文和脂批');
    expect(body.proposal).toBeUndefined();

    const typoResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-citation-user', message: '解释不强制应用', context: { kind: 'task-card' } },
    });

    expect(typoResponse.statusCode).toBe(200);
    expect(typoResponse.json().mode).toBe('answer');
    expect(typoResponse.json().message).toContain('按任务卡字段理解为「不强制引用」');
    expect(typoResponse.json().message).toContain('不是禁止引用');
    expect(typoResponse.json().proposal).toBeUndefined();
    expect(invokedSkills).toEqual([]);
    const after = await container.stores.artifactStore.getArticle(article.id);
    expect(after?.versions).toHaveLength(before?.versions.length ?? 0);
    expect(await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-citation-user')).toHaveLength(0);
    await app.close();
  });

  it('persists dialogue proposals and applies them only after confirmation', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-proposal',
      topic: '对话方案测试',
      writingGoal: '测试方案确认后写入。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['对话方案'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-proposal-user', name: '对话方案工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-proposal-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-dialogue-proposal', title: '旧标题', goal: '旧目标。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }];
    await saveArticleFixture(container, article);

    const proposalResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-proposal-user', message: '标题改成新标题。', context: { kind: 'outline-item', outlineItemId: 'sec-dialogue-proposal' } },
    });

    expect(proposalResponse.statusCode).toBe(200);
    const proposalBody = proposalResponse.json();
    expect(proposalBody.mode).toBe('proposal');
    expect(proposalBody.proposal.status).toBe('pending');
    expect((await container.stores.artifactStore.getArticle(article.id))?.outline[0].title).toBe('旧标题');
    const pendingResponse = await app.inject({ method: 'GET', url: `/api/articles/${article.id}/dialogue/proposals?userId=dialogue-proposal-user` });
    expect(pendingResponse.json()).toHaveLength(1);

    const followUpResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-proposal-user', message: '再强调不要沿用旧目标。', pendingProposalId: proposalBody.proposal.id, context: { kind: 'outline-item', outlineItemId: 'sec-dialogue-proposal' } },
    });

    expect(followUpResponse.statusCode).toBe(200);
    const followUpBody = followUpResponse.json();
    expect(followUpBody.mode).toBe('discuss');
    expect(followUpBody.proposal).toBeUndefined();
    expect(followUpBody.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const pendingAfterFollowUp = await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-proposal-user');
    expect(pendingAfterFollowUp).toHaveLength(1);
    expect(pendingAfterFollowUp[0].id).toBe(proposalBody.proposal.id);

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-proposal-user', message: '按以上意见更新方案', pendingProposalId: proposalBody.proposal.id, context: { kind: 'outline-item', outlineItemId: 'sec-dialogue-proposal' } },
    });

    expect(refreshResponse.statusCode).toBe(200);
    const refreshBody = refreshResponse.json();
    expect(refreshBody.mode).toBe('proposal');
    expect(refreshBody.proposal.id).not.toBe(proposalBody.proposal.id);
    expect(refreshBody.proposal.operations[0].instruction).toContain('不要沿用旧目标');
    const pendingAfterRefresh = await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-proposal-user');
    expect(pendingAfterRefresh).toHaveLength(1);
    expect(pendingAfterRefresh[0].id).toBe(refreshBody.proposal.id);

    const applyResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue/${refreshBody.proposal.id}/apply`,
      payload: { userId: 'dialogue-proposal-user' },
    });

    expect(applyResponse.statusCode).toBe(200);
    const applyBody = applyResponse.json();
    expect(applyBody.mode).toBe('applied');
    expect(applyBody.proposal.status).toBe('applied');
    expect(applyBody.article.outline[0].title).toBe('新标题');
    expect(applyBody.article.versions[applyBody.article.versions.length - 1].reason).toContain('修订大纲章节');
    expect(await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-proposal-user')).toHaveLength(0);
    await app.close();
  });

  it('returns a readable dialogue response when proposal JSON is truncated', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-coordinator') throw new Error('Dialogue coordinator did not return valid JSON: {"mode":"proposal","operations":[{"type":"revise-outline"');
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-json-failure',
      topic: '对话截断测试',
      writingGoal: '测试方案 JSON 截断时的响应。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['对话截断'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-json-failure-user', name: '对话截断工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-json-failure-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-json-failure-user', message: '大纲补充一个关键情节。', context: { kind: 'outline' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe('clarify');
    expect(body.message).toContain('方案没有生成成功');
    expect(await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-json-failure-user')).toHaveLength(0);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
    await app.close();
  });

  it('returns a readable dialogue response when coordinator output violates the context contract', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-coordinator') throw new Error('Dialogue coordinator returned empty operation.blockId.');
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-contract-failure',
      topic: '司棋人物文章',
      writingGoal: '撰写司棋人物文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['司棋'], themes: ['司棋'] },
      structure: { articleType: 'analysis', expectedLength: '1500字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-contract-user', name: '对话契约工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-contract-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: {
        userId: 'dialogue-contract-user',
        message: '现在生成的整篇文章，评论和抒情语句有些强烈，需要限制，多用书中情节，人物表现等，辅以一两句评价。',
        context: { kind: 'task-card' },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe('clarify');
    expect(body.message).toContain('方案没有生成成功');
    expect(await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-contract-user')).toHaveLength(0);
    expect(body.messages.map((message: { contextKind: string; role: string }) => `${message.contextKind}:${message.role}`)).toEqual(['task-card:user', 'task-card:assistant']);
    await app.close();
  });

  it('sends compact dialogue brief to the coordinator instead of full assistant history', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    const coordinatorInputs: Array<{ conversation?: Array<{ role: string; content: string }>; conversationBrief?: DialogueBrief }> = [];
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-coordinator') {
        coordinatorInputs.push(input as { conversation?: Array<{ role: string; content: string }>; conversationBrief?: DialogueBrief });
        return { mode: 'proposal', message: '准备更新大纲。', summary: '修订大纲', operations: [{ type: 'revise-outline', instruction: '补充大闹厨房等关键情节。' }], warnings: [] };
      }
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-brief',
      topic: '司棋人物文章',
      writingGoal: '撰写司棋人物文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['司棋'], themes: ['司棋'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-brief-user', name: '对话摘要工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-brief-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-brief-1', title: '旧大纲', goal: '旧目标。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }];
    await saveArticleFixture(container, article);
    const longRagReply = `查到 4 条相关资料：${'司棋脂批资料'.repeat(300)}`;
    await container.stores.dialogueMessageStore.createMessage({ articleId: article.id, userId: 'dialogue-brief-user', contextKind: 'task-card', role: 'assistant', content: longRagReply });

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-brief-user', message: '需要补充大闹厨房情节', context: { kind: 'outline' } },
    });

    expect(response.statusCode).toBe(200);
    expect(coordinatorInputs).toHaveLength(1);
    expect(JSON.stringify(coordinatorInputs[0])).not.toContain('司棋脂批资料司棋脂批资料');
    expect(coordinatorInputs[0].conversation?.map((item) => item.role)).toEqual(['user']);
    expect(coordinatorInputs[0].conversationBrief?.recentUserIntents).toHaveLength(0);
    expect(coordinatorInputs[0].conversationBrief?.activeRequirements).toHaveLength(0);

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-brief-user', message: '按以上意见更新方案', pendingProposalId: response.json().proposal.id, context: { kind: 'outline' } },
    });

    expect(refreshResponse.statusCode).toBe(200);
    expect(coordinatorInputs).toHaveLength(2);
    expect(coordinatorInputs[1].conversationBrief?.recentUserIntents.at(-1)?.text).toContain('大闹厨房');
    expect(coordinatorInputs[1].conversationBrief?.activeRequirements.at(-1)?.text).toContain('大闹厨房');
    const briefSessions = await container.stores.piAgentSessionStore.listSessions({ userId: 'dialogue-brief-user', articleId: article.id, contextKind: 'dialogue-brief' });
    expect(briefSessions.length).toBeGreaterThan(0);
    const briefOperations = await container.stores.workflowOperationStore.listOperations({ agentSessionId: briefSessions[0].id });
    expect(briefOperations.map((operation) => operation.toolName)).toContain('update_dialogue_brief');
    await app.close();
  });

  it('fails closed when dialogue brief updates fail instead of extracting requirements locally', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-brief-updater') throw new Error('brief updater unavailable');
      if (skillId === 'dialogue-coordinator') return { mode: 'proposal', message: '准备修改。', summary: '修订任务', operations: [{ type: 'revise-outline', instruction: '补充大闹厨房。' }], warnings: [] };
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-brief-fail',
      topic: '司棋人物文章',
      writingGoal: '撰写司棋人物文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['司棋'], themes: ['司棋'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-brief-fail-user', name: '对话摘要失败工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-brief-fail-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-brief-fail-1', title: '旧大纲', goal: '旧目标。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }];
    await saveArticleFixture(container, article);

    const firstResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-brief-fail-user', message: '需要补充大闹厨房情节', context: { kind: 'outline' } },
    });
    expect(firstResponse.statusCode).toBe(200);

    const secondResponse = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-brief-fail-user', message: '按以上意见更新方案', pendingProposalId: firstResponse.json().proposal.id, context: { kind: 'outline' } },
    });

    expect(secondResponse.statusCode).toBe(409);
    expect(secondResponse.json().briefStatus.status).toBe('failed');
    const brief = await container.stores.dialogueBriefStore.getBrief(article.id, 'dialogue-brief-fail-user');
    expect(brief?.activeRequirements).toHaveLength(0);
    await app.close();
  });

  it('recovers interrupted dialogue brief jobs before routing the next message', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const coordinatorInputs: Array<{ conversationBrief?: DialogueBrief }> = [];
    const originalInvokeSkill = container.skillExecutor.executeSkill.bind(container.skillExecutor);
    container.skillExecutor.executeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-brief-updater') {
        const message = (input as { message: string }).message;
        return { activeRequirements: [{ kind: 'requirement', text: message }], evidenceNotes: [], recentUserIntents: [message], supersededRequirements: [], conflicts: [] };
      }
      if (skillId === 'dialogue-coordinator') {
        coordinatorInputs.push(input as { conversationBrief?: DialogueBrief });
        return { mode: 'proposal', message: '准备修改。', summary: '修订任务', operations: [{ type: 'revise-outline', instruction: '补充收束段。' }], warnings: [] };
      }
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.skillExecutor.executeSkill;
    const app = createApp(config, container);
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-brief-stale',
      topic: '红楼人物关系文章',
      writingGoal: '撰写人物关系文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['宝玉', '黛玉'], themes: ['人物关系'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-brief-stale-user', name: '对话摘要恢复工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-brief-stale-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-brief-stale-1', title: '旧大纲', goal: '旧目标。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' }];
    await saveArticleFixture(container, article);
    const interruptedJob = await container.stores.dialogueBriefUpdateJobStore.createJob({
      articleId: article.id,
      userId: 'dialogue-brief-stale-user',
      messageId: 'msg-interrupted-brief',
      messageContent: '补充鸳鸯议婚的前置要求',
      contextKind: 'outline',
      contextTitle: '整体大纲',
    });
    await container.stores.dialogueBriefUpdateJobStore.updateJob({
      ...interruptedJob,
      status: 'running',
      attempts: 1,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-brief-stale-user', message: '需要调整大纲，补充收束段', context: { kind: 'outline' } },
    });

    expect(response.statusCode).toBe(200);
    expect(coordinatorInputs[0].conversationBrief?.activeRequirements.map((item) => item.text)).toContain('补充鸳鸯议婚的前置要求');
    const jobs = await container.stores.dialogueBriefUpdateJobStore.listJobs(article.id, 'dialogue-brief-stale-user');
    expect(jobs.find((job) => job.id === interruptedJob.id)?.status).toBe('succeeded');
    await app.close();
  });

  it('lets newer conflicting dialogue requirements supersede older ones by default', () => {
    const now = new Date().toISOString();
    const brief: DialogueBrief = {
      id: 'brief-test',
      articleId: 'art-brief',
      userId: 'brief-user',
      activeRequirements: [],
      evidenceNotes: [],
      recentUserIntents: [],
      unresolvedConflicts: [],
      supersededRequirements: [],
      createdAt: now,
      updatedAt: now,
    };
    const first = mergeDialogueBrief(brief, { activeRequirements: [{ kind: 'avoidance', text: '不要写潘又安' }], evidenceNotes: [], recentUserIntents: ['不要写潘又安'], supersededRequirements: [], conflicts: [] }, 'outline', 'msg-1');
    const replacedByLatest = mergeDialogueBrief(first, { activeRequirements: [{ kind: 'requirement', text: '重点写潘又安' }], evidenceNotes: [], recentUserIntents: ['重点写潘又安'], supersededRequirements: [], conflicts: [] }, 'outline', 'msg-2');
    expect(replacedByLatest.activeRequirements.map((item) => item.text)).toContain('重点写潘又安');
    expect(replacedByLatest.activeRequirements.map((item) => item.text)).not.toContain('不要写潘又安');
    expect(replacedByLatest.supersededRequirements.map((item) => item.text)).toContain('不要写潘又安');
    expect(replacedByLatest.unresolvedConflicts).toHaveLength(0);

    const replaced = mergeDialogueBrief(first, { activeRequirements: [{ kind: 'requirement', text: '改为重点写潘又安' }], evidenceNotes: [], recentUserIntents: ['改为重点写潘又安'], supersededRequirements: [], conflicts: [] }, 'outline', 'msg-3');
    expect(replaced.activeRequirements.map((item) => item.text)).toContain('改为重点写潘又安');
    expect(replaced.supersededRequirements.map((item) => item.text)).toContain('不要写潘又安');
    expect(replaced.unresolvedConflicts).toHaveLength(0);

    const explicitConflict = mergeDialogueBrief(first, { activeRequirements: [], evidenceNotes: [], recentUserIntents: ['既要重点写潘又安又不要写潘又安'], supersededRequirements: [], conflicts: [{ text: '当前消息内部要求冲突', requirements: ['重点写潘又安', '不要写潘又安'] }] }, 'outline', 'msg-4');
    expect(explicitConflict.activeRequirements.map((item) => item.text)).toContain('不要写潘又安');
    expect(explicitConflict.unresolvedConflicts[0].requirements).toEqual(['重点写潘又安', '不要写潘又安']);
  });

  it('records section revisions with readable section titles', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-section-log',
      topic: '章节日志测试',
      writingGoal: '测试章节生成日志。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['章节日志'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'section-log-user', name: '章节日志工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'section-log-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [{ id: 'sec-readable-log', title: '可读章节标题', goal: '写出章节正文。', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: ['章节日志'], status: 'confirmed' }];
    await saveArticleFixture(container, article);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/writing/start', payload: { articleId: article.id, sectionId: 'sec-readable-log', userId: 'section-log-user', targetStage: 'section', message: '生成当前章节正文' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const reason = body.article.versions[body.article.versions.length - 1].reason;
    expect(reason).toBe('pi 生成章节正文：可读章节标题');
    expect(reason).not.toContain('sec-readable-log');
    await app.close();
  });

  it('queries an HTTP RAG provider through the knowledge API', async () => {
    const rag = await startRagServer();
    const config = testConfig({ ragProvider: 'http', ragBaseURL: rag.baseURL });
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/knowledge/search', payload: { query: '宝黛关系', limit: 1 } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body[0].sourceRef).toBe('http-rag-1');
    expect(body[0].content).toContain('宝黛关系');
    await app.close();
    await rag.close();
  });

  it('maps Tonglingyu retriever evidence packs into knowledge items', async () => {
    const retriever = await startTonglingyuRetrieverServer();
    const config = testConfig({ ragProvider: 'tonglingyu', ragBaseURL: retriever.baseURL, ragSearchPath: '/retrieve' });
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/knowledge/search', payload: { query: '宝黛关系', limit: 1, themeTags: ['宝黛'] } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(retriever.lastRequest()?.top_k).toBe(1);
    expect(retriever.lastRequest()?.structured_terms).toEqual(['宝黛']);
    expect(body[0].id).toBe('doc-bd-1');
    expect(body[0].sourceType).toBe('retriever');
    expect(body[0].sourceRef).toBe('tonglingyu:doc-bd-1');
    expect(body[0].title).toBe('第三十二回：诉肺腑');
    expect(body[0].content).toContain('精神相通');
    expect(body[0].themeTags).toContain('vector');
    expect(body[0].metadata.refs.segment_ids).toEqual(['seg-32-1']);
    await app.close();
    await retriever.close();
  });

  it('routes source inclusion instructions to proposals without RAG', async () => {
    const retriever = await startTonglingyuRetrieverServer();
    const config = testConfig({ ragProvider: 'tonglingyu', ragBaseURL: retriever.baseURL, ragSearchPath: '/retrieve' });
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-source-instruction',
      topic: '司棋人物文章',
      writingGoal: '撰写一篇综合全面介绍《红楼梦》人物司棋的文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['司棋'], themes: ['司棋'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-source-user', name: '对话资料约束工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-source-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-source-user', message: '写作中需要包含司棋的脂批内容，可以改写，但不要漏掉了', context: { kind: 'task-card' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe('proposal');
    expect(body.proposal.operations[0]).toMatchObject({ type: 'revise-task-card', instruction: '写作中需要包含司棋的脂批内容，可以改写，但不要漏掉了' });
    expect(retriever.lastRequest()).toBeUndefined();
    await app.close();
    await retriever.close();
  });

  it('keeps source inclusion follow-ups on pending proposals as discussion without RAG', async () => {
    const retriever = await startTonglingyuRetrieverServer();
    const config = testConfig({ ragProvider: 'tonglingyu', ragBaseURL: retriever.baseURL, ragSearchPath: '/retrieve' });
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-source-discussion',
      topic: '司棋人物文章',
      writingGoal: '撰写一篇综合全面介绍《红楼梦》人物司棋的文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['司棋'], themes: ['司棋'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-source-discussion-user', name: '对话资料讨论工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-source-discussion-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    const proposal = await container.stores.revisionProposalStore.createProposal({
      articleId: article.id,
      userId: 'dialogue-source-discussion-user',
      contextKind: 'task-card',
      summary: '修订任务卡',
      message: '我会先准备任务卡修改方案，确认后再写入。',
      operations: [{ type: 'revise-task-card', instruction: '先调整任务卡重点。' }],
      warnings: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-source-discussion-user', message: '写作中需要包含司棋的脂批内容，可以改写，但不要漏掉了', pendingProposalId: proposal.id, context: { kind: 'task-card' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe('discuss');
    expect(body.proposal).toBeUndefined();
    expect(retriever.lastRequest()).toBeUndefined();
    const pending = await container.stores.revisionProposalStore.listPendingProposals(article.id, 'dialogue-source-discussion-user');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(proposal.id);
    const brief = await container.stores.dialogueBriefStore.getBrief(article.id, 'dialogue-source-discussion-user');
    expect(brief?.activeRequirements.at(-1)?.text).toContain('脂批内容');
    await app.close();
    await retriever.close();
  });

  it('uses commentary-scoped RAG for explicit commentary dialogue questions', async () => {
    const retriever = await startTonglingyuRetrieverServer();
    const config = testConfig({ ragProvider: 'tonglingyu', ragBaseURL: retriever.baseURL, ragSearchPath: '/retrieve' });
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-dialogue-rag-commentary',
      topic: '司棋人物文章',
      writingGoal: '撰写一篇综合全面介绍《红楼梦》人物司棋的文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: ['司棋'], themes: ['司棋'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'dialogue-rag-user', name: '对话 RAG 工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'dialogue-rag-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });

    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/dialogue`,
      payload: { userId: 'dialogue-rag-user', message: '脂批中有哪些司棋的批语', context: { kind: 'task-card' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe('answer');
    expect(retriever.lastRequest()?.query).toBe('司棋 脂批 批语');
    expect(retriever.lastRequest()?.required_evidence_types).toEqual(['commentary']);
    expect(body.message).toContain('第074回｜批语');
    expect(body.message).toContain('余为司棋心动');
    expect(body.message).not.toContain('司棋正文事件');
    await app.close();
    await retriever.close();
  });
});
