import { describe, expect, it } from 'vitest';
import { PromptProgramRegistry, ToolRegistry } from '@wa/runtime';
import { createWritingAssistantActionCatalog, loadWritingAssistantProductSkills, registerWritingAssistantProductSkills, writingAssistantProduct } from './product';
import { registerWritingAssistantPromptPrograms } from './register';
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
});
