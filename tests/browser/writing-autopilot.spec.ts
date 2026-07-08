import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const apiBase = process.env.WA_API_URL ?? 'http://127.0.0.1:8787';
const webBase = process.env.WA_WEB_URL ?? 'http://127.0.0.1:5173';
const dataDir = process.env.WA_DATA_DIR ?? process.env.DATA_DIR ?? '.data';

test.beforeEach(async ({ page }) => {
  await assertLocalRuntime();
});

test('creates a task, writes sections, and processes an article comment', async ({ page }) => {
  await openAppForUser(page, uniqueUserId('browser-smoke'));

  await page.getByTestId('task-dialog-input').fill('写一篇关于司棋的短文，约1200字，避免现代论文腔。');
  await page.getByTestId('task-dialog-send').click();
  await expect(page.getByRole('heading', { name: '任务卡草稿' })).toBeVisible({ timeout: 60_000 });

  await page.getByTestId('confirm-task-card-button').click();
  await expect(page.getByTestId('generate-outline-button')).toBeEnabled();

  await page.getByTestId('generate-outline-button').click();
  await expect(page.getByTestId('outline-list')).toBeVisible();

  await page.getByTestId('start-writing-button').click();
  await expect(page.getByTestId('article-block').first()).toBeVisible({ timeout: 120_000 });

  await createCommentFromFirstBlock(page);
  await expect(page.getByTestId('comment-review-card')).toContainText('1 条待处理');

  await page.getByTestId('process-comments-button').click();
  await expect(page.getByTestId('comment-review-card')).toContainText(/已处理|需要追问/, { timeout: 60_000 });
});

test('shows a workflow HumanGate and resolves it from the support card', async ({ page }) => {
  await openAppForUser(page, uniqueUserId('browser-gate'));

  await page.getByTestId('task-dialog-input').fill('写一篇关于司棋的短文，先生成任务卡。');
  await page.getByTestId('task-dialog-send').click();
  await expect(page.getByRole('heading', { name: '任务卡草稿' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('workflow-support-card')).toContainText('等待确认');
  await expect(page.getByTestId('workflow-gate')).toContainText(/希望文章|篇幅|确认/);

  await page.getByTestId('workflow-gate-accept').click();
  await expect(page.getByTestId('generate-outline-button')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('workflow-next-step')).toContainText('流程已完成');
});

test('rejects a workflow HumanGate without confirming the task card', async ({ page }) => {
  await openAppForUser(page, uniqueUserId('browser-gate-reject'));

  await page.getByTestId('task-dialog-input').fill('写一篇关于司棋的短文，先生成任务卡。');
  await page.getByTestId('task-dialog-send').click();
  await expect(page.getByRole('heading', { name: '任务卡草稿' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('workflow-support-card')).toContainText('等待确认');

  await page.getByTestId('workflow-gate-reject').click();
  await expect(page.getByTestId('workflow-next-step')).toContainText('等待确认');
  await expect(page.getByText('用户拒绝了当前确认项，需要新的指令。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '任务卡草稿' })).toBeVisible();
  await expect(page.getByTestId('generate-outline-button')).toHaveCount(0);
});

test('cancels a waiting workflow and hides stale HumanGates', async ({ page }) => {
  await openAppForUser(page, uniqueUserId('browser-workflow-cancel'));

  await page.getByTestId('task-dialog-input').fill('写一篇关于司棋的短文，先生成任务卡。');
  await page.getByTestId('task-dialog-send').click();
  await expect(page.getByRole('heading', { name: '任务卡草稿' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('workflow-gate')).toBeVisible();

  await page.getByTestId('workflow-cancel').click();
  await expect(page.getByTestId('workflow-next-step')).toContainText('已取消');
  await expect(page.getByTestId('workflow-gate')).toHaveCount(0);
  await expect(page.getByTestId('workflow-cancel')).toHaveCount(0);
});

test('supersedes a stale HumanGate when the article revision changes', async ({ page }) => {
  const userId = uniqueUserId('browser-gate-stale');
  await openAppForUser(page, userId);

  await page.getByTestId('task-dialog-input').fill('写一篇关于司棋的短文，先生成任务卡。');
  await page.getByTestId('task-dialog-send').click();
  await expect(page.getByRole('heading', { name: '任务卡草稿' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('workflow-gate')).toBeVisible();

  const article = findArticleByUserId(userId);
  markArticleRevisionStale(article.id);
  await page.getByTestId('workflow-gate-accept').click();

  await expect(page.getByTestId('workflow-next-step')).toContainText('确认项已过期', { timeout: 60_000 });
  await expect(page.getByTestId('workflow-gate')).toHaveCount(0);
  await expect(page.getByTestId('generate-outline-button')).toHaveCount(0);
});

test('shows a failed workflow when tool execution rejects invalid article data', async ({ page }) => {
  const userId = uniqueUserId('browser-workflow-failed');
  await createWorkflowFailureFixture(userId);
  await openAppForUser(page, userId);

  await expect(page.getByTestId('outline-list')).toBeVisible();

  await page.getByTestId('start-writing-button').click();

  await expect(page.getByText(/生成内容包含任务卡中需要避免的词语/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('workflow-support-card')).toContainText('失败');
  await expect(page.getByTestId('workflow-next-step')).toContainText('需要处理失败');
  await expect(page.getByTestId('workflow-cancel')).toHaveCount(0);
});

test('shows a polish proposal in the browser and applies it only after confirmation', async ({ page }) => {
  const userId = uniqueUserId('browser-polish');
  const fixture = await createPolishFixture(userId);
  await openAppForUser(page, userId);

  await page.getByTestId('history-item').filter({ hasText: fixture.title }).click();
  await expect(page.getByTestId('article-block-text').first()).toContainText(fixture.originalText);

  await page.getByTestId('start-writing-button').click();
  await expect(page.getByTestId('workflow-support-card')).toContainText('等待确认', { timeout: 60_000 });
  await expect(page.getByTestId('workflow-review-list')).toContainText('需要修订');
  await expect(page.getByTestId('dialogue-proposal')).toContainText('修订建议');
  await expect(page.getByTestId('article-block-text').first()).not.toContainText('修改说明');

  await page.getByTestId('dialogue-proposal-apply').click();
  await expect(page.getByTestId('article-block-text').first()).toContainText('修改说明', { timeout: 60_000 });
  await expect(page.getByTestId('workflow-next-step')).toContainText('流程已完成');
});

test('dismisses a polish proposal without mutating article text', async ({ page }) => {
  const userId = uniqueUserId('browser-polish-dismiss');
  const fixture = await createPolishFixture(userId);
  await openAppForUser(page, userId);

  await page.getByTestId('history-item').filter({ hasText: fixture.title }).click();
  await expect(page.getByTestId('article-block-text').first()).toContainText(fixture.originalText);

  await page.getByTestId('start-writing-button').click();
  await expect(page.getByTestId('dialogue-proposal')).toContainText('修订建议', { timeout: 60_000 });

  await page.getByTestId('dialogue-proposal-dismiss').click();
  await expect(page.getByTestId('dialogue-proposal')).toHaveCount(0);
  await expect(page.getByText('已取消这次修改提案。')).toBeVisible();
  await expect(page.getByTestId('article-block-text').first()).toContainText(fixture.originalText);
  await expect(page.getByTestId('article-block-text').first()).not.toContainText('修改说明');
});

test('keeps a stale polish proposal from mutating article text', async ({ page }) => {
  const userId = uniqueUserId('browser-polish-stale');
  const fixture = await createPolishFixture(userId);
  await openAppForUser(page, userId);

  await page.getByTestId('history-item').filter({ hasText: fixture.title }).click();
  await expect(page.getByTestId('article-block-text').first()).toContainText(fixture.originalText);

  await page.getByTestId('start-writing-button').click();
  await expect(page.getByTestId('dialogue-proposal')).toContainText('修订建议', { timeout: 60_000 });
  markArticleRevisionStale(fixture.articleId);

  await page.getByTestId('dialogue-proposal-apply').click();
  await expect(page.getByText(/Revision proposal is stale/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('article-block-text').first()).toContainText(fixture.originalText);
  await expect(page.getByTestId('article-block-text').first()).not.toContainText('修改说明');
});

async function assertLocalRuntime() {
  await assertReachable(`${apiBase}/health`, 'API');
  await assertReachable(webBase, 'Web');
}

async function assertReachable(url: string, label: string) {
  const deadline = Date.now() + 15_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} is not reachable at ${url}: ${lastError}. Run npm run local:restart before npm run test:browser.`);
}

async function createCommentFromFirstBlock(page: Page) {
  const blockText = page.getByTestId('article-block-text').first();
  await expect(blockText).toBeVisible();
  await blockText.evaluate((node) => {
    const textNode = Array.from(node.childNodes).find((child) => child.nodeType === Node.TEXT_NODE);
    if (!textNode?.textContent) throw new Error('Article block has no text node.');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(12, textNode.textContent.length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByTestId('comment-input').fill('这句需要更清楚，避免突兀。');
  await page.getByTestId('add-comment-button').click();
}

function uniqueUserId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function openAppForUser(page: Page, userId: string) {
  await page.addInitScript((id) => {
    window.localStorage.setItem('writing-assistant.user-id', id);
    window.localStorage.removeItem('writing-assistant.navigation-collapsed');
    window.localStorage.removeItem('writing-assistant.support-column-collapsed');
  }, userId);
  await page.goto('/');
  await expect(page.getByText('Writing Assistant')).toBeVisible();
}

async function createPolishFixture(userId: string): Promise<{ articleId: string; title: string; originalText: string }> {
  const session = await requestJson<{ currentWorkspaceId?: string }>('/api/sessions', { method: 'POST', body: JSON.stringify({ userId }) });
  const workspaceId = session.currentWorkspaceId;
  if (!workspaceId) throw new Error('Fixture session did not create a default workspace.');
  const now = new Date().toISOString();
  const title = '浏览器统稿测试';
  const articleId = `art_${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const originalText = '这是一段已经生成但需要统稿修订的正文。';
  const article = {
    id: articleId,
    userId,
    workspaceId,
    revision: 1,
    title,
    taskCard: confirmedFixtureTaskCard(`task_${articleId}`, title, now),
    outline: [{
      id: `sec_${articleId}`,
      title: '已有正文',
      goal: '已有正文但需要统稿。',
      order: 1,
      expectedBlocks: 1,
      sourceHints: [],
      themeTags: ['统稿'],
      status: 'written',
    }],
    blocks: [{
      id: `blk_${articleId}`,
      type: 'paragraph',
      sectionId: `sec_${articleId}`,
      title: '已有正文',
      text: originalText,
      sourceRefs: [],
      themeTags: ['统稿'],
      status: 'needs_revision',
      createdAt: now,
      updatedAt: now,
    }],
    citations: [],
    themeTags: [],
    comments: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
  upsertJsonRecord('artifacts', articleId, article);
  return { articleId, title, originalText };
}

async function createWorkflowFailureFixture(userId: string): Promise<{ articleId: string; title: string }> {
  const session = await requestJson<{ currentWorkspaceId?: string }>('/api/sessions', { method: 'POST', body: JSON.stringify({ userId }) });
  const workspaceId = session.currentWorkspaceId;
  if (!workspaceId) throw new Error('Fixture session did not create a default workspace.');
  const now = new Date().toISOString();
  const title = '浏览器失败流程测试';
  const articleId = `art_${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const taskCard = confirmedFixtureTaskCard(`task_${articleId}`, title, now);
  taskCard.constraints.mustAvoid = ['本节正文'];
  const article = {
    id: articleId,
    userId,
    workspaceId,
    revision: 1,
    title,
    taskCard,
    outline: [{
      id: `sec_${articleId}`,
      title: '触发保存校验的大纲',
      goal: '用于验证 workflow failed 的页面表现。',
      order: 1,
      expectedBlocks: 1,
      sourceHints: [],
      themeTags: ['失败流程'],
      status: 'draft',
    }],
    blocks: [],
    citations: [],
    themeTags: [],
    comments: [],
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
  upsertJsonRecord('artifacts', articleId, article);
  return { articleId, title };
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function upsertJsonRecord(namespace: string, id: string, record: Record<string, unknown>) {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => { prepare(sql: string): { get(...args: unknown[]): unknown; run(...args: unknown[]): void }; close(): void } };
  const db = new DatabaseSync(join(dataDir, 'writing-assistant.sqlite'));
  try {
    db.prepare('INSERT INTO json_records(namespace, id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(namespace, id, JSON.stringify(record), new Date().toISOString());
  } finally {
    db.close();
  }
}

function markArticleRevisionStale(articleId: string) {
  const article = readJsonRecord('artifacts', articleId);
  const revision = typeof article.revision === 'number' ? article.revision : 1;
  upsertJsonRecord('artifacts', articleId, { ...article, revision: revision + 1, updatedAt: new Date().toISOString() });
}

function findArticleByUserId(userId: string): { id: string } {
  const articles = listJsonRecords('artifacts')
    .filter((article) => article.userId === userId && !article.deletedAt)
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
  const article = articles[0];
  if (!article || typeof article.id !== 'string') throw new Error(`Article not found for user ${userId}`);
  return { id: article.id };
}

function readJsonRecord(namespace: string, id: string): Record<string, unknown> {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void } };
  const db = new DatabaseSync(join(dataDir, 'writing-assistant.sqlite'));
  try {
    const row = db.prepare('SELECT json FROM json_records WHERE namespace = ? AND id = ?').get(namespace, id) as { json?: string } | undefined;
    if (!row?.json) throw new Error(`JSON record not found: ${namespace}/${id}`);
    return JSON.parse(row.json) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function listJsonRecords(namespace: string): Record<string, unknown>[] {
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => { prepare(sql: string): { all(...args: unknown[]): unknown[] }; close(): void } };
  const db = new DatabaseSync(join(dataDir, 'writing-assistant.sqlite'));
  try {
    const rows = db.prepare('SELECT json FROM json_records WHERE namespace = ?').all(namespace) as { json?: string }[];
    return rows.map((row) => row.json ? JSON.parse(row.json) as Record<string, unknown> : undefined).filter((row): row is Record<string, unknown> => Boolean(row));
  } finally {
    db.close();
  }
}

function confirmedFixtureTaskCard(id: string, topic: string, now: string) {
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
  };
}
