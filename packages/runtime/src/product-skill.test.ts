import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadProductSkillsFromDirectory, parseProductSkillMarkdown } from '@wa/runtime';
import { ToolRegistry } from '@wa/runtime';

const validSkill = `---
id: create-task-card
title: 创建任务卡
version: 1
tools:
  - create_task_intake
actions:
  create_task_intake: 保存任务。
---

## Goal
保存并整理任务卡。

## When To Use
- 新建任务时使用。

## Inputs
- 必须有用户输入。

## Process
- 先保存任务。

## RAG Policy
- 默认不检索。

## Human Gate Policy
- 草稿生成后等待确认。

## Completion Criteria
- 任务已保存。

## Failure Policy
- 失败时保留已保存输入。

## Prompt Rules
- 不输出内部字段。
`;

describe('product skills', () => {
  it('parses Markdown product skills as strict runtime specs', () => {
    const createTaskCard = parseProductSkillMarkdown(validSkill, 'inline.md');
    expect(createTaskCard).toMatchObject({
      title: '创建任务卡',
      version: 1,
      toolBindings: ['create_task_intake'],
    });
    expect(createTaskCard.actionHints.create_task_intake).toContain('保存任务');
  });

  it('rejects unknown frontmatter fields', () => {
    expect(() => parseProductSkillMarkdown(validSkill.replace('tools:', 'owner: product\ntools:'), 'bad.md')).toThrow('Unknown frontmatter field');
  });

  it('rejects unknown body sections', () => {
    expect(() => parseProductSkillMarkdown(`${validSkill}\n## Extra\n- 不允许。`, 'bad.md')).toThrow('Unknown product skill section');
  });

  it('rejects missing skill directories', () => {
    expect(() => loadProductSkillsFromDirectory('/tmp/writing-assistant-missing-product-skills')).toThrow('Product skill directory not found');
  });

  it('loads skills from an explicit directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wa-product-skill-'));
    try {
      await writeFile(join(dir, 'create-task-card.md'), validSkill);
      const skills = loadProductSkillsFromDirectory(dir);
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('create-task-card');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects tools that are not listed in their product skill', () => {
    const skill = parseProductSkillMarkdown(validSkill, 'inline.md');
    const registry = new ToolRegistry();
    expect(() => registry.register({
      id: 'refine_task_card',
      skill,
      workflowIds: ['writing-autopilot'],
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      mutatesArtifact: false,
      requiresRevision: false,
      requiresHumanGate: false,
      async execute() {
        return undefined;
      },
    })).toThrow('is not listed in skill');
  });
});
