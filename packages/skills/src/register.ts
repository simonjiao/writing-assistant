import { SkillRegistry } from '@wa/core';
import { OutlinePlannerSkill } from './outline-planner';
import { PatchEditorSkill } from './patch-editor';
import { QualityEvaluatorSkill } from './quality-evaluator';
import { SectionWriterSkill } from './section-writer';
import { TaskCardBuilderSkill } from './task-card-builder';

export function registerDefaultSkills(registry: SkillRegistry): SkillRegistry {
  registry.register(new TaskCardBuilderSkill());
  registry.register(new OutlinePlannerSkill());
  registry.register(new SectionWriterSkill());
  registry.register(new PatchEditorSkill());
  registry.register(new QualityEvaluatorSkill());
  return registry;
}
