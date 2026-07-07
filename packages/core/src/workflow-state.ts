import { createHash } from 'node:crypto';
import { ArticleArtifact, JsonValue } from './types';

export class ArticleRevisionConflictError extends Error {
  readonly code = 'ARTICLE_REVISION_CONFLICT';

  constructor(readonly expectedRevision: number, readonly actualRevision: number, readonly operationId: string) {
    super(`Article revision conflict for ${operationId}: expected ${expectedRevision}, got ${actualRevision}.`);
  }
}

export function assertArticleBaseRevision(article: ArticleArtifact, baseRevision: number, operationId: string): void {
  if (article.revision !== baseRevision) {
    throw new ArticleRevisionConflictError(baseRevision, article.revision, operationId);
  }
}

export function hashOperationArgs(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForStableStringify(value));
}

function normalizeForStableStringify(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizeForStableStringify);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForStableStringify(item)]),
    );
  }
  return String(value);
}
