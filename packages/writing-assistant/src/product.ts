import { ActionCatalog, buildActionCatalog, defineProductModule, loadProductSkillsFromModules, ProductSkillRegistry, registerProductSkillsFromModules } from '@wa/runtime';
import createRevisionProposal from './skills/create-revision-proposal/module';
import createTaskCard from './skills/create-task-card/module';
import dialogueRoute from './skills/dialogue-route/module';
import evaluateQuality from './skills/evaluate-quality/module';
import patchBlock from './skills/patch-block/module';
import planOutline from './skills/plan-outline/module';
import resolveArticleComment from './skills/resolve-article-comment/module';
import reviseTaskCard from './skills/revise-task-card/module';
import updateDialogueBrief from './skills/update-dialogue-brief/module';
import writeSection from './skills/write-section/module';
import { promptInjectionGuardPromptPath } from './shared/prompt-guard';
import writingAutopilot from './workflows/writing-autopilot/module';

export const writingAssistantSkillModules = [
  createRevisionProposal,
  createTaskCard,
  dialogueRoute,
  evaluateQuality,
  patchBlock,
  planOutline,
  resolveArticleComment,
  reviseTaskCard,
  updateDialogueBrief,
  writeSection,
];

export const writingAssistantWorkflowModules = [
  writingAutopilot,
];

export const writingAssistantProduct = defineProductModule({
  id: 'writing-assistant',
  promptPaths: [promptInjectionGuardPromptPath],
  skills: writingAssistantSkillModules,
  workflows: writingAssistantWorkflowModules,
});

export function loadWritingAssistantProductSkills() {
  return loadProductSkillsFromModules(writingAssistantProduct.skills);
}

export function registerWritingAssistantProductSkills(registry = new ProductSkillRegistry()): ProductSkillRegistry {
  return registerProductSkillsFromModules(writingAssistantProduct.skills, registry);
}

export function createWritingAssistantActionCatalog(): ActionCatalog {
  return buildActionCatalog(writingAssistantProduct.skills, loadWritingAssistantProductSkills());
}
