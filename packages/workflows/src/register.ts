import { PromptProgramRegistry } from './prompt-program';
import { ArticleCommentResolverProgram } from './article-comment-resolver';
import { DialogueBriefUpdaterProgram } from './dialogue-brief-updater';
import { DialogueCoordinatorProgram } from './dialogue-coordinator';
import { DialogueRouterProgram } from './dialogue-router';
import { OutlinePlannerProgram } from './outline-planner';
import { OutlineReviserProgram } from './outline-reviser';
import { OutlineItemReviserProgram } from './outline-item-reviser';
import { PatchEditorProgram } from './patch-editor';
import { QualityEvaluatorProgram } from './quality-evaluator';
import { SectionWriterProgram } from './section-writer';
import { TaskCardBuilderProgram } from './task-card-builder';
import { TaskCardReviserProgram } from './task-card-reviser';

export function registerDefaultPromptPrograms(registry = new PromptProgramRegistry()): PromptProgramRegistry {
  registry.register(new TaskCardBuilderProgram());
  registry.register(new ArticleCommentResolverProgram());
  registry.register(new DialogueRouterProgram());
  registry.register(new DialogueBriefUpdaterProgram());
  registry.register(new DialogueCoordinatorProgram());
  registry.register(new TaskCardReviserProgram());
  registry.register(new OutlinePlannerProgram());
  registry.register(new OutlineItemReviserProgram());
  registry.register(new OutlineReviserProgram());
  registry.register(new SectionWriterProgram());
  registry.register(new PatchEditorProgram());
  registry.register(new QualityEvaluatorProgram());
  return registry;
}
