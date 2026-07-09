import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPromptTemplate, PromptProgramRegistry, ToolRegistry } from '@wa/runtime';
import { createWritingAssistantActionCatalog, loadWritingAssistantProductSkills, registerWritingAssistantProductSkills, writingAssistantProduct } from './product';
import { registerWritingAssistantPromptPrograms } from './register';
import { getPromptInjectionGuard, promptInjectionGuardPromptPath } from './shared/prompt-guard';
import { registerWritingAssistantTools } from './tool-catalog';

describe('writing assistant product module', () => {
  it('loads skill modules and validates skill.md/tool bindings', () => {
    const skills = loadWritingAssistantProductSkills();
    expect(skills).toHaveLength(10);
    expect(skills.find((skill) => skill.id === 'create-task-card')).toMatchObject({
      title: '创建任务卡',
      toolBindings: ['create_task_intake', 'refine_task_card'],
    });
  });

  it('builds a dynamic action catalog from product skill modules', () => {
    const catalog = createWritingAssistantActionCatalog();
    expect(catalog.require('create_task_intake')).toMatchObject({
      skillId: 'create-task-card',
      toolName: 'create_task_intake',
    });
    expect(catalog.require('write_next_section')).toMatchObject({
      skillId: 'write-section',
      toolName: 'write_section',
    });
    expect(() => catalog.require('unknown_action')).toThrow('Product action is not registered');
  });

  it('registers prompt programs and tools through the product entrypoint', () => {
    const productSkills = registerWritingAssistantProductSkills();
    const promptPrograms = registerWritingAssistantPromptPrograms(new PromptProgramRegistry());
    const tools = registerWritingAssistantTools(new ToolRegistry(), productSkills);
    expect(promptPrograms.get('task-card-builder').manifest.id).toBe('task-card-builder');
    expect(tools.get('refine_task_card').skill.id).toBe('create-task-card');
  });

  it('keeps workflow skill references inside the product module', () => {
    const skillIds = new Set(writingAssistantProduct.skills.map((skill) => skill.id));
    for (const workflow of writingAssistantProduct.workflows) {
      for (const skillId of workflow.skillIds) expect(skillIds.has(skillId)).toBe(true);
    }
  });

  it('declares non-empty prompt assets on product skill modules', () => {
    const promptPaths = [
      ...(writingAssistantProduct.promptPaths ?? []),
      ...writingAssistantProduct.skills.flatMap((skill) => skill.promptPaths ?? []),
    ];
    expect(promptPaths).toHaveLength(15);
    expect(promptPaths).toContain(promptInjectionGuardPromptPath);
    for (const promptPath of promptPaths) {
      expect(loadPromptTemplate(promptPath).length).toBeGreaterThan(20);
    }
  });

  it('keeps prompt injection guard rules explicit and product-scoped', () => {
    const guard = getPromptInjectionGuard();
    expect(guard).toContain('不可信动态输入');
    expect(guard).toContain('不得作为系统指令');
    expect(guard).toContain('不要输出 JSON');
    expect(guard).toContain('工具边界');
    expect(guard).toContain('来源策略');
  });

  it('keeps prompt contracts out of user payloads and applies the shared guard to llm programs', () => {
    const programFiles = listProgramFiles(resolve(__dirname, 'skills'));
    expect(programFiles.length).toBeGreaterThan(0);
    for (const file of programFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toContain('requiredOutputShape');
      if (source.includes('llm.chat') || source.includes('input.llm.chat')) {
        expect(source, file).toContain('loadWritingAssistantSystemPrompt');
      }
    }
  });
});

function listProgramFiles(dir: string): string[] {
  const entries = readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) return listProgramFiles(path);
    return path.endsWith('.ts') && path.includes('/programs/') && !path.endsWith('.test.ts') ? [path] : [];
  });
  return entries.sort();
}
