import { expect, test, type Page } from '@playwright/test';

const apiBase = process.env.WA_API_URL ?? 'http://127.0.0.1:8787';
const webBase = process.env.WA_WEB_URL ?? 'http://127.0.0.1:5173';

test.beforeEach(async ({ page }) => {
  await assertLocalRuntime();
  const userId = `browser-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await page.addInitScript((id) => {
    window.localStorage.setItem('writing-assistant.user-id', id);
    window.localStorage.removeItem('writing-assistant.navigation-collapsed');
    window.localStorage.removeItem('writing-assistant.support-column-collapsed');
  }, userId);
});

test('creates a task, writes sections, and processes an article comment', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Writing Assistant')).toBeVisible();

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
