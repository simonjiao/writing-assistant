import { PromptProgramRegistry } from '@wa/runtime';
import { ArticleCommentResolverProgram } from './skills/resolve-article-comment/programs/article-comment-resolver';
import { DialogueBriefUpdaterProgram } from './skills/update-dialogue-brief/programs/dialogue-brief-updater';
import { DialogueCoordinatorProgram } from './skills/create-revision-proposal/programs/dialogue-coordinator';
import { DialogueRouterProgram } from './skills/dialogue-route/programs/dialogue-router';
import { OutlinePlannerProgram } from './skills/plan-outline/programs/outline-planner';
import { OutlineReviserProgram } from './skills/plan-outline/programs/outline-reviser';
import { OutlineItemReviserProgram } from './skills/plan-outline/programs/outline-item-reviser';
import { PatchEditorProgram } from './skills/patch-block/programs/patch-editor';
import { QualityEvaluatorProgram } from './skills/evaluate-quality/programs/quality-evaluator';
import { SectionWriterProgram } from './skills/write-section/programs/section-writer';
import { TaskCardBuilderProgram } from './skills/create-task-card/programs/task-card-builder';
import { TaskCardReviserProgram } from './skills/revise-task-card/programs/task-card-reviser';

export function registerWritingAssistantPromptPrograms(registry = new PromptProgramRegistry()): PromptProgramRegistry {
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
