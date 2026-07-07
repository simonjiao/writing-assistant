import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DialogueBrief, WritingTaskCard, nowIso } from '@wa/core';
import { createApp } from './app';
import { createContainer } from './bootstrap';
import { AppConfig } from './config';
import { mergeDialogueBrief } from './dialogueBrief';

let dataDir: string | undefined;
afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); dataDir = undefined; });

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  dataDir = join(tmpdir(), `wa-api-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return { host: '127.0.0.1', port: 0, dataDir, webOrigin: 'http://localhost:5173', llmProvider: 'mock', openaiBaseURL: 'https://api.openai.com/v1', openaiApiKey: '', openaiModel: 'mock', workflowExecutionMode: 'inline', workflowQueueDriver: 'local', enableWorkers: true, runnerConcurrency: 2, redisUrl: 'redis://localhost:6379', ragProvider: 'local', ragBaseURL: '', ragApiKey: '', ragSearchPath: '/search', ragRefsPath: '/refs', ragTimeoutMs: 1000, ...overrides };
}

async function waitForRun(container: ReturnType<typeof createContainer>, runId: string, statuses: string[]) {
  for (let i = 0; i < 40; i += 1) {
    const run = await container.engine.getRun(runId);
    if (run && statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run did not reach statuses: ${statuses.join(',')}`);
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
    const response = await app.inject({ method: 'POST', url: '/api/workflows/task-card/start', payload: { userId: 'test-user', rawRequirement: '写一篇关于宝黛关系的长文，半文半白' } });
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

    const operations = await container.stores.workflowOperationStore.listOperations({ runId: body.run.id });
    expect(operations.map((operation) => operation.toolName)).toEqual(['ask_followup', 'create_task_card_draft']);
    expect(operations.every((operation) => operation.status === 'completed')).toBe(true);

    const gates = await container.stores.humanGateStore.listGates({ runId: body.run.id, statuses: ['pending'] });
    expect(gates).toHaveLength(1);
    expect(gates[0].targetKind).toBe('task-card');

    const resolved = await app.inject({ method: 'POST', url: `/api/workflows/${body.run.id}/human-gates/${gates[0].id}/resolve`, payload: { userId: 'pi-user', decision: 'accept' } });
    expect(resolved.statusCode).toBe(200);
    const resolvedBody = resolved.json();
    expect(resolvedBody.run.status).toBe('completed');
    expect(resolvedBody.article.taskCard.status).toBe('confirmed');
    expect(resolvedBody.humanGates.find((gate: { id: string }) => gate.id === gates[0].id).status).toBe('accepted');
    expect(resolvedBody.operations).toHaveLength(operations.length);
    await app.close();
  });

  it('creates article comments and batch processes them into text revisions', async () => {
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
    await container.stores.artifactStore.updateArticle(article);

    const selectedText = article.blocks[0].text;
    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'comment-user', blockId: 'blk-comment-1', selectedText, comment: '这里似乎是后40回内容，不要引用程高本续书。' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().comments[0].status).toBe('open');

    const processed = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments/process`,
      payload: { userId: 'comment-user' },
    });
    expect(processed.statusCode).toBe(200);
    const body = processed.json();
    expect(body.results[0].action).toBe('revise');
    expect(body.results[0].changed).toBe(true);
    expect(body.article.comments[0].status).toBe('resolved');
    expect(body.article.comments[0].resolutionKind).toBe('revision');
    expect(body.article.comments[0].response).toContain('前80回');
    expect(body.article.comments[0].replies.at(-1)).toMatchObject({ role: 'assistant' });
    expect(body.article.blocks[0].text).not.toContain('触柱而亡');
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
    await container.stores.artifactStore.updateArticle(article);
    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'reply-user', blockId: 'blk-reply-1', selectedText: '这一段需要继续讨论。', comment: '先解释一下。' },
    });
    const commentId = created.json().comments[0].id;
    const replied = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments/${commentId}/replies`,
      payload: { userId: 'reply-user', content: '补充：这里其实是想改得更清楚。' },
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
    await container.stores.artifactStore.updateArticle(article);
    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'delete-reply-user', blockId: 'blk-delete-reply-1', selectedText: '删除其中一条回复', comment: '这条批注先解释。' },
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
    await container.stores.artifactStore.updateArticle(stored!);
    const replied = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments/${commentId}/replies`,
      payload: { userId: 'delete-reply-user', content: '这条新回复还没处理，想删掉。' },
    });
    expect(replied.statusCode).toBe(200);
    const replyId = replied.json().comments[0].replies.at(-1).id;
    expect(replied.json().comments[0].status).toBe('open');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}/replies/${replyId}`,
      payload: { userId: 'delete-reply-user' },
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
      payload: { userId: 'delete-reply-user' },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().comments[0].replies).toEqual([{ id: 'crp-existing-answer', role: 'assistant', content: '已经解释过这条批注。', createdAt: handledAt }]);
    const protectedReply = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}/replies/crp-existing-answer`,
      payload: { userId: 'delete-reply-user' },
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
    await container.stores.artifactStore.updateArticle(article);

    const created = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'delete-comment-user', blockId: 'blk-delete-comment-1', selectedText: '添加和删除批注', comment: '这条批注还没处理，可以删除。' },
    });
    expect(created.statusCode).toBe(200);
    const commentId = created.json().comments[0].id;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}`,
      payload: { userId: 'delete-comment-user' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().comments).toEqual([]);
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${commentId}`,
      payload: { userId: 'delete-comment-user' },
    });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().comments).toEqual([]);

    const protectedCreated = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/comments`,
      payload: { userId: 'delete-comment-user', blockId: 'blk-delete-comment-1', selectedText: '添加和删除批注', comment: '这条批注已经处理。' },
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
    await container.stores.artifactStore.updateArticle(stored!);
    const protectedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/articles/${article.id}/comments/${protectedCommentId}`,
      payload: { userId: 'delete-comment-user' },
    });
    expect(protectedDelete.statusCode).toBe(409);
    expect(protectedDelete.json().error).toContain('Only unprocessed comments');
    await app.close();
  });

  it('runs workflows through the local async queue', async () => {
    const config = testConfig({ workflowExecutionMode: 'async' });
    const container = createContainer(config);
    const app = createApp(config, container);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/task-card/start', payload: { userId: 'test-user', rawRequirement: '写一篇关于宝黛关系的长文，半文半白' } });
    const body = response.json();
    expect(['queued', 'running', 'waiting']).toContain(body.run.status);
    const run = await waitForRun(container, body.run.id, ['waiting']);
    expect(run.status).toBe('waiting');
    const runResponse = await app.inject({ method: 'GET', url: `/api/runs/${body.run.id}` });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json().article.taskCard.status).toBe('draft');
    const listResponse = await app.inject({ method: 'GET', url: '/api/articles?userId=test-user&workspaceId=wsp_default_test-user&view=summary' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject([{ taskStatus: 'draft', outlineCount: 0, blockCount: 0 }]);
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
    await container.stores.artifactStore.updateArticle(article);
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
    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/articles/${article.id}`, payload: { userId: 'delete-user' } });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().deletedAt).toBeTruthy();
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
      url: '/api/workflows/task-card/start',
      payload: {
        userId: 'profile-user',
        rawRequirement: '写一篇关于宝黛精神相通的文章。',
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
      url: '/api/workflows/task-card/start',
      payload: {
        userId: 'standard-user',
        rawRequirement: '写一篇关于宝黛关系的文章。',
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
    await container.stores.artifactStore.updateArticle(article);
    const response = await app.inject({ method: 'PATCH', url: `/api/articles/${article.id}/outline/sec-1`, payload: { title: '新标题', goal: '新目标', userId: 'outline-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outline[0].title).toBe('新标题');
    expect(body.outline[0].goal).toBe('新目标');
    expect(body.versions[body.versions.length - 1].reason).toBe('编辑大纲章节：新标题');
    await app.close();
  });

  it('starts writing by accepting the current outline through the article API', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'outline-confirm-user', name: '开始写作工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'outline-confirm-user', workspaceId: workspace.id, title: '待开始写作' });
    article.outline = [{ id: 'sec-1', title: '草稿标题', goal: '草稿目标', order: 1, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'draft' }];
    await container.stores.artifactStore.updateArticle(article);
    const response = await app.inject({ method: 'POST', url: `/api/articles/${article.id}/writing/start`, payload: { userId: 'outline-confirm-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outline[0].status).toBe('confirmed');
    expect(body.versions[body.versions.length - 1].reason).toBe('开始写作');
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
    await container.stores.artifactStore.updateArticle(article);
    const response = await app.inject({ method: 'PATCH', url: `/api/articles/${article.id}/outline/sec-1`, payload: { title: '新标题', goal: '新目标', userId: 'outline-consistency-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outline.find((item: { id: string }) => item.id === 'sec-1')?.status).toBe('confirmed');
    expect(body.blocks.map((block: { id: string }) => block.id)).not.toContain('block-1');
    expect(body.blocks.map((block: { id: string }) => block.id)).toContain('block-2');
    expect(body.versions[body.versions.length - 1].reason).toContain('清空本节正文');
    await app.close();
  });

  it('revises a task card through the article API', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-1',
      topic: '旧主题',
      writingGoal: '写一篇分析文章。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['旧主题'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'task-card-user', name: '任务卡工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'task-card-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    const response = await app.inject({ method: 'POST', url: `/api/articles/${article.id}/task-card/revise`, payload: { instruction: '主题改为新主题，目标更偏论证。', userId: 'task-card-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.article.title).toBe('新主题');
    expect(body.article.taskCard.topic).toBe('新主题');
    expect(body.article.taskCard.status).toBe('draft');
    expect(body.changedFields).toContain('topic');
    expect(body.article.versions[body.article.versions.length - 1].reason).toContain('修订任务卡');
    await app.close();
  });

  it('clears outline and generated text when a task card changes', async () => {
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
    await container.stores.artifactStore.updateArticle(article);
    const response = await app.inject({ method: 'POST', url: `/api/articles/${article.id}/task-card/revise`, payload: { instruction: '主题改为新主题，目标更偏论证。', userId: 'consistency-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.article.taskCard.topic).toBe('新主题');
    expect(body.article.outline).toHaveLength(0);
    expect(body.article.blocks).toHaveLength(0);
    expect(body.article.citations).toHaveLength(0);
    expect(body.article.themeTags).toHaveLength(0);
    expect(body.article.versions[body.article.versions.length - 1].reason).toContain('清空下游内容');
    await app.close();
  });

  it('confirms a draft task card through the article API', async () => {
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
    const response = await app.inject({ method: 'POST', url: `/api/articles/${article.id}/task-card/confirm`, payload: { userId: 'confirm-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.taskCard.status).toBe('confirmed');
    expect(body.versions[body.versions.length - 1].reason).toBe('确认任务卡');
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
    await container.stores.artifactStore.updateArticle(article);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/outline/start', payload: { articleId: article.id, userId: 'outline-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.run.status).toBe('waiting');
    expect(body.article.outline.map((item: { id: string }) => item.id)).not.toContain('old-sec');
    expect(body.article.outline[0].goal).toContain('更新后的主题');
    expect(body.article.blocks).toHaveLength(0);
    await app.close();
  });

  it('revises a single outline section through the outline revision API', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const app = createApp(config, container);
    const now = new Date().toISOString();
    const taskCard: WritingTaskCard = {
      id: 'task-outline-revise',
      topic: '大纲局部修订',
      writingGoal: '测试只修订一个大纲项。',
      audience: '普通读者',
      scope: { editions: [], chapters: [], characters: [], themes: ['大纲局部修订'] },
      structure: { articleType: 'analysis', expectedLength: '1200字', outlinePreference: '分层展开。' },
      style: { register: '清晰自然的中文', tone: '稳健、可读', classicalFlavor: false },
      constraints: { mustInclude: [], mustAvoid: [], citationRequired: false, sourcePolicy: '按任务卡写作。' },
      interactionMode: { askBeforeWriting: true, localEditFirst: true },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    };
    const workspace = await container.stores.workspaceStore.createWorkspace({ userId: 'outline-revise-user', name: '大纲修订工作台' });
    const article = await container.stores.artifactStore.createArticle({ userId: 'outline-revise-user', workspaceId: workspace.id, title: taskCard.topic, taskCard });
    article.outline = [
      { id: 'sec-revise-1', title: '旧标题', goal: '旧目标。', order: 1, expectedBlocks: 2, sourceHints: ['旧来源'], themeTags: ['旧标签'], status: 'confirmed' },
      { id: 'sec-revise-2', title: '保留标题', goal: '保留目标。', order: 2, expectedBlocks: 1, sourceHints: [], themeTags: [], status: 'confirmed' },
    ];
    await container.stores.artifactStore.updateArticle(article);
    const response = await app.inject({
      method: 'POST',
      url: `/api/articles/${article.id}/outline/sec-revise-1/revise`,
      payload: { userId: 'outline-revise-user', instruction: '标题改成新标题，目标不要说成完全反对。' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outlineItem.id).toBe('sec-revise-1');
    expect(body.outlineItem.title).toBe('新标题');
    expect(body.outlineItem.order).toBe(1);
    expect(body.outlineItem.status).toBe('confirmed');
    expect(body.article.taskCard.topic).toBe('大纲局部修订');
    expect(body.article.outline.find((item: { id: string }) => item.id === 'sec-revise-2')?.title).toBe('保留标题');
    expect(body.article.versions[body.article.versions.length - 1].reason).toContain('修订大纲章节');
    await app.close();
  });

  it('answers dialogue questions without mutating article artifacts', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.runtime.invokeSkill.bind(container.runtime);
    const invokedSkills: string[] = [];
    container.runtime.invokeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      invokedSkills.push(skillId);
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.runtime.invokeSkill;
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
    await container.stores.artifactStore.updateArticle(article);
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
    await app.close();
  });

  it('explains task card citation rules from current structured fields', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.runtime.invokeSkill.bind(container.runtime);
    const invokedSkills: string[] = [];
    container.runtime.invokeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      invokedSkills.push(skillId);
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.runtime.invokeSkill;
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
    await container.stores.artifactStore.updateArticle(article);

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
    const originalInvokeSkill = container.runtime.invokeSkill.bind(container.runtime);
    container.runtime.invokeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-coordinator') throw new Error('Dialogue coordinator did not return valid JSON: {"mode":"proposal","operations":[{"type":"revise-outline"');
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.runtime.invokeSkill;
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
    const originalInvokeSkill = container.runtime.invokeSkill.bind(container.runtime);
    container.runtime.invokeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-coordinator') throw new Error('Dialogue coordinator returned empty operation.blockId.');
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.runtime.invokeSkill;
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
    const originalInvokeSkill = container.runtime.invokeSkill.bind(container.runtime);
    const coordinatorInputs: Array<{ conversation?: Array<{ role: string; content: string }>; conversationBrief?: DialogueBrief }> = [];
    container.runtime.invokeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-coordinator') {
        coordinatorInputs.push(input as { conversation?: Array<{ role: string; content: string }>; conversationBrief?: DialogueBrief });
        return { mode: 'proposal', message: '准备更新大纲。', summary: '修订大纲', operations: [{ type: 'revise-outline', instruction: '补充大闹厨房等关键情节。' }], warnings: [] };
      }
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.runtime.invokeSkill;
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
    await container.stores.artifactStore.updateArticle(article);
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
    await app.close();
  });

  it('fails closed when dialogue brief updates fail instead of extracting requirements locally', async () => {
    const config = testConfig();
    const container = createContainer(config);
    const originalInvokeSkill = container.runtime.invokeSkill.bind(container.runtime);
    container.runtime.invokeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-brief-updater') throw new Error('brief updater unavailable');
      if (skillId === 'dialogue-coordinator') return { mode: 'proposal', message: '准备修改。', summary: '修订任务', operations: [{ type: 'revise-outline', instruction: '补充大闹厨房。' }], warnings: [] };
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.runtime.invokeSkill;
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
    await container.stores.artifactStore.updateArticle(article);

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
    const originalInvokeSkill = container.runtime.invokeSkill.bind(container.runtime);
    container.runtime.invokeSkill = (async (skillId: string, input: unknown, meta: unknown) => {
      if (skillId === 'dialogue-brief-updater') {
        const message = (input as { message: string }).message;
        return { activeRequirements: [{ kind: 'requirement', text: message }], evidenceNotes: [], recentUserIntents: [message], supersededRequirements: [], conflicts: [] };
      }
      if (skillId === 'dialogue-coordinator') {
        coordinatorInputs.push(input as { conversationBrief?: DialogueBrief });
        return { mode: 'proposal', message: '准备修改。', summary: '修订任务', operations: [{ type: 'revise-outline', instruction: '补充收束段。' }], warnings: [] };
      }
      return originalInvokeSkill(skillId as never, input as never, meta as never);
    }) as typeof container.runtime.invokeSkill;
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
    await container.stores.artifactStore.updateArticle(article);
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
    await container.stores.artifactStore.updateArticle(article);
    const response = await app.inject({ method: 'POST', url: '/api/workflows/section/start', payload: { articleId: article.id, sectionId: 'sec-readable-log', userId: 'section-log-user' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const reason = body.article.versions[body.article.versions.length - 1].reason;
    expect(reason).toBe('生成章节正文：可读章节标题');
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
