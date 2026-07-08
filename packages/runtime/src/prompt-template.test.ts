import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPromptTemplate } from './prompt-template';

describe('prompt templates', () => {
  it('loads and trims prompt text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wa-prompt-template-'));
    try {
      const file = join(dir, 'prompt.md');
      await writeFile(file, '\n  prompt text  \n');
      expect(loadPromptTemplate(file)).toBe('prompt text');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing prompt files', () => {
    expect(() => loadPromptTemplate('/tmp/writing-assistant-missing-prompt.md')).toThrow('Prompt template not found');
  });

  it('rejects empty prompt files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wa-prompt-template-empty-'));
    try {
      const file = join(dir, 'prompt.md');
      await writeFile(file, '\n\n');
      expect(() => loadPromptTemplate(file)).toThrow('Prompt template is empty');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
