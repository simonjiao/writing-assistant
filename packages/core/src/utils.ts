import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeJsonParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    const match = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match?.[1]) {
      try {
        return JSON.parse(match[1]) as T;
      } catch {
        return undefined;
      }
    }
    const objectStart = value.indexOf('{');
    const objectEnd = value.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(value.slice(objectStart, objectEnd + 1)) as T;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function assertFound<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

export function truncate(value: unknown, max = 700): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function mergeDeep<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      result[key] = mergeDeep(current as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}
