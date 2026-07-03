import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeJsonParse<T>(value: string): T | undefined {
  for (const candidate of jsonCandidates(value)) {
    const parsed = parseJsonCandidate<T>(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function jsonCandidates(value: string): string[] {
  const candidates = [value];
  const match = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match?.[1]) candidates.push(match[1]);
  const objectStart = value.indexOf('{');
  const objectEnd = value.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(value.slice(objectStart, objectEnd + 1));
  return [...new Set(candidates)];
}

function parseJsonCandidate<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    const repaired = escapeUnescapedStringQuotes(value);
    if (repaired === value) return undefined;
    try {
      return JSON.parse(repaired) as T;
    } catch {
      return undefined;
    }
  }
}

function escapeUnescapedStringQuotes(value: string): string {
  let repaired = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!inString) {
      if (char === '"') inString = true;
      repaired += char;
      continue;
    }
    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      repaired += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      const next = nextNonWhitespace(value, index + 1);
      if (next === undefined || next === ':' || next === ',' || next === '}' || next === ']') {
        inString = false;
        repaired += char;
      } else {
        repaired += '\\"';
        changed = true;
      }
      continue;
    }
    repaired += char;
  }
  return changed ? repaired : value;
}

function nextNonWhitespace(value: string, start: number): string | undefined {
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (!/\s/.test(char)) return char;
  }
  return undefined;
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
